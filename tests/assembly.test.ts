import { it, expect } from 'vitest';
import { PDFDocument, StandardFonts, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { assemblePacks } from '../functions/src/assemble';
import { planPack } from '../app/src/render/domain';
import { selectPackJobs } from '../app/src/render/pack-selection';
import { defaultPack, type Person, type PackSettings } from '../app/src/types';

it.each(['fit', 'actual', '2up', '4up'] as const)(
  'stamps each content side and cover at physical sheet size, leaving padding blank (%s)',
  async (scaling) => {
    const source = await PDFDocument.create();
    for (let i = 0; i < 3; i++) source.addPage([595.276, 841.89]).drawText('Session content');
    const settings: PackSettings = {
      ...defaultPack(),
      scaling,
      sides: 'duplexShort',
      coverSheet: true,
      templates: [{ templateId: 't', copies: 1 }],
    };
    const plan = planPack(settings, { t: 3 });
    const pdf = await PDFDocument.load(
      await assemblePacks(
        [
          {
            person: { id: 'person', name: 'Person', pack: settings },
            plan,
            documents: new Map([['t', await source.save()]]),
            templates: [],
            sessionName: 'Session',
            eventName: 'Event',
            dateTime: 'Date',
            timeZone: 'Australia/Brisbane',
          },
        ],
        true,
        '2026-11-01T04:56:07Z',
      ),
    );
    expect(pdf.getPageCount()).toBe(plan.sides.length);
    for (const [index, side] of plan.sides.entries()) {
      const streams = pdf.getPage(index).node.Contents() as PDFArray | undefined;
      if (side.kind === 'blank') {
        expect(streams).toBeUndefined();
        continue;
      }
      const content = Array.from({ length: streams!.size() }, (_, i) =>
        Buffer.from(decodePDFRawStream(streams!.lookup(i, PDFRawStream)).decode()).toString(),
      ).join('\n');
      // One unscaled physical-sheet footer, independent of imposed page/copy count.
      expect(content.match(/1 0 0 1 [-\d.]+ 12 Tm/g)).toHaveLength(1);
    }
  },
);

it.each(['single', 'duplexLong', 'duplexShort'] as const)(
  'assembles one person-wide cover with a blank back (%s)',
  async (sides) => {
    const source = await PDFDocument.create();
    source.addPage([595.276, 841.89]).drawText('Session content');
    const documents = new Map([['t', await source.save()]]);
    const people: Person[] = ['a', 'b'].map((id) => ({
      id,
      name: `Person ${id}`,
      pack: {
        ...defaultPack(),
        enabled: true,
        sides,
        coverSheet: true,
        sessionIds: ['morning', 'evening'],
        templates: [{ templateId: 't', copies: 1 }],
      },
    }));
    const packs = selectPackJobs(people, [{ id: 'morning' }, { id: 'evening' }]).map((j) => ({
      person: j.person,
      plan: planPack(j.person.pack, { t: 1 }, j.coverSheet),
      documents,
      templates: [],
      sessionName: j.session.id,
      eventName: 'Whole event',
      dateTime: 'Date',
    }));
    const pdf = await PDFDocument.load(await assemblePacks(packs, true));
    expect(pdf.getPageCount()).toBe(12);
    for (const index of [0, 6]) {
      expect(pdf.getPage(index).node.Contents()).toBeDefined();
      expect(pdf.getPage(index + 1).node.Contents()).toBeUndefined();
    }
  },
);
it('embeds every source page and preserves duplex sheet boundaries', async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++)
    source.addPage([595.276, 841.89]).drawText('Page ' + (i + 1), { font, x: 40, y: 700 });
  const person: Person = {
    id: 'test',
    name: 'Test Producer',
    pack: {
      ...defaultPack(),
      enabled: true,
      templates: [{ templateId: 't', copies: 1 }],
      sides: 'duplexShort',
    },
  };
  const pack = {
    person,
    plan: planPack(person.pack, { t: 3 }),
    documents: new Map([['t', await source.save()]]),
    templates: [],
    sessionName: 'Session',
    eventName: 'Event',
    dateTime: 'Date',
  };
  const pdf = await PDFDocument.load(await assemblePacks([pack], true));
  expect(pdf.getPageCount()).toBe(4);
  expect(pdf.getPage(1).getRotation().angle).toBe(180);
  const single = {
    ...person,
    pack: { ...person.pack, sides: 'single' as const, scaling: '2up' as const },
  };
  const combined = await PDFDocument.load(
    await assemblePacks(
      [pack, { ...pack, person: single, plan: planPack(single.pack, { t: 3 }) }],
      true,
    ),
  );
  expect(combined.getPageCount()).toBe(8);
});

it.each([
  ['fit', 'duplexLong', false, false],
  ['fit', 'duplexLong', true, false],
  ['fit', 'duplexShort', false, false],
  ['fit', 'duplexShort', true, false],
  ['actual', 'duplexLong', false, false],
  ['actual', 'duplexShort', true, false],
  ['fit', 'duplexLong', false, true],
  ['actual', 'duplexLong', false, true],
] as const)(
  'rotates a mixed-orientation back: %s, %s, combined=%s, landscape front=%s',
  async (scaling, sides, combined, landscapeFront) => {
    const portrait: [number, number] = [595.276, 841.89],
      landscape: [number, number] = [841.89, 595.276];
    const documents = new Map<string, Uint8Array>();
    for (const [id, size] of [
      ['portrait', portrait],
      ['landscape', landscape],
    ] as const) {
      const source = await PDFDocument.create();
      source.addPage(size).drawText(id, { x: 40, y: 40 });
      documents.set(id, await source.save());
    }
    const pack: PackSettings = {
      ...defaultPack(),
      templates: (landscapeFront ? ['landscape', 'portrait'] : ['portrait', 'landscape']).map(
        (templateId) => ({ templateId, copies: 1 }),
      ),
      sides,
      scaling,
      newSheetPerTemplate: false,
      coverSheet: false,
    };
    const pdf = await PDFDocument.load(
      await assemblePacks(
        [
          {
            person: { id: 'test', name: 'Test', pack },
            plan: planPack(pack, { portrait: 1, landscape: 1 }),
            documents,
            templates: [],
            sessionName: 'Session',
            eventName: 'Event',
            dateTime: 'Date',
          },
        ],
        combined,
      ),
    );
    expect(pdf.getPageCount()).toBe(2);
    const size = landscapeFront ? landscape : portrait;
    for (const page of pdf.getPages()) expect([page.getWidth(), page.getHeight()]).toEqual(size);
    expect(pdf.getPage(1).getRotation().angle).toBe(combined && sides === 'duplexShort' ? 180 : 0);
    for (const [index, page] of pdf.getPages().entries()) {
      const streams = page.node.Contents() as PDFArray;
      const content = Array.from({ length: streams.size() }, (_, i) =>
        Buffer.from(decodePDFRawStream(streams.lookup(i, PDFRawStream)).decode()).toString(),
      ).join('\n');
      const matrices = [
        ...content.matchAll(
          /([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) cm/g,
        ),
      ].map((m) => m.slice(1).map(Number));
      expect(
        matrices.some(
          (m) => Math.abs(m[0]) < 1e-10 && m[1] === 1 && m[2] === -1 && Math.abs(m[3]) < 1e-10,
        ),
      ).toBe(index === 1);
      const expectedScale =
        scaling === 'actual'
          ? 1
          : Math.min((size[0] - 22.68) / size[0], (size[1] - 22.68) / size[1]);
      expect(
        matrices.some(
          (m) => Math.abs(m[0] - expectedScale) < 1e-10 && Math.abs(m[3] - expectedScale) < 1e-10,
        ),
      ).toBe(true);
    }
  },
);
