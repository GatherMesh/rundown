import { expect, it } from 'vitest';
import { PDFDocument, Duplex } from 'pdf-lib';
import { emailPdf } from '../functions/src/email-pdf';
import { assemblePacks } from '../functions/src/assemble';
import { planPack } from '../app/src/render/domain';
import { defaultPack, type PackSettings } from '../app/src/types';

it.each(['single', 'duplexLong', 'duplexShort'] as const)(
  'removes all padding sides from a multi-session pack, preserving content and cover (%s)',
  async (sides) => {
    const source = await PDFDocument.create();
    for (let i = 0; i < 3; i++) source.addPage().drawText(`Content ${i}`);
    const settings: PackSettings = {
      ...defaultPack(),
      sides,
      coverSheet: true,
      templates: [{ templateId: 't', copies: 2 }],
    };
    const pack = {
      person: { id: 'p', name: 'Recipient', pack: settings },
      plan: planPack(settings, { t: 3 }, true),
      documents: new Map([['t', await source.save()]]),
      templates: [],
      sessionName: 'Morning',
      eventName: 'Event',
      dateTime: 'Date',
    };
    const original = await assemblePacks(
      [pack, { ...pack, sessionName: 'Evening', plan: planPack(settings, { t: 3 }, false) }],
      true,
    );
    const print = await PDFDocument.load(original);
    expect(print.getPageCount()).toBeGreaterThan(13);
    const bytes = await emailPdf(original);
    const attachment = await PDFDocument.load(bytes);
    expect(attachment.getPageCount()).toBe(13); // one cover plus 3 pages × 2 copies × 2 sessions
    expect(attachment.getPages().every((page) => !!page.node.Contents())).toBe(true);
    expect(attachment.getPages().every((page) => page.getRotation().angle === 0)).toBe(true);
    expect(attachment.catalog.getOrCreateViewerPreferences().getDuplex()).toBe(Duplex.Simplex);
    expect((await PDFDocument.load(original)).getPageCount()).toBe(print.getPageCount());
    expect(await emailPdf(original)).toEqual(bytes); // identical payloads for Resend retries
  },
);
it('keeps graphics-only and text pages in order and preserves their dimensions', async () => {
  const original = await PDFDocument.create();
  original.addPage();
  original.addPage([800, 600]).drawRectangle({ x: 50, y: 50, width: 100, height: 100 });
  original.addPage();
  original.addPage([600, 800]).drawText('Last page');
  const attachment = await PDFDocument.load(await emailPdf(await original.save()));
  expect(attachment.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
    [800, 600],
    [600, 800],
  ]);
});
it('rejects a PDF with only blank pages', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  await expect(emailPdf(await pdf.save())).rejects.toMatchObject({ code: 'failed-precondition' });
});
