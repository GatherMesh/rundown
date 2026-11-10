import { createHash } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { id } from './api-contract';
import { authorize } from './api-service';
import { createRunsheetLink } from './public-runsheet';
import { packEmailMessage } from './pack-email-template';
import { emailPdf } from './email-pdf';

export const resendKey = defineSecret('RESEND_API_KEY');
export const emailContent = {
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/)
    .optional(),
  message: z.string().trim().max(5000).optional(),
};
export const selection = z.strictObject({
  tenantId: id,
  eventId: id,
  personId: id,
  jobId: id,
  email: z.email(),
  ...emailContent,
});

export function assertEmailEnabled(tenantId: string) {
  if (
    !process.env.PACK_EMAIL_TENANTS?.split(',')
      .map((v) => v.trim())
      .includes(tenantId)
  )
    throw new HttpsError('failed-precondition', 'Pack email is not enabled for this organisation.');
  if (!process.env.PACK_EMAIL_FROM)
    throw new HttpsError('failed-precondition', 'The pack email sender is not configured.');
}

export async function sendPackEmail(request: CallableRequest) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to email session packs.');
  const input = selection.safeParse(request.data);
  if (!input.success)
    throw new HttpsError(
      'invalid-argument',
      'Check the email address, subject (up to 200 characters) and message (up to 5,000 characters).',
    );
  const { tenantId, eventId, personId, jobId, email, subject, message: blurb } = input.data;
  const db = getFirestore(),
    uid = request.auth.uid;
  await authorize(db, uid, tenantId, 'edit');
  assertEmailEnabled(tenantId);
  const from = process.env.PACK_EMAIL_FROM,
    key = resendKey.value();
  if (!from || !key)
    throw new HttpsError('failed-precondition', 'The pack email sender is not configured.');

  const jobRef = db.doc(`tenants/${tenantId}/exportJobs/${jobId}`);
  const personRef = db.doc(`tenants/${tenantId}/events/${eventId}/people/${personId}`);
  const [jobDoc, personDoc] = await db.getAll(jobRef, personRef);
  const job = jobDoc.data(),
    person = personDoc.data();
  if (
    !job ||
    job.status !== 'complete' ||
    job.createdBy !== uid ||
    job.eventId !== eventId ||
    job.fullPackPersonId !== personId
  )
    throw new HttpsError('failed-precondition', 'Generate a full pack for this person first.');
  if (typeof person?.email !== 'string' || person.email.trim() !== email)
    throw new HttpsError(
      'failed-precondition',
      'The saved email address changed. Review it before sending.',
    );
  if (job.emailSentTo === email) return { sent: true };
  // Keep every retry inside the mail provider's 24-hour idempotency window.
  if (job.emailSentTo || Date.now() - job.completedAt.toMillis() >= 23 * 3600_000)
    throw new HttpsError('failed-precondition', 'Generate a fresh pack before sending.', {
      newPack: true,
    });

  const file = getStorage().bucket().file(job.path);
  const [meta] = await file.getMetadata();
  if (Number(meta.size) > 25 * 1024 * 1024)
    throw new HttpsError(
      'resource-exhausted',
      'The PDF exceeds the 25 MB attachment limit. Reduce its size in Export.',
      { newPack: true },
    );
  const [bytes] = await file.download();
  const pdf = await emailPdf(bytes);
  const link = await createRunsheetLink({
    ...request,
    data: { tenantId, eventId, personId },
  });
  const projectId = process.env.GCLOUD_PROJECT;
  const appUrl = process.env.PACK_EMAIL_APP_URL || (projectId && `https://${projectId}.web.app`);
  if (!appUrl || !/^https:\/\//.test(appUrl))
    throw new HttpsError('failed-precondition', 'The digital runsheet address is not configured.');
  const url = new URL(`/runsheet/${tenantId}/${eventId}/${personId}/${link.token}`, appUrl).href;
  const message = packEmailMessage(job.personName ?? person.name, job.eventName, url, {
    subject,
    message: blurb,
  });
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': createHash('sha256').update(jobRef.path).digest('hex'),
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        from,
        to: [email],
        ...message,
        attachments: [{ filename: 'Session pack.pdf', content: pdf.toString('base64') }],
      }),
    });
  } catch {
    throw new HttpsError('unavailable', 'Sending could not be confirmed. Retry this recipient.');
  }
  if (!response.ok)
    throw new HttpsError(
      'unavailable',
      `The email service did not confirm sending (HTTP ${response.status}).`,
    );
  await jobRef.update({ emailSentTo: email });
  return { sent: true };
}
