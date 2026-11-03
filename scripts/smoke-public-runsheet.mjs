// Requires seeded demo emulators and the app dev server with VITE_USE_EMULATORS=true.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const origin = 'http://localhost:9000';
const endpoint = 'http://127.0.0.1:5001/demo-rundown/australia-southeast1';
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
async function call(name, data) {
  const response = await fetch(`${endpoint}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, body: await response.json() };
}
try {
  await mkdir('artifacts', { recursive: true });
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(origin, [
    'clipboard-read',
    'clipboard-write',
    'clipboard-sanitized-write',
  ]);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1050 });
  await page.goto(`${origin}/export`);
  await page.waitForSelector('button.avatar');
  await page.click('button.avatar');
  await page.locator('::-p-text(Sign out)').click();
  await page.locator('::-p-text(Sign in to seeded demo)').click();
  const button = '[aria-label="Copy public runsheet link for Rev. Margaret Hill"]';
  await page.waitForSelector(button);
  await page.waitForFunction((selector) => !document.querySelector(selector).disabled, {}, button);
  await page.click(button);
  await page.waitForFunction(() =>
    document.body.textContent.includes('Runsheet link copied for Rev. Margaret Hill.'),
  );
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(link.startsWith(`${origin}/runsheet/qcec/easter-2027/margaret/`));
  await page.waitForFunction((selector) => !document.querySelector(selector).disabled, {}, button);
  await page.click(button);
  await page.waitForFunction((selector) => !document.querySelector(selector).disabled, {}, button);
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    link,
    'copying twice returns the same link',
  );
  await page.screenshot({ path: 'artifacts/export-copy-link.png' });
  await context.overridePermissions(origin, ['clipboard-read', 'clipboard-write']);
  await page.click(button);
  await page.waitForSelector('.q-dialog input');
  assert.equal(
    await page.$eval('.q-dialog input', (input) => input.value),
    link,
    'clipboard denial offers a selectable link',
  );
  await page.locator('::-p-text(Done)').click();

  const [, , tenantId, eventId, personId, token] = new URL(link).pathname.split('/');
  const params = { tenantId, eventId, personId, token };
  const anonymous = await call('publicRunsheet', params);
  assert.equal(anonymous.status, 200, JSON.stringify(anonymous.body));
  assert.equal(anonymous.body.result.person.name, 'Rev. Margaret Hill');
  assert.ok(!JSON.stringify(anonymous.body).includes('email'));
  assert.equal((await call('shareRunsheet', { tenantId, eventId, personId })).status, 401);
  assert.equal((await call('publicRunsheet', { ...params, token: '0'.repeat(48) })).status, 404);

  const publicContext = await browser.createBrowserContext();
  const mobile = await publicContext.newPage();
  const errors = [];
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await mobile.goto(link);
  await mobile.waitForSelector('#runsheet-session');
  assert.equal(await mobile.$('.app-shell'), null, 'public page bypasses the workspace and login');
  await mobile.select('#runsheet-session', 'sat-evening');
  await mobile.waitForFunction(
    () => document.querySelector('#runsheet-title')?.textContent === 'Saturday Evening Celebration',
  );
  await mobile.waitForSelector('.runsheet-items .print-card');
  assert.equal(await mobile.$$eval('.runsheet-items .print-card', (els) => els.length), 2);
  assert.equal(await mobile.$$eval('.runsheet-items .print-context', (els) => els.length), 3);
  await mobile.screenshot({ path: 'artifacts/public-runsheet-mobile.png', fullPage: true });
  await mobile.select('#runsheet-view', 'producer-rundown');
  assert.equal(await mobile.$$eval('.runsheet-items .print-card', (els) => els.length), 10);
  for (const width of [320, 390, 768, 1280]) {
    await mobile.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
    assert.ok(
      await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `no horizontal overflow at ${width}px`,
    );
    assert.equal(
      await mobile.$('.print-clipped'),
      null,
      'web scripts are not clipped to print pages',
    );
  }
  await mobile.select('#runsheet-session', 'fri-opening');
  await mobile.waitForFunction(
    () => document.querySelector('#runsheet-title')?.textContent === 'Opening Night',
  );
  await mobile.goto(link.replace(token, '0'.repeat(48)));
  await mobile.waitForFunction(() => document.body.textContent.includes('Runsheet unavailable'));
  assert.deepEqual(errors, []);
  console.log(
    'Public runsheet smoke passed: stable Copy Link, anonymous reads, session/view selection, template filtering, invalid links, and 320–1280px layouts.',
  );
} catch (error) {
  for (const [index, page] of (await browser.pages()).entries()) {
    await page.screenshot({ path: `artifacts/public-runsheet-failure-${index}.png` });
    console.error(await page.evaluate(() => document.body.innerText.slice(-2000)));
  }
  throw error;
} finally {
  await browser.close();
}
