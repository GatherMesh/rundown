import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { readFile } from 'node:fs/promises';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST)
  throw new Error(
    'Seed only runs against emulators. Set FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST.',
  );
initializeApp({ projectId: 'demo-rundown' });
const db = getFirestore(),
  seed = JSON.parse(await readFile(new URL('../reference/seed.json', import.meta.url), 'utf8'));
const uid = 'demo-producer';
try {
  await getAuth().createUser({
    uid,
    email: 'producer@example.com',
    password: 'rundown-demo',
    displayName: 'Demo Producer',
  });
} catch (e) {
  if (e.code !== 'auth/uid-already-exists') throw e;
}
const b = db.batch(),
  tenant = db.doc('tenants/qcec');
b.set(tenant, { name: seed.tenant.name, createdBy: uid, createdAt: Timestamp.now() });
b.set(tenant.collection('members').doc(uid), {
  role: 'owner',
  displayName: 'Demo Producer',
  email: 'producer@example.com',
  addedAt: Timestamp.now(),
});
b.set(db.doc(`users/${uid}`), { tenantIds: ['qcec'] });
for (const kind of ['categories', 'templates'])
  for (const { id, ...data } of seed[kind]) b.set(tenant.collection(kind).doc(id), data);
const { id: eventId, ...event } = seed.event,
  ev = tenant.collection('events').doc(eventId);
b.set(ev, event);
for (const { id, ...data } of seed.people) b.set(ev.collection('people').doc(id), data);
for (const { id, startAt, items, ...data } of seed.sessions) {
  const s = ev.collection('sessions').doc(id),
    stamp = Timestamp.fromDate(new Date(startAt));
  b.set(s, { ...data, startAt: stamp, sortKey: stamp, itemCount: items.length });
  for (const { id, ...item } of items)
    b.set(s.collection('items').doc(id), { ...item, updatedBy: uid, updatedAt: Timestamp.now() });
}
await b.commit();
console.log('Seeded local emulators. Sign in as producer@example.com / rundown-demo.');
