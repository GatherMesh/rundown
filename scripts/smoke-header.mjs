// Exercise the shared built renderer in a real browser.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const seed = JSON.parse(await readFile('reference/seed.json', 'utf8'));
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : await chromium.executablePath()),
  args: process.platform === 'darwin' ? [] : chromium.args,
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1200 });
  await page.goto(pathToFileURL(resolve('functions/print/src/render/print.html')).href);
  await page.waitForFunction(() => typeof window.renderRundown === 'function');
  await mkdir('artifacts', { recursive: true });
  let checked = 0;
  for (const orientation of ['portrait', 'landscape']) {
    for (const align of ['left', 'center', 'right']) {
      for (const longText of [false, true]) {
        let headerHeight;
        for (const [imageWidth, imageHeight] of [
          [300, 300],
          [1600, 100],
          [100, 600],
        ]) {
          const template = structuredClone(seed.templates[0]);
          template.orientation = orientation;
          template.header.logo = { show: true, align };
          const payload = {
            tenant: { name: 'Example organisation' },
            event: { name: 'Get-Away', timeZone: 'Australia/Brisbane' },
            session: {
              name: longText
                ? 'A longer session title that needs to wrap onto several lines'
                : 'Morning session',
              subtitle: 'Announcements and notices',
              startAt: seed.sessions[0].startAt,
            },
            recipient: { id: 'person', name: 'John Board' },
            template,
            items: [],
          };
          const metrics = await page.evaluate(
            async ({ payload, imageWidth, imageHeight }) => {
              const canvas = document.createElement('canvas');
              canvas.width = imageWidth;
              canvas.height = imageHeight;
              const context = canvas.getContext('2d');
              context.fillStyle = '#2457d6';
              context.fillRect(0, 0, imageWidth, imageHeight);
              payload.tenant.logoUrl = canvas.toDataURL('image/png');
              await window.renderRundown(payload);
              if (window.__RENDER_ERROR) throw new Error(window.__RENDER_ERROR);
              const header = document.querySelector('.print-header');
              const image = header.querySelector('.print-logo');
              const rect = (element) => {
                const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
                return { x, y, width, height, right, bottom };
              };
              return {
                header: rect(header),
                logo: rect(image),
                text: [...header.querySelectorAll('.print-header-text')].map(rect),
                fit: getComputedStyle(image).objectFit,
              };
            },
            { payload, imageWidth, imageHeight },
          );
          assert.equal(metrics.fit, 'contain');
          assert.ok(
            metrics.logo.width > 0 && metrics.logo.height > 50,
            'logo uses text-defined header height',
          );
          assert.ok(
            metrics.logo.x >= metrics.header.x && metrics.logo.right <= metrics.header.right + 1,
            JSON.stringify({ orientation, align, longText, imageWidth, metrics }),
          );
          assert.ok(
            metrics.logo.bottom <= metrics.header.bottom - 15,
            'logo stays above header rule',
          );
          if (align !== 'right')
            assert.ok(
              Math.abs(metrics.text[1].right - metrics.header.right) < 1,
              'right-aligned text stays at the header edge',
            );
          for (const text of metrics.text) {
            assert.ok(
              text.right <= metrics.logo.x + 1 || text.x >= metrics.logo.right - 1,
              'logo does not overlap header text',
            );
            assert.ok(text.bottom <= metrics.header.bottom - 15, 'header contains all text');
          }
          if (align === 'center')
            assert.ok(
              Math.abs(
                metrics.logo.x +
                  metrics.logo.width / 2 -
                  metrics.header.x -
                  metrics.header.width / 2,
              ) < 1,
              'centre logo stays centred on the page',
            );
          if (headerHeight !== undefined)
            assert.ok(
              Math.abs(metrics.header.height - headerHeight) < 1,
              'logo aspect ratio does not enlarge the header',
            );
          headerHeight = metrics.header.height;
          if (imageWidth === 1600) {
            if (!longText)
              assert.ok(metrics.logo.width > 80, 'wide logos can grow past the old fixed cap');
            if (longText)
              await page.screenshot({ path: `artifacts/header-${orientation}-${align}.png` });
          }
          checked++;
        }
      }
    }
  }
  for (const mode of ['logoOnly', 'hidden', 'fallback']) {
    await page.evaluate(
      async ({ mode, seed }) => {
        const template = structuredClone(seed.templates[0]);
        template.header.logo = { show: mode !== 'hidden', align: 'center' };
        if (mode === 'logoOnly')
          for (const [key, field] of Object.entries(template.header))
            if (key !== 'logo') field.show = false;
        const canvas = document.createElement('canvas');
        await window.renderRundown({
          tenant: { name: 'QCEC', logoUrl: mode === 'fallback' ? undefined : canvas.toDataURL() },
          event: { name: 'Event', timeZone: 'Australia/Brisbane' },
          session: { name: 'Session', startAt: seed.sessions[0].startAt },
          recipient: null,
          template,
          items: [],
        });
        if (window.__RENDER_ERROR) throw new Error(window.__RENDER_ERROR);
        const header = document.querySelector('.print-header');
        if (mode === 'hidden' && header.querySelector('.print-header-logo'))
          throw new Error('Hidden logo must not reserve a slot');
        if (mode === 'fallback' && !header.querySelector('.print-logo-text'))
          throw new Error('Missing image must show the tenant name');
        if (
          mode === 'logoOnly' &&
          Math.abs(header.clientWidth - header.querySelector('.print-logo').clientWidth) > 1
        )
          throw new Error('Logo-only header must offer the full header width');
      },
      { mode, seed },
    );
  }
  console.log(
    `Header rendering passed: ${checked} portrait/landscape, alignment, text and logo-shape combinations.`,
  );
} finally {
  await browser.close();
}
