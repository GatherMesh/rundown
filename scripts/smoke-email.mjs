// Seeded emulators + localhost:9000 required. Start emulators with scripts/mock-resend.cjs.
// Uses only demo-rundown; no production data or real email delivery.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { PDFDocument } from 'pdf-lib';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.STORAGE_EMULATOR_HOST)
  throw new Error('Set FIRESTORE_EMULATOR_HOST and STORAGE_EMULATOR_HOST to the demo emulators.');
initializeApp({ projectId: 'demo-rundown', storageBucket: 'demo-rundown.appspot.com' });
const db = getFirestore(),
  eventPath = 'tenants/qcec/events/easter-2027';
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
let page;
try {
  await db.recursiveDelete(db.collection(`${eventPath}/emailJobs`));
  await rm('artifacts/email-deliveries', { recursive: true, force: true });
  await mkdir('artifacts', { recursive: true });
  page = await browser.newPage();
  const errors = [],
    browserWork = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\/(renderPack|emailPack)$/.test(request.url())) browserWork.push(request.url());
  });
  async function settle() {
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  }
  async function fill(selector, value) {
    await page.focus(selector);
    await page.$eval(selector, (el) => el.select());
    await page.keyboard.press('Backspace');
    await page.type(selector, value);
  }
  await page.setViewport({ width: 1440, height: 1050 });
  await page.goto('http://localhost:9000/people');
  await page.waitForSelector('button.avatar');
  await page.click('button.avatar');
  await page.locator('::-p-text(Sign out)').click();
  await page.locator('::-p-text(Sign in to seeded demo)').click();
  const email = (name) => `input[aria-label="Email address for ${name}"]`;
  await page.waitForSelector(email('Priya Shah'));
  await fill(email('Priya Shah'), 'priya@example.com');
  await fill(email('Rev. Margaret Hill'), 'margaret@example.com');
  assert.equal(
    await page.$('[aria-label="Email pack to Priya Shah"]'),
    null,
    'email sending has moved out of People',
  );
  await page.locator('nav a[href="/email"]').click();
  await page.waitForSelector('.email-composer');
  await fill('.email-composer input[aria-label="Subject"]', 'Saturday team briefing');
  await fill(
    '.email-composer textarea[aria-label="Message (optional)"]',
    'Thanks for being part of the team.\nPlease arrive 30 minutes before your session.',
  );
  await page.locator('::-p-text(Select all eligible people)').click();
  await page.waitForFunction(() =>
    document.querySelector('.email-composer').textContent.includes('Queue emails (2)'),
  );
  await settle();
  for (const [width, height, label] of [
    [1440, 1050, 'desktop'],
    [768, 1024, 'tablet'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewport({ width, height });
    await page.screenshot({ path: `artifacts/email-compose-${label}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewport({ width: 1440, height: 1050 });
  await page.locator('button ::-p-text(Queue emails (2))').click();
  await page.waitForFunction(() => document.body.textContent.includes('2 emails queued.'));
  await page.locator('nav a[href="/people"]').click();
  await page.waitForSelector(email('Priya Shah'));
  async function waitForJobs(predicate) {
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      const jobs = (await db.collection(`${eventPath}/emailJobs`).get()).docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
      if (predicate(jobs)) return jobs;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Background email jobs did not finish.');
  }
  let jobs = await waitForJobs(
    (list) =>
      list.length === 2 &&
      list.some((j) => j.status === 'sent') &&
      list.some((j) => j.status === 'failed'),
  );
  assert.equal(jobs.find((j) => j.personId === 'margaret').status, 'sent');
  assert.equal(jobs.find((j) => j.personId === 'priya').status, 'failed');
  await page.goto('http://localhost:9000/email'); // reload proves queue persists beyond the composing page
  await page.waitForSelector('.email-tabs');
  await page.locator('.email-tabs ::-p-text(Queue)').click();
  await page.waitForSelector('[aria-label="Retry email to Priya Shah"]');
  await settle();
  for (const [width, height, label] of [
    [1440, 1050, 'desktop'],
    [768, 1024, 'tablet'],
    [390, 844, 'mobile'],
  ]) {
    await page.setViewport({ width, height });
    await page.screenshot({ path: `artifacts/email-queue-${label}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewport({ width: 1440, height: 1050 });
  await page.click('[aria-label="Retry email to Priya Shah"]');
  jobs = await waitForJobs((list) => list.length === 2 && list.every((j) => j.status === 'sent'));
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Retry email to Priya Shah"]'),
  );
  const files = await readdir('artifacts/email-deliveries');
  const records = await Promise.all(
    files.map(async (name) =>
      JSON.parse(await readFile(`artifacts/email-deliveries/${name}`, 'utf8')),
    ),
  );
  assert.equal(records.length, 2);
  assert.equal(records.find((r) => r.body.to[0] === 'priya@example.com').count, 2);
  assert.equal(records.find((r) => r.body.to[0] === 'margaret@example.com').count, 1);
  for (const record of records) {
    assert.equal(record.body.subject, 'Saturday team briefing');
    assert.ok(record.body.html.includes('team.<br>Please arrive'));
    assert.ok(record.body.text.includes('team.\nPlease arrive'));
    assert.ok(record.body.html.includes('/runsheet/qcec/easter-2027/'));
    const attachment = Buffer.from(record.body.attachments[0].content, 'base64');
    const pdf = await PDFDocument.load(attachment);
    assert.ok(
      pdf.getPages().every((p) => !!p.node.Contents()),
      'attachment has no print-padding pages',
    );
    const job = jobs.find((j) => j.email === record.body.to[0]);
    const originalJob = (await db.doc(`tenants/qcec/exportJobs/${job.exportJobId}`).get()).data();
    const [bytes] = await getStorage().bucket().file(originalJob.path).download();
    const original = await PDFDocument.load(bytes);
    assert.ok(original.getPageCount() > pdf.getPageCount());
    assert.equal(pdf.getPageCount(), original.getPages().filter((p) => !!p.node.Contents()).length);
    if (job.personId === 'margaret') await writeFile('artifacts/email-attachment.pdf', attachment);
  }
  assert.deepEqual(browserWork, [], 'rendering and delivery run only in the worker');
  assert.deepEqual(errors, []);
  await build({
    entryPoints: ['functions/src/pack-email-template.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'artifacts/pack-email-template.mjs',
  });
  const { packEmailMessage } = await import('../artifacts/pack-email-template.mjs');
  await writeFile(
    'artifacts/pack-email-preview.html',
    packEmailMessage(
      'Rev. Margaret Hill',
      'Easter Convention 2027',
      'https://gathermesh-rundown.web.app/runsheet/preview/event/person/' + 'a'.repeat(48),
      {
        subject: 'Saturday team briefing',
        message:
          'Thanks for being part of the team.\nPlease arrive 30 minutes before your session.',
      },
    ).html,
  );
  console.log(
    'PASS: dedicated Email page, background delivery after navigation, persistent queue after reload, per-recipient failure/retry, stable send keys, and blank-free attachments. No real emails sent.',
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: 'artifacts/email-smoke-error.png', fullPage: true });
    console.error((await page.evaluate(() => document.body.textContent)).slice(0, 1200));
  }
  throw error;
} finally {
  await browser.close();
}
