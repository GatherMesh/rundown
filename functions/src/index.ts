import { initializeApp } from 'firebase-admin/app';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { exportPacks, confirmPrinted } from './export';
import { apiHandler } from './api-http';
import { sendPackEmail, resendKey } from './email-pack';
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
export const emailPack = onCall(
  { secrets: [resendKey], memory: '512MiB', timeoutSeconds: 120 },
  sendPackEmail,
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
