import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { getDownloadURL, getStorage } from 'firebase-admin/storage';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { computeItems, filterItems } from '../../app/src/render/domain';
import { includesSession } from '../../app/src/render/pack-selection';
import { renderRunsheet, type RenderPayload } from '../../app/src/render/renderer';
import type { Category, Item, Person, StoredImage, Template } from '../../app/src/types';
import type { PublicRunsheet, RunsheetLink } from '../../app/src/types/public-runsheet';

function scope(data: Record<string, unknown>) {
  const ids = ['tenantId', 'eventId', 'personId'] as const;
  for (const key of ids)
    if (typeof data[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data[key]))
      throw new HttpsError('invalid-argument', `Invalid ${key}.`);
  const { tenantId, eventId, personId } = data as Pick<RunsheetLink, (typeof ids)[number]>;
  const db = getFirestore();
  const tenant = db.doc(`tenants/${tenantId}`);
  const event = tenant.collection('events').doc(eventId);
  return {
    tenantId,
    eventId,
    personId,
    tenant,
    event,
    person: event.collection('people').doc(personId),
    link: event.collection('runsheetLinks').doc(personId),
  };
}

export async function createRunsheetLink(request: CallableRequest): Promise<RunsheetLink> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to share a runsheet.');
  const s = scope(request.data ?? {});
  const member = await s.tenant.collection('members').doc(request.auth.uid).get();
  if (!['owner', 'editor'].includes(member.data()?.role))
    throw new HttpsError('permission-denied', 'Editor access is required to share a runsheet.');
  // Keep the token separate from person documents, which editors can otherwise overwrite.
  const token = await getFirestore().runTransaction(async (tx) => {
    const [tenant, event, person, link] = await Promise.all([
      tx.get(s.tenant),
      tx.get(s.event),
      tx.get(s.person),
      tx.get(s.link),
    ]);
    if (!tenant.exists || !event.exists || !person.exists)
      throw new HttpsError('not-found', 'This person or event no longer exists.');
    if (link.exists) return link.data()!.token as string;
    const token = randomBytes(24).toString('hex');
    tx.create(s.link, { token, createdBy: request.auth!.uid, createdAt: new Date() });
    return token;
  });
  return { tenantId: s.tenantId, eventId: s.eventId, personId: s.personId, token };
}

export async function getPublicRunsheet(request: CallableRequest): Promise<PublicRunsheet> {
  const data = request.data ?? {};
  const s = scope(data);
  if (typeof data.token !== 'string' || !/^[a-f0-9]{48}$/.test(data.token))
    throw new HttpsError('not-found', 'This runsheet link is unavailable.');
  const link = await s.link.get();
  const expected = link.data()?.token;
  if (
    typeof expected !== 'string' ||
    expected.length !== data.token.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(data.token))
  )
    throw new HttpsError('not-found', 'This runsheet link is unavailable.');

  const [tenant, event, personDoc, sessionDocs] = await Promise.all([
    s.tenant.get(),
    s.event.get(),
    s.person.get(),
    s.event.collection('sessions').orderBy('sortKey').get(),
  ]);
  if (!tenant.exists || !event.exists || !personDoc.exists)
    throw new HttpsError('not-found', 'This runsheet link is unavailable.');
  const person = { ...personDoc.data(), id: personDoc.id } as Person;
  const sessions = sessionDocs.docs.filter((d) => includesSession(person.pack, d.id));
  const session =
    data.sessionId === undefined ? sessions[0] : sessions.find((d) => d.id === data.sessionId);
  if (data.sessionId !== undefined && !session)
    throw new HttpsError('not-found', 'This session is no longer included in the shared pack.');
  const result: PublicRunsheet = {
    eventName: event.data()!.name,
    timeZone: event.data()!.timeZone,
    person: { name: person.name, ...(person.role ? { role: person.role } : {}) },
    sessions: sessions.map((d) => ({
      id: d.id,
      name: d.data().name,
      startAt: d.data().startAt.toDate().toISOString(),
    })),
    sessionId: session?.id ?? null,
    views: [],
  };
  if (!session) return result;

  const db = getFirestore();
  const templateIds = [...new Set(person.pack.templates.map((t) => t.templateId))];
  const [itemDocs, categoryDocs, peopleDocs, templateDocs] = await Promise.all([
    session.ref.collection('items').orderBy('order').limit(501).get(),
    s.tenant.collection('categories').get(),
    s.event.collection('people').get(),
    templateIds.length
      ? db.getAll(...templateIds.map((id) => s.tenant.collection('templates').doc(id)))
      : [],
  ]);
  if (itemDocs.size > 500)
    throw new HttpsError('resource-exhausted', 'A shared session supports up to 500 items.');
  const items = computeItems(
    itemDocs.docs.map((d) => ({ ...d.data(), id: d.id }) as Item),
    categoryDocs.docs.map((d) => ({ ...d.data(), id: d.id }) as Category),
    peopleDocs.docs.map((d) => ({ ...d.data(), id: d.id }) as Person),
  );
  const templates = templateDocs
    .filter((d) => d.exists)
    .map((d) => ({ ...d.data(), id: d.id }) as Template);
  const imageCache = new Map<string, Promise<string | undefined>>();
  const imageUrl = (image: StoredImage): Promise<string | undefined> => {
    if (image.path.startsWith('seed/')) return Promise.resolve(undefined);
    if (!image.path.startsWith(`tenants/${s.tenantId}/`))
      throw new HttpsError('permission-denied', 'An image belongs to a different organisation.');
    if (!imageCache.has(image.path))
      imageCache.set(
        image.path,
        (async () => {
          const file = getStorage().bucket().file(image.path);
          const [exists] = await file.exists();
          if (!exists) return undefined;
          const [meta] = await file.getMetadata();
          if (
            !['image/png', 'image/jpeg'].includes(meta.contentType ?? '') ||
            Number(meta.size) > 10 * 1024 * 1024
          )
            return undefined;
          return getDownloadURL(file);
        })(),
      );
    return imageCache.get(image.path)!;
  };
  for (const template of templates) {
    const p: RenderPayload = {
      tenant: { name: tenant.data()!.name },
      event: { name: result.eventName, timeZone: result.timeZone },
      session: {
        name: session.data().name,
        startAt: session.data().startAt.toDate().toISOString(),
      },
      recipient: { id: person.id, name: person.name, role: person.role },
      items,
      template,
    };
    if (template.columns.some((c) => c.key === 'imageSlide' && c.visible))
      await Promise.all(
        filterItems(items, template, person.id)
          .filter((i) => !i.context)
          .map(async (item) => {
            if (item.imageSlide) item.imageSlide.url = await imageUrl(item.imageSlide);
          }),
      );
    // Only rendered visible content crosses the public boundary, never raw records or emails.
    result.views.push({ id: template.id, name: template.name, html: renderRunsheet(p) });
  }
  return result;
}
