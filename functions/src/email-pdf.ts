import { PDFArray, PDFDocument, Duplex, degrees } from 'pdf-lib';
import { HttpsError } from 'firebase-functions/v2/https';

export async function emailPdf(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  // Print-padding sides have no content streams; keep every rendered page and cover.
  for (let i = pdf.getPageCount() - 1; i >= 0; i--) {
    const contents = pdf.getPage(i).node.Contents();
    if (!contents || (contents instanceof PDFArray && contents.size() === 0)) pdf.removePage(i);
    // The assembler rotates short-edge backs for printers; digital pages stay upright.
    else pdf.getPage(i).setRotation(degrees(0));
  }
  if (!pdf.getPageCount())
    throw new HttpsError('failed-precondition', 'The PDF has no content pages.');
  pdf.catalog.getOrCreateViewerPreferences().setDuplex(Duplex.Simplex);
  return Buffer.from(await pdf.save());
}
