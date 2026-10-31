import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { id } from './api-contract';
import { authorize } from './api-service';

const scopeSchema = z.strictObject({ tenantId: id, eventId: id, sessionId: id });

export async function deleteSessionData(request: CallableRequest) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to delete a session.');
  const parsed = scopeSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid session selection.');
  const { tenantId, eventId, sessionId } = parsed.data;
  const db = getFirestore();
  await authorize(db, request.auth.uid, tenantId, 'edit');
  const session = db.doc(`tenants/${tenantId}/events/${eventId}/sessions/${sessionId}`);
  // Keep the parent until all items are gone, so an interrupted deletion can be retried.
  for (;;) {
    const rows = await session.collection('items').limit(499).get();
    const batch = db.batch();
    rows.docs.forEach((row) => batch.delete(row.ref));
    if (rows.size < 499) batch.delete(session);
    await batch.commit();
    if (rows.size < 499) return { deleted: true };
  }
}
