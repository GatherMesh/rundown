// Check colour inheritance and print output through the same built renderer as exports.
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
  for (const itemStyle of ['table', 'cards', 'denseCards', 'cueCard', 'compact']) {
    for (const mode of ['custom', 'default', 'invalid', 'hiddenCategory']) {
      const result = await page.evaluate(async ({ seed, itemStyle, mode }) => {
        const template = structuredClone(seed.templates[0]);
        template.itemStyle = itemStyle;
        template.orientation = 'portrait';
        template.filter = { scope: 'recipientPlusNeighbours', categoryIds: null };
        const colors = { title: '#2457d6', category: '#6b34c9' };
        template.columns = ['start', 'duration', 'end', 'number', 'title', 'category', 'people', 'notes', 'script', 'audio', 'video', 'lighting', 'camera', 'slides', 'imageSlide'].map((key) => ({
          key,
          visible: !(mode === 'hiddenCategory' && key === 'category'),
          width: '1fr',
          ...(mode === 'default' ? {} : {
            color: mode === 'invalid' ? '#123456;display:none' : colors[key] ?? '#126b78',
          }),
        }));
        const items = [0, 1, 2].map((index) => ({
          id: `item-${index}`,
          order: `a${index}`,
          number: index + 1,
          title: `Item ${index + 1}`,
          durationSec: 60,
          startSec: index * 60,
          endSec: (index + 1) * 60,
          categoryId: `category-${index}`,
          category: { id: `category-${index}`, name: 'Spoken', bg: '#fff0e3', fg: mode === 'invalid' ? 'red;display:none' : ['#1c7a47', '#a4510e', '#6b34c9'][index], order: index },
          personIds: index === 1 ? ['person'] : [],
          people: [{ id: 'person', name: 'Example person' }],
          notes: 'Example notes',
          script: 'Example script',
          av: { audio: 'Audio cue', video: 'Video cue', lighting: 'Lighting cue', camera: 'Camera cue', slides: 'Slide cue' },
          imageSlide: { name: 'Image placeholder' },
        }));
        await window.renderRundown({
          tenant: { name: 'QCEC' },
          event: { name: 'Event', timeZone: 'Australia/Brisbane' },
          session: { name: 'Column colours', startAt: seed.sessions[0].startAt },
          recipient: { id: 'person', name: 'Example person' },
          template,
          items,
        });
        if (window.__RENDER_ERROR) throw new Error(window.__RENDER_ERROR);
        const root = document.querySelector('#print-root');
        const row = root.querySelector('.recipient-row');
        const colored = [...row.querySelectorAll('[style*="--column-color"]')];
        return {
          accents: [...root.querySelectorAll('.print-category-accent')].map((el) => ({
            color: getComputedStyle(el).borderLeftColor,
            width: getComputedStyle(el).borderLeftWidth,
          })),
          title: getComputedStyle(row.querySelector('h2, b')).color,
          category: row.querySelector('.print-category') ? getComputedStyle(row.querySelector('.print-category')).color : null,
          colored: colored.length,
          inherited: colored.every((el) => [...el.querySelectorAll('*')].every((child) => getComputedStyle(child).color === getComputedStyle(el).color)),
          background: getComputedStyle(row).backgroundColor,
          injected: root.innerHTML.includes('display:none'),
          pages: window.__RENDER_DONE.pageCount,
        };
      }, { seed, itemStyle, mode });
      const custom = mode === 'custom' || mode === 'hiddenCategory';
      assert.equal(result.title, custom ? 'rgb(36, 87, 214)' : 'rgb(22, 24, 29)');
      if (itemStyle === 'table' && mode !== 'hiddenCategory')
        assert.equal(result.category, custom ? 'rgb(107, 52, 201)' : 'rgb(91, 98, 112)');
      assert.equal(result.colored, custom ? (mode === 'hiddenCategory' ? 14 : 15) : 0);
      assert.ok(result.inherited, 'column labels and values inherit the chosen colour');
      assert.equal(result.background, 'rgb(238, 243, 255)', 'recipient tint stays visible');
      assert.equal(result.injected, false, 'reject malformed colours at render time');
      assert.ok(result.pages > 0);
      if (itemStyle === 'cards' || itemStyle === 'denseCards') {
        assert.deepEqual(result.accents.map((a) => a.width), ['4px', '4px', '4px']);
        assert.deepEqual(result.accents.map((a) => a.color), mode === 'invalid'
          ? Array(3).fill('rgb(91, 98, 112)')
          : ['rgb(28, 122, 71)', 'rgb(164, 81, 14)', 'rgb(107, 52, 201)']);
        if (mode === 'custom') {
          await page.screenshot({ path: `artifacts/colours-${itemStyle}.png` });
          await page.pdf({ path: `artifacts/colours-${itemStyle}.pdf`, preferCSSPageSize: true, printBackground: true });
        }
      } else assert.equal(result.accents.length, 0);
    }
  }
  console.log('Colour rendering passed: five layouts, defaults, overrides, hidden category, context accents and invalid input.');
} finally {
  await browser.close();
}
