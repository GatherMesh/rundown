// Creates an isolated QA tenant/user and removes only those exact resources in finally.
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { PDFDocument } from 'pdf-lib';
import { initializeApp as initializeClient, deleteApp } from 'firebase/app';
import { getAuth as getClientAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getStorage, ref, getBytes } from 'firebase/storage';
import { rejects } from 'node:assert/strict';
const require = createRequire(import.meta.url),
  cliAuth = require('firebase-tools/lib/auth');
const account = cliAuth.getGlobalDefaultAccount();
if (!account) throw new Error('Sign in with Firebase CLI first.');
const tokens = await cliAuth.getAccessToken(
  account.tokens.refresh_token,
  account.tokens.scopes ?? [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/firebase',
  ],
);
const projectId = 'gathermesh-rundown',
  tag = 'qa-' + randomUUID(),
  email = tag + '@example.com',
  password = randomBytes(32).toString('base64url');
const config = Object.fromEntries(
  (await readFile('app/.env.prod', 'utf8'))
    .trim()
    .split('\n')
    .map((l) => {
      const n = l.indexOf('=');
      return [l.slice(0, n), l.slice(n + 1)];
    }),
);
initializeApp({
  projectId,
  storageBucket: `${projectId}.firebasestorage.app`,
  credential: {
    getAccessToken: async () => ({ access_token: tokens.access_token, expires_in: 3600 }),
  },
});
const authClient = new OAuth2Client();
authClient.setCredentials({ access_token: tokens.access_token });
const cloudStorage = new Storage({ projectId, authClient });
const bucket = cloudStorage.bucket(`${projectId}.firebasestorage.app`);
const db = new Firestore({ projectId, authClient }),
  tenant = db.doc(`tenants/${tag}`),
  seed = JSON.parse(await readFile('reference/seed.json', 'utf8'));
if (process.argv[2] === '--list-qa') {
  const users = await getAuth().listUsers();
  console.log(
    users.users
      .filter((u) => /^qa-[a-f0-9-]+@example\.com$/.test(u.email ?? ''))
      .map((u) => ({ uid: u.uid, email: u.email })),
  );
  process.exit(0);
}
if (process.argv[2] === '--cleanup') {
  const target = process.argv[3];
  if (!/^qa-[a-f0-9-]{36}$/.test(target ?? ''))
    throw new Error('An exact QA resource ID is required.');
  await db.recursiveDelete(db.doc(`tenants/${target}`));
  await bucket.deleteFiles({ prefix: `tenants/${target}/` });
  await getAuth().deleteUser(target);
  console.log('Removed ' + target);
  process.exit(0);
}
let userCreated = false;
const client = initializeClient({
  apiKey: config.VITE_FIREBASE_API_KEY,
  projectId,
  storageBucket: `${projectId}.firebasestorage.app`,
});
const clientAuth = getClientAuth(client),
  clientStorage = getStorage(client);
try {
  await getAuth().createUser({ uid: tag, email, password, emailVerified: true });
  userCreated = true;
  const login = await signInWithEmailAndPassword(clientAuth, email, password);
  const signed = { idToken: await login.user.getIdToken() };
  const b = db.batch();
  b.set(tenant, { name: 'Export verification', createdBy: tag, createdAt: Timestamp.now() });
  b.set(tenant.collection('members').doc(tag), {
    role: 'viewer',
    displayName: 'QA',
    email,
    addedAt: Timestamp.now(),
  });
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
      b.set(s.collection('items').doc(id), { ...item, updatedBy: tag, updatedAt: Timestamp.now() });
  }
  await b.commit();
  for (const name of ['renderPack', 'renderAllPacks']) {
    const started = Date.now();
    const response = await fetch(
      `https://australia-southeast1-${projectId}.cloudfunctions.net/${name}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signed.idToken}` },
        body: JSON.stringify({
          data: {
            tenantId: tag,
            eventId: 'easter-2027',
            sessionId: 'sat-evening',
            personId: 'margaret',
            jobId: randomUUID(),
          },
        }),
      },
    );
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(JSON.stringify(result));
    // Use the same authenticated Storage access as the app; admin downloads bypass rules.
    const bytes = new Uint8Array(await getBytes(ref(clientStorage, result.result.path)));
    const pdf = await PDFDocument.load(bytes);
    if (name === 'renderPack' && (result.result.sourcePages !== 3 || result.result.sheets !== 3))
      throw new Error('Unexpected Margaret pack counts: ' + JSON.stringify(result.result));
    if (name === 'renderAllPacks' && pdf.getPageCount() !== 30)
      throw new Error('Combined job should be 30 sides.');
    await mkdir('artifacts', { recursive: true });
    await writeFile(`artifacts/production-${name}.pdf`, bytes);
    console.log(
      JSON.stringify({
        function: name,
        seconds: (Date.now() - started) / 1000,
        sourcePages: result.result.sourcePages,
        sheets: result.result.sheets,
        pdfSides: pdf.getPageCount(),
      }),
    );
    await tenant.collection('members').doc(tag).delete();
    await rejects(getBytes(ref(clientStorage, result.result.path)), {
      code: 'storage/unauthorized',
    });
    await tenant.collection('members').doc(tag).set({ role: 'viewer', displayName: 'QA', email });
    await signOut(clientAuth);
    await rejects(getBytes(ref(clientStorage, result.result.path)), {
      code: 'storage/unauthorized',
    });
    await signInWithEmailAndPassword(clientAuth, email, password);
    console.log('Storage denies non-members and signed-out users.');
  }
  const selection = db.batch();
  for (const p of seed.people)
    selection.update(ev.collection('people').doc(p.id), {
      'pack.enabled': ['margaret', 'josh'].includes(p.id),
      'pack.sessionIds': p.id === 'margaret' ? ['fri-opening', 'sat-evening'] : ['sat-evening'],
      'pack.coverSheet': true,
    });
  await selection.commit();
  for (const [name, expectedPages, expectedSheets, sessionId] of [
    ['renderPack', 14, 7],
    ['renderAllPacks', 18, 9],
    ['renderPack', 6, 3, 'sat-evening'],
  ]) {
    const response = await fetch(
      `https://australia-southeast1-${projectId}.cloudfunctions.net/${name}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signed.idToken}` },
        body: JSON.stringify({
          data: { tenantId: tag, eventId, sessionId, personId: 'margaret', jobId: randomUUID() },
        }),
      },
    );
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(JSON.stringify(result));
    const bytes = await getBytes(ref(clientStorage, result.result.path));
    const pdf = await PDFDocument.load(bytes);
    await writeFile(
      `artifacts/production-${name}-${sessionId ?? 'person-covers'}.pdf`,
      new Uint8Array(bytes),
    );
    if (pdf.getPageCount() !== expectedPages || result.result.sheets !== expectedSheets)
      throw new Error('Unexpected multi-session counts: ' + JSON.stringify(result.result));
    console.log(
      JSON.stringify({
        function: name,
        scope: sessionId ?? 'selected sessions',
        sheets: expectedSheets,
        pdfSides: pdf.getPageCount(),
      }),
    );
  }
  const denied = await fetch(
    `https://australia-southeast1-${projectId}.cloudfunctions.net/renderPack`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signed.idToken}` },
      body: JSON.stringify({
        data: {
          tenantId: 'not-a-member',
          eventId: 'event',
          sessionId: 'session',
          personId: 'person',
          jobId: randomUUID(),
        },
      }),
    },
  );
  if (denied.status !== 403) throw new Error('Cross-tenant export must be denied.');
  console.log('Cross-tenant export correctly denied.');
} finally {
  await deleteApp(client);
  await db.recursiveDelete(tenant);
  await bucket.deleteFiles({ prefix: `tenants/${tag}/` });
  if (userCreated) await getAuth().deleteUser(tag);
  console.log('Removed isolated production QA resources.');
}
