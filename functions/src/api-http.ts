import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, type Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { imageSize } from 'image-size';
import { z } from 'zod';
import { operations, openApiDocument, id, imageSchema } from './api-contract';
import { RundownService, authorize, fail, validateImagePath } from './api-service';
import { exportPacks } from './export';

const statuses: Record<string, number> = {
  'invalid-argument': 400,
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  'failed-precondition': 409,
  aborted: 409,
  'resource-exhausted': 429,
  'deadline-exceeded': 504,
  unavailable: 503,
};
export function apiError(error: unknown) {
  if (error instanceof z.ZodError)
    return {
      status: 400,
      error: {
        code: 'invalid-argument',
        message: 'Invalid request.',
        issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    };
  if (error instanceof HttpsError)
    return {
      status: statuses[error.code] ?? 500,
      error: { code: error.code, message: error.message },
    };
  return {
    status: 500,
    error: { code: 'internal', message: 'Request failed. Check the function logs.' },
  };
}
export function assetTarget(a: {
  tenantId: string;
  eventId?: string;
  sessionId?: string;
  itemId?: string;
}) {
  if (Boolean(a.sessionId) !== Boolean(a.itemId) || (a.sessionId && !a.eventId))
    fail('invalid-argument', 'An item slide needs eventId, sessionId and itemId.');
  const root = `tenants/${a.tenantId}`;
  const path = a.itemId
    ? `${root}/events/${a.eventId}/sessions/${a.sessionId}/items/${a.itemId}`
    : a.eventId
      ? `${root}/events/${a.eventId}`
      : root;
  return {
    path,
    prefix: a.itemId ? path : `${path}/logo`,
    resource: a.itemId ? 'items' : a.eventId ? 'events' : 'tenants',
    field: a.itemId ? 'imageSlide' : 'logo',
    id: a.itemId ?? a.eventId ?? a.tenantId,
  };
}
export function decodeImage(base64: string, contentType: string) {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    fail('invalid-argument', 'Invalid base64 image.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) fail('invalid-argument', 'Invalid base64 image.');
  if (bytes.length > 10 * 1024 * 1024) fail('invalid-argument', 'Images must be at most 10 MiB.');
  try {
    const dimensions = imageSize(bytes);
    if ((contentType === 'image/png' ? 'png' : 'jpg') !== dimensions.type)
      fail('invalid-argument', 'Image bytes do not match contentType.');
    return { bytes, width: dimensions.width, height: dimensions.height };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    fail('invalid-argument', 'Cannot read this PNG/JPEG image.');
  }
}
async function assetOperation(
  operation: string,
  a: Record<string, unknown>,
  user: DecodedIdToken,
  service: RundownService,
) {
  const args = a as {
    tenantId: string;
    eventId?: string;
    sessionId?: string;
    itemId?: string;
    base64: string;
    name: string;
    contentType: string;
  };
  const target = assetTarget(args);
  // Tenant settings follow the owner-only Firestore rule; event/item assets require editor.
  await authorize(
    getFirestore(),
    user.uid,
    args.tenantId,
    target.resource === 'tenants' ? 'owner' : 'edit',
  );
  const scope =
    target.resource === 'tenants'
      ? {}
      : target.resource === 'events'
        ? { tenantId: args.tenantId }
        : { tenantId: args.tenantId, eventId: args.eventId, sessionId: args.sessionId };
  await service.execute(`${target.resource}_get`, { ...scope, id: target.id }, user);
  if (operation === 'assets_remove')
    return service.execute(
      `${target.resource}_update`,
      { ...scope, id: target.id, data: { [target.field]: null } },
      user,
    );
  const { bytes, width, height } = decodeImage(args.base64, args.contentType);
  const path = `${target.prefix}/${randomUUID()}.${args.contentType === 'image/png' ? 'png' : 'jpg'}`;
  const image = imageSchema.parse({
    path,
    name: args.name,
    width,
    height,
    contentType: args.contentType,
  });
  const file = getStorage().bucket().file(path);
  await file.save(bytes, {
    contentType: args.contentType,
    metadata: {
      cacheControl: 'private, max-age=300',
      metadata: { firebaseStorageDownloadTokens: randomUUID() },
    },
  });
  try {
    await service.execute(
      `${target.resource}_update`,
      { ...scope, id: target.id, data: { [target.field]: image } },
      user,
    );
  } catch (error) {
    await file.delete().catch(() => {});
    throw error;
  }
  return image;
}
export async function apiHandler(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  const path = req.path.replace(/^\/api(?=\/)/, '');
  if (req.method === 'GET' && path === '/v1/openapi.json') {
    res.json(openApiDocument());
    return;
  }
  try {
    const bearer = /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '');
    if (!bearer)
      fail('unauthenticated', 'Supply a Firebase ID token as Authorization: Bearer <token>.');
    const user = await getAuth()
      .verifyIdToken(bearer[1], true)
      .catch(() => fail('unauthenticated', 'Token expired, revoked or invalid. Sign in again.'));
    if (path === '/v1/files' && req.method === 'GET') {
      const args = z
        .strictObject({ tenantId: id, path: z.string().min(1).max(1024) })
        .parse(req.query);
      await authorize(getFirestore(), user.uid, args.tenantId, 'read');
      if (!args.path.startsWith(`tenants/${args.tenantId}/exports/`))
        validateImagePath(args.path, args.tenantId);
      if (args.path.split('/').some((s) => s === '..' || s === '.'))
        fail('invalid-argument', 'Invalid file path.');
      const file = getStorage().bucket().file(args.path);
      if (!(await file.exists())[0]) fail('not-found', 'File not found.');
      const [meta] = await file.getMetadata();
      res.type(
        ['application/pdf', 'image/png', 'image/jpeg'].includes(meta.contentType ?? '')
          ? meta.contentType!
          : 'application/octet-stream',
      );
      res.set('Content-Disposition', 'attachment');
      await pipeline(file.createReadStream(), res);
      return;
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      res
        .status(405)
        .json({ error: { code: 'method-not-allowed', message: 'Use POST with a JSON body.' } });
      return;
    }
    const match = /^\/v1\/([a-z_]+)$/.exec(path);
    const operation = match?.[1];
    if (!operation || !Object.hasOwn(operations, operation))
      fail('not-found', 'Unknown API operation. See /api/v1/openapi.json.');
    if (!req.is('application/json')) {
      res
        .status(415)
        .json({
          error: { code: 'invalid-argument', message: 'Use Content-Type: application/json.' },
        });
      return;
    }
    if (req.rawBody.length > 14 * 1024 * 1024) fail('invalid-argument', 'Request exceeds 14 MiB.');
    const args = operations[operation].schema.parse(req.body) as Record<string, unknown>;
    const service = new RundownService(getFirestore(), getAuth());
    let data: unknown;
    if (operation.startsWith('assets_'))
      data = await assetOperation(operation, args, user, service);
    else if (operation === 'exports_render') {
      const jobId = randomUUID();
      data = { ...(await exportPacks(user.uid, { ...args, jobId }, !args.personId)), jobId };
    } else data = await service.execute(operation, args, user);
    res.json({ data });
  } catch (error) {
    const formatted = apiError(error);
    if (formatted.status === 500) console.error('Rundown API failed', error);
    if (!res.headersSent) res.status(formatted.status).json({ error: formatted.error });
    else res.end();
  }
}
