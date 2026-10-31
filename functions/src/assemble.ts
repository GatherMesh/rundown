import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  Duplex,
  PrintScaling,
  type PDFFont,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackSettings, PlannedPack, Person, Template } from '../../app/src/types';
export interface PackDocument {
  person: Person;
  plan: PlannedPack;
  documents: Map<string, Uint8Array>;
  templates: Template[];
  sessionName: string;
  eventName: string;
  dateTime: string;
}
const A4: [number, number] = [595.276, 841.89];
export async function assemblePacks(packs: PackDocument[], combined: boolean): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  let font: PDFFont;
  try {
    font = await output.embedFont(
      await readFile(join(__dirname, '../assets/inter-latin-400-normal.woff')),
      { subset: true },
    );
  } catch {
    font = await output.embedFont(StandardFonts.Helvetica);
  }
  for (const pack of packs) {
    const embedded = new Map<string, Awaited<ReturnType<typeof output.embedPdf>>>();
    for (const [id, bytes] of pack.documents) {
      const source = await PDFDocument.load(bytes);
      embedded.set(id, await output.embedPdf(source, source.getPageIndices()));
    }
    if (combined && output.getPageCount() % 2) output.addPage(A4);
    let frontSize: [number, number] = A4;
    for (let index = 0; index < pack.plan.sides.length; index++) {
      const side = pack.plan.sides[index];
      const duplex = pack.person.pack.sides !== 'single';
      const nup =
        pack.person.pack.scaling === '4up' ? 4 : pack.person.pack.scaling === '2up' ? 2 : 1;
      let size: [number, number] = frontSize;
      if (side.kind === 'pages') {
        const first = embedded.get(side.cells[0].templateId)![side.cells[0].page - 1];
        const landscape = first.width > first.height !== (nup === 2);
        size = landscape ? [A4[1], A4[0]] : A4;
        if (duplex && index % 2) size = frontSize;
      } else if (side.kind === 'cover') size = A4;
      if (!duplex || index % 2 === 0) frontSize = size;
      const page = output.addPage(size);
      const [width, height] = size;
      if (side.kind === 'cover') {
        const text = (value: string, y: number, fontSize: number) => {
          const max = width - 88;
          let lines = [''];
          for (const word of value.split(' ')) {
            const last = lines.length - 1,
              next = `${lines[last]} ${word}`.trim();
            if (font.widthOfTextAtSize(next, fontSize) > max && lines[last]) lines.push(word);
            else lines[last] = next;
          }
          lines.forEach((line, i) =>
            page.drawText(line, {
              x: 44,
              y: y - i * (fontSize + 7),
              font,
              size: fontSize,
              color: rgb(0.09, 0.1, 0.12),
            }),
          );
          return y - lines.length * (fontSize + 7);
        };
        let y = text('Session pack', height - 70, 14);
        y = text(pack.person.name, y - 24, 30);
        if (pack.person.role) y = text(pack.person.role, y - 6, 14);
        y = text(pack.sessionName, y - 35, 20);
        y = text(pack.eventName, y - 10, 14);
        y = text(pack.dateTime, y - 10, 12);
        y -= 35;
        for (const ref of pack.person.pack.templates)
          y = text(
            `${pack.templates.find((t) => t.id === ref.templateId)?.name ?? 'Template'} ×${ref.copies}`,
            y - 10,
            13,
          );
      }
      if (side.kind === 'pages')
        for (let cellIndex = 0; cellIndex < side.cells.length; cellIndex++) {
          const cell = side.cells[cellIndex],
            source = embedded.get(cell.templateId)![cell.page - 1];
          const cols = nup === 1 ? 1 : 2,
            rows = nup === 4 ? 2 : 1,
            cellWidth = width / cols,
            cellHeight = height / rows;
          const border = pack.person.pack.scaling === 'actual' ? 0 : 11.34;
          const availableWidth = cellWidth - 2 * border,
            availableHeight = cellHeight - 2 * border;
          let scale =
              pack.person.pack.scaling === 'actual'
                ? 1
                : Math.min(availableWidth / source.width, availableHeight / source.height),
            rotate = false;
          // Both sides share the front's paper size; turn a mismatched back to fit it.
          if (nup > 1 || (duplex && index % 2)) {
            const alternative = Math.min(
              availableWidth / source.height,
              availableHeight / source.width,
            );
            if (
              alternative > Math.min(availableWidth / source.width, availableHeight / source.height)
            ) {
              if (pack.person.pack.scaling !== 'actual') scale = alternative;
              rotate = true;
            }
          }
          const drawnWidth = (rotate ? source.height : source.width) * scale,
            drawnHeight = (rotate ? source.width : source.height) * scale;
          let x = (cellIndex % cols) * cellWidth + (cellWidth - drawnWidth) / 2,
            y =
              height -
              (Math.floor(cellIndex / cols) + 1) * cellHeight +
              (cellHeight - drawnHeight) / 2;
          if (rotate) x += drawnWidth;
          page.drawPage(source, {
            x,
            y,
            xScale: scale,
            yScale: scale,
            rotate: degrees(rotate ? 90 : 0),
          });
          page.drawText(
            `copy ${cell.copy} of ${pack.person.pack.templates.find((t) => t.templateId === cell.templateId)!.copies}`,
            {
              x: (cellIndex % cols) * cellWidth + border + 4,
              y: height - (Math.floor(cellIndex / cols) + 1) * cellHeight + border + 2,
              size: 7,
              font,
              color: rgb(0.35, 0.38, 0.44),
            },
          );
        }
      if (combined && pack.person.pack.sides === 'duplexShort' && index % 2)
        page.setRotation(degrees(180));
      if (combined && pack.person.pack.sides === 'single') output.addPage(size);
    }
    if (combined && output.getPageCount() % 2) output.addPage(frontSize);
  }
  const prefs = output.catalog.getOrCreateViewerPreferences();
  prefs.setPrintScaling(PrintScaling.None);
  prefs.setDuplex(
    combined
      ? Duplex.DuplexFlipLongEdge
      : packs[0]?.person.pack.sides === 'single'
        ? Duplex.Simplex
        : packs[0]?.person.pack.sides === 'duplexShort'
          ? Duplex.DuplexFlipShortEdge
          : Duplex.DuplexFlipLongEdge,
  );
  output.setTitle(combined ? 'Session packs' : `${packs[0]?.person.name} — Session pack`);
  output.setCreator('Rundown');
  return output.save();
}
