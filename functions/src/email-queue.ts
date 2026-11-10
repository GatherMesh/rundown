import { createHash, randomUUID } from 'node:crypto';
import { getFirestore, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { id } from './api-contract';
import { authorize } from './api-service';
import { assertEmailEnabled, emailContent, selection, sendPackEmail } from './email-pack';
import { exportPacks } from './export';
import { includesSession } from '../../app/src/render/pack-selection';
import type { Person } from '../../app/src/types';

const scope = { tenantId: id, eventId: id };
const enqueueSchema = z.strictObject({
  ...scope,
  requestId: id,
  recipients: z
    .array(z.strictObject({ personId: id, email: z.email() }))
    .min(1)
    .max(100)
    .refine((values) => new Set(values.map((v) => v.personId)).size === values.length),
  ...emailContent,
});
const retrySchema = z.strictObject({ ...scope, jobId: id, attempt: z.number().int().min(1) });

export async function queueEmails(request: CallableRequest) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to queue emails.');
  const parsed = enqueueSchema.safeParse(request.data);
  if (!parsed.success)
    throw new HttpsError(
      'invalid-argument',
      'Check the recipients, subject and message. Queue up to 100 people at a time.',
    );
  const { tenantId, eventId, requestId, recipients, message = '' } = parsed.data;
  const db = getFirestore(),
    uid = request.auth.uid;
  await authorize(db, uid, tenantId, 'edit');
  assertEmailEnabled(tenantId);
  const event = db.doc(`tenants/${tenantId}/events/${eventId}`);
  const [eventDoc, sessions] = await Promise.all([event.get(), event.collection('sessions').get()]);
  if (!eventDoc.exists) throw new HttpsError('not-found', 'The event no longer exists.');
  const subject =
    parsed.data.subject ??
    `Your rundowns for ${eventDoc.data()!.name.replace(/[\r\n]+/g, ' ')}`.slice(0, 200);
  const refs = recipients.map((p) =>
    event.collection('emailJobs').doc(
      createHash('sha256')
        .update(JSON.stringify([uid, requestId, p.personId]))
        .digest('hex'),
    ),
  );
  await db.runTransaction(async (tx) => {
    const jobs = await tx.getAll(...refs);
    const people = await tx.getAll(
      ...recipients.map((p) => event.collection('people').doc(p.personId)),
    );
    recipients.forEach((recipient, i) => {
      const previous = jobs[i].data();
      if (previous) {
        if (
          previous.email !== recipient.email ||
          previous.subject !== subject ||
          previous.message !== message
        )
          throw new HttpsError(
            'already-exists',
            'This request was already queued with different content. Start a new email.',
          );
        return;
      }
      const person = people[i].data() as Person | undefined;
      if (!person || person.email?.trim() !== recipient.email)
        throw new HttpsError(
          'failed-precondition',
          'A saved email address changed. Review the recipients before queueing.',
        );
      if (
        !person.pack?.templates.length ||
        !sessions.docs.some((s) => includesSession(person.pack, s.id))
      )
        throw new HttpsError(
          'failed-precondition',
          `Choose templates and sessions in Export for ${person.name}.`,
        );
      tx.create(refs[i], {
        personId: recipient.personId,
        recipientName: person.name,
        email: recipient.email,
        subject,
        message,
        createdBy: uid,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        status: 'queued',
        attempt: 1,
        error: '',
      });
    });
  });
  return { queued: refs.length, jobIds: refs.map((ref) => ref.id) };
}

// Older open browser tabs also enqueue rather than sending on the request thread.
export async function queueExistingPack(request: CallableRequest) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to queue emails.');
  const parsed = selection.safeParse(request.data);
  if (!parsed.success)
    throw new HttpsError('invalid-argument', 'Open the Email page to queue this email.');
  const { tenantId, eventId, personId, email, jobId, subject, message } = parsed.data;
  const db = getFirestore();
  await authorize(db, request.auth.uid, tenantId, 'edit');
  const previous = (await db.doc(`tenants/${tenantId}/exportJobs/${jobId}`).get()).data();
  if (
    previous?.createdBy === request.auth.uid &&
    previous.eventId === eventId &&
    previous.fullPackPersonId === personId &&
    previous.emailSentTo === email
  )
    return { sent: true, queued: 0, jobIds: [] };
  return queueEmails({
    ...request,
    data: {
      tenantId,
      eventId,
      requestId: jobId,
      recipients: [{ personId, email }],
      subject,
      message,
    },
  });
}

export async function retryEmailJob(request: CallableRequest) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to retry emails.');
  const parsed = retrySchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Choose a failed email to retry.');
  const { tenantId, eventId, jobId, attempt } = parsed.data;
  const db = getFirestore();
  await authorize(db, request.auth.uid, tenantId, 'edit');
  assertEmailEnabled(tenantId);
  const ref = db.doc(`tenants/${tenantId}/events/${eventId}/emailJobs/${jobId}`);
  await db.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    if (!job) throw new HttpsError('not-found', 'This email job no longer exists.');
    if (job.attempt > attempt) return;
    if (job.retryable === false)
      throw new HttpsError('failed-precondition', 'Compose a new email for this recipient.');
    if (job.status !== 'failed' || job.attempt !== attempt)
      throw new HttpsError('failed-precondition', 'Only failed emails can be retried.');
    tx.update(ref, {
      status: 'queued',
      attempt: attempt + 1,
      error: '',
      updatedAt: Timestamp.now(),
    });
  });
  return { queued: true };
}

export async function processEmailJob(ref: DocumentReference, attempt: number) {
  const db = getFirestore();
  const job = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (!current || current.attempt !== attempt || ['sent', 'failed'].includes(current.status))
      return null;
    if (current.leaseUntil?.toMillis() > Date.now())
      throw new Error('Email job is already running. Retry after its lease expires.');
    tx.update(ref, {
      status: 'preparing',
      updatedAt: Timestamp.now(),
      leaseUntil: Timestamp.fromMillis(Date.now() + 10 * 60_000),
    });
    return current;
  });
  if (!job) return;
  try {
    const event = ref.parent.parent!;
    const tenant = event.parent.parent!;
    const tenantId = tenant.id,
      eventId = event.id;
    await authorize(db, job.createdBy, tenantId, 'edit');
    assertEmailEnabled(tenantId);
    let exportJobId = job.exportJobId as string | undefined;
    const existing = exportJobId
      ? (await tenant.collection('exportJobs').doc(exportJobId).get()).data()
      : undefined;
    if (existing?.status !== 'complete') {
      exportJobId = randomUUID();
      await ref.update({ exportJobId });
      await exportPacks(
        job.createdBy,
        { tenantId, eventId, personId: job.personId, jobId: exportJobId },
        false,
      );
    }
    await ref.update({ status: 'sending', updatedAt: Timestamp.now() });
    await sendPackEmail({
      auth: { uid: job.createdBy },
      data: {
        tenantId,
        eventId,
        personId: job.personId,
        jobId: exportJobId,
        email: job.email,
        subject: job.subject,
        message: job.message,
      },
    } as CallableRequest);
    await ref.update({
      status: 'sent',
      error: '',
      sentAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      leaseUntil: Timestamp.fromMillis(0),
    });
  } catch (error) {
    const retryable = !(
      error instanceof HttpsError && (error.details as { newPack?: boolean } | undefined)?.newPack
    );
    if (!(error instanceof HttpsError)) console.error('Email queue job failed', error);
    await ref.update({
      status: 'failed',
      retryable,
      error:
        (error instanceof HttpsError
          ? error.message
          : 'Preparing or sending this email failed. Retry this job.') +
        (retryable ? '' : ' Compose a new email after reviewing the pack.'),
      updatedAt: Timestamp.now(),
      leaseUntil: Timestamp.fromMillis(0),
    });
  }
}
