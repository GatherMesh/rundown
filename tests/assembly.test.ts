import { it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { assemblePacks } from '../functions/src/assemble';
import { planPack } from '../app/src/render/domain';
import { defaultPack, type Person } from '../app/src/types';
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
