import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getStorage, connectStorageEmulator, getBytes, ref } from 'firebase/storage';
import { PDFDocument } from 'pdf-lib';
import { writeFile, mkdir } from 'node:fs/promises';
const app = initializeApp({
    projectId: 'demo-rundown',
    apiKey: 'demo-key',
    storageBucket: 'demo-rundown.appspot.com',
  }),
  auth = getAuth(app),
  functions = getFunctions(app, 'australia-southeast1'),
  storage = getStorage(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
connectFunctionsEmulator(functions, '127.0.0.1', 5001);
connectStorageEmulator(storage, '127.0.0.1', 9199);
await signInWithEmailAndPassword(auth, 'producer@example.com', 'rundown-demo');
await mkdir('artifacts', { recursive: true });
for (const all of [false, true]) {
  const start = Date.now();
  const result = await httpsCallable(functions, all ? 'renderAllPacks' : 'renderPack', {
    timeout: 300000,
  })({
    tenantId: 'qcec',
    eventId: 'easter-2027',
    sessionId: 'sat-evening',
    personId: 'margaret',
    jobId: crypto.randomUUID(),
  });
  const bytes = await getBytes(ref(storage, result.data.path)),
    pdf = await PDFDocument.load(bytes);
  await writeFile(`artifacts/${all ? 'all-packs' : 'margaret'}.pdf`, Buffer.from(bytes));
  console.log(
    JSON.stringify({
      all,
      seconds: (Date.now() - start) / 1000,
      ...result.data,
      actualPages: pdf.getPageCount(),
    }),
  );
  if (!all && result.data.sourcePages !== 3)
    throw new Error(`Margaret should have 3 source pages, got ${result.data.sourcePages}`);
  if (!all && result.data.sheets !== 3)
    throw new Error(`Margaret should have 3 sheets, got ${result.data.sheets}`);
  if (all && pdf.getPageCount() % 2) throw new Error('Combined pack must end on a sheet boundary.');
}
process.exit(0);
