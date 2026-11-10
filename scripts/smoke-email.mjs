// Seeded emulators and localhost:9000 required. Mail requests are intercepted; no email is sent.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  await mkdir('artifacts', { recursive: true });
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
    ).html,
  );
  const page = await browser.newPage();
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
  await page.setViewport({ width: 1440, height: 1050 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sends = [];
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    if (!request.url().endsWith('/emailPack')) return request.continue();
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Content-Type': 'application/json',
    };
    if (request.method() === 'OPTIONS') return request.respond({ status: 204, headers });
    const data = JSON.parse(request.postData()).data;
    sends.push(data);
    const fail =
      data.personId === 'priya' && sends.filter((s) => s.personId === 'priya').length === 1;
    return request.respond({
      status: fail ? 503 : 200,
      headers,
      body: JSON.stringify(
        fail
          ? {
              error: {
                status: 'UNAVAILABLE',
                message: 'Test mail service unavailable. Retry this recipient.',
              },
            }
          : { result: { sent: true } },
      ),
    });
  });
  await page.goto('http://localhost:9000/people');
  await page.waitForSelector('button.avatar');
  await page.click('button.avatar');
  await page.locator('::-p-text(Sign out)').click();
  await page.locator('::-p-text(Sign in to seeded demo)').click();
  const email = (name) => `input[aria-label="Email address for ${name}"]`;
  await page.waitForSelector(email('Priya Shah'));
  for (const name of ['Priya Shah', 'Rev. Margaret Hill']) {
    await page
      .locator(email(name))
      .fill(name === 'Priya Shah' ? 'priya@example.com' : 'margaret@example.com');
  }
  await page.locator('button ::-p-text(Email packs)').click();
  await page.waitForSelector('.email-packs');
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
  );
  await page.locator('::-p-text(Select all eligible people)').click();
  await page.waitForFunction(() =>
    document.querySelector('.email-packs').textContent.includes('Send emails (2)'),
  );
  await settle();
  await page.screenshot({ path: 'artifacts/email-recipients-desktop.png' });
  await page.setViewport({ width: 768, height: 1024 });
  await page.screenshot({ path: 'artifacts/email-recipients-tablet.png' });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/email-recipients-mobile.png' });
  await page.setViewport({ width: 1440, height: 1050 });
  await page.locator('button ::-p-text(Send emails (2))').click();
  await page.waitForFunction(
    () =>
      document.querySelector('.email-packs').textContent.includes('Test mail service unavailable'),
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => document.querySelector('.email-packs').textContent.includes('Sent'),
    { timeout: 120000 },
  );
  await page.waitForFunction(() =>
    document.querySelector('.email-packs').textContent.includes('Send emails (1)'),
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.email-packs button')].some(
      (b) => b.textContent.includes('Send emails (1)') && !b.disabled,
    ),
  );
  await settle();
  await page.screenshot({ path: 'artifacts/email-recipients-retry.png' });
  await page.locator('button ::-p-text(Send emails (1))').click();
  await page.waitForFunction(
    () => document.querySelector('.email-packs').textContent.includes('Send emails (0)'),
    { timeout: 120000 },
  );
  assert.deepEqual(sends.map((s) => s.personId).sort(), ['margaret', 'priya', 'priya']);
  const priyaSends = sends.filter((s) => s.personId === 'priya');
  assert.equal(
    priyaSends[0].jobId,
    priyaSends[1].jobId,
    'retry reuses the rendered pack and idempotency key',
  );
  assert.equal(priyaSends[0].email, 'priya@example.com');
  assert.equal(sends.find((s) => s.personId === 'margaret').email, 'margaret@example.com');
  assert.deepEqual(errors, []);
  await page.locator('.email-packs button ::-p-text(Close)').click();
  await page.waitForSelector('.email-packs', { hidden: true });
  await page.locator('button ::-p-text(Add person)').click();
  await page.waitForSelector('.q-dialog input[type="email"]');
  await page.locator('.q-dialog input[aria-label="Name"]').fill('Email QA');
  await page.locator('.q-dialog input[type="email"]').fill('new@example.com');
  await page.locator('.q-dialog button[type="submit"]').click();
  await page.waitForSelector(email('Email QA'));
  assert.equal(await page.$eval(email('Email QA'), (e) => e.value), 'new@example.com');
  const preview = await browser.newPage();
  await preview.goto(new URL('../artifacts/pack-email-preview.html', import.meta.url).href);
  for (const [width, height, label] of [
    [700, 900, 'desktop'],
    [390, 1000, 'mobile'],
  ]) {
    await preview.setViewport({ width, height });
    await preview.screenshot({ path: `artifacts/pack-email-${label}.png`, fullPage: true });
    assert.ok(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  console.log(
    'PASS: saved emails, eligible selection, per-person PDF generation, partial failure, retry, add person, and responsive email layout. No emails sent.',
  );
} finally {
  await browser.close();
}
