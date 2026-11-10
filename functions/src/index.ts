import { initializeApp } from 'firebase-admin/app';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { exportPacks, confirmPrinted } from './export';
import { apiHandler } from './api-http';
import { resendKey } from './email-pack';
import {
  queueEmails as enqueue,
  queueExistingPack,
  retryEmailJob as retryQueued,
  processEmailJob as processQueued,
} from './email-queue';
import { deleteSessionData } from './delete-session';
import { createRunsheetLink, getPublicRunsheet } from './public-runsheet';
initializeApp();
setGlobalOptions({
  region: 'australia-southeast1',
  memory: '2GiB',
  timeoutSeconds: 300,
  maxInstances: 3,
  concurrency: 1,
});
export const deleteSession = onCall(deleteSessionData);
export const shareRunsheet = onCall({ memory: '256MiB', timeoutSeconds: 60 }, createRunsheetLink);
export const publicRunsheet = onCall(
  { memory: '256MiB', timeoutSeconds: 60, concurrency: 40 },
  getPublicRunsheet,
);
export const emailPack = onCall(queueExistingPack);
export const queueEmails = onCall(enqueue);
export const retryEmailJob = onCall(retryQueued);
export const processEmailJob = onDocumentWritten(
  {
    document: 'tenants/{tenantId}/events/{eventId}/emailJobs/{jobId}',
    secrets: [resendKey],
    timeoutSeconds: 540,
    maxInstances: 1,
    concurrency: 1,
    retry: true,
  },
  async (event) => {
    const after = event.data?.after.data(),
      before = event.data?.before.data();
    if (
      after?.status !== 'queued' ||
      (before?.status === 'queued' && before?.attempt === after.attempt)
    )
      return;
    await processQueued(event.data!.after.ref, after.attempt);
  },
);
export const confirmPrint = onCall((request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to confirm printing.');
  return confirmPrinted(request.auth.uid, request.data ?? {});
});
export const renderPack = onCall((request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to print session packs.');
  return exportPacks(request.auth.uid, request.data ?? {}, false);
});
export const renderAllPacks = onCall((request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to print session packs.');
  return exportPacks(request.auth.uid, request.data ?? {}, true);
});
export const api = onRequest({ cors: [/^http:\/\/(localhost|127\.0\.0\.1):9000$/] }, apiHandler);
