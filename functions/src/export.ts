import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument } from 'pdf-lib';
import { computeItems, planPack } from '../../app/src/render/domain';
import type { Category, Item, Person, Template, StoredImage } from '../../app/src/types';
import type { RenderPayload } from '../../app/src/render/renderer';
import { assemblePacks, type PackDocument } from './assemble';
const bucket = () => getStorage().bucket();
function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new HttpsError('invalid-argument', `Invalid ${name}.`);
  return value;
}
export async function exportPacks(uid: string, input: Record<string, unknown>, all: boolean) {
  const db = getFirestore();
  const data = input,
    tenantId = id(data.tenantId, 'organisation'),
    eventId = id(data.eventId, 'event'),
    sessionId = id(data.sessionId, 'session'),
    jobId = id(data.jobId, 'job');
  const root = db.doc(`tenants/${tenantId}`),
    eventRef = root.collection('events').doc(eventId),
    sessionRef = eventRef.collection('sessions').doc(sessionId);
  const membership = await root.collection('members').doc(uid).get();
  if (!['owner', 'editor', 'viewer'].includes(membership.data()?.role))
    throw new HttpsError('permission-denied', 'You are not a member of this organisation.');
  const job = root.collection('exportJobs').doc(jobId);
  let browser: Browser | undefined;
  let jobCreated = false;
  try {
    await job.create({
      status: 'running',
      message: 'Loading session…',
      createdAt: new Date(),
      createdBy: uid,
    });
    jobCreated = true;
    const [tenantDoc, eventDoc, sessionDoc, itemDocs, categoryDocs, templateDocs, peopleDocs] =
      await Promise.all([
        root.get(),
        eventRef.get(),
        sessionRef.get(),
        sessionRef.collection('items').orderBy('order').get(),
        root.collection('categories').get(),
        root.collection('templates').get(),
        eventRef.collection('people').get(),
      ]);
    if (!tenantDoc.exists || !eventDoc.exists || !sessionDoc.exists)
      throw new HttpsError('not-found', 'The event or session no longer exists.');
    const tenant = tenantDoc.data()!,
      event = eventDoc.data()!,
      session = sessionDoc.data()!;
    const people = peopleDocs.docs.map((d) => ({ id: d.id, ...d.data() }) as Person),
      templates = templateDocs.docs.map((d) => ({ id: d.id, ...d.data() }) as Template);
    const recipients = all
      ? people.filter((p) => p.pack.enabled)
      : people.filter((p) => p.id === id(data.personId, 'person'));
    if (!recipients.length)
      throw new HttpsError('failed-precondition', 'Enable at least one person’s pack.');
    if (recipients.length > 100 || itemDocs.size > 500)
      throw new HttpsError(
        'resource-exhausted',
        'Export up to 100 recipients and 500 items at a time.',
      );
    for (const p of recipients) {
      if (!p.pack.templates.length || p.pack.templates.length > 20)
        throw new HttpsError('failed-precondition', `Choose 1–20 templates for ${p.name}.`);
      for (const ref of p.pack.templates)
        if (
          !Number.isInteger(ref.copies) ||
          ref.copies < 1 ||
          ref.copies > 20 ||
          !templates.some((t) => t.id === ref.templateId)
        )
          throw new HttpsError(
            'failed-precondition',
            `Check the templates and copy counts for ${p.name}.`,
          );
    }
    const items = computeItems(
      itemDocs.docs.map((d) => ({ id: d.id, ...d.data() }) as Item),
      categoryDocs.docs.map((d) => ({ id: d.id, ...d.data() }) as Category),
      people,
    );
    const imageCache = new Map<string, Promise<string | undefined>>();
    const resolveImage = (image?: StoredImage): Promise<string | undefined> => {
      if (!image?.path || image.path.startsWith('seed/')) return Promise.resolve(undefined);
      if (!image.path.startsWith(`tenants/${tenantId}/`))
        throw new HttpsError('permission-denied', 'An image belongs to a different organisation.');
      if (!imageCache.has(image.path))
        imageCache.set(
          image.path,
          (async () => {
            const file = bucket().file(image.path);
            const [exists] = await file.exists();
            if (!exists) return undefined;
            const [meta] = await file.getMetadata();
            if (
              Number(meta.size) > 10 * 1024 * 1024 ||
              !['image/png', 'image/jpeg'].includes(meta.contentType ?? '')
            )
              throw new HttpsError(
                'failed-precondition',
                'An image has an unsupported format or size.',
              );
            const [bytes] = await file.download();
            return `data:${meta.contentType};base64,${bytes.toString('base64')}`;
          })(),
        );
      return imageCache.get(image.path)!;
    };
    for (const item of items)
      if (item.imageSlide)
        item.imageSlide = { ...item.imageSlide, url: await resolveImage(item.imageSlide) };
    const [tenantLogo, eventLogo] = await Promise.all([
      resolveImage(tenant.logo),
      resolveImage(event.logo),
    ]);
    const printPath = join(__dirname, '../print/src/render/print.html'),
      printHtml = await readFile(printPath, 'utf8');
    const docsTotal = recipients.reduce((n, p) => n + p.pack.templates.length, 0);
    let rendered = 0;
    const packs: PackDocument[] = [],
      warnings = new Set<string>();
    const memoryCache = new Map<string, { bytes: Uint8Array; count: number }>();
    for (const person of recipients) {
      const documents = new Map<string, Uint8Array>(),
        counts: Record<string, number> = {};
      for (const ref of person.pack.templates) {
        const template = templates.find((t) => t.id === ref.templateId)!;
        const payload: RenderPayload = {
          tenant: { name: tenant.name, logoUrl: tenantLogo },
          event: { name: event.name, timeZone: event.timeZone, logoUrl: eventLogo },
          session: {
            name: session.name,
            subtitle: session.subtitle,
            startAt: session.startAt.toDate().toISOString(),
          },
          items,
          template,
          recipient: { id: person.id, name: person.name, role: person.role },
        };
        const hash = createHash('sha256')
            .update(printHtml)
            .update(JSON.stringify(payload))
            .digest('hex'),
          cacheFile = bucket().file(`tenants/${tenantId}/exports/cache/${hash}.pdf`);
        let cached = memoryCache.get(hash);
        if (!cached) {
          const [exists] = await cacheFile.exists();
          if (exists) {
            const [bytes] = await cacheFile.download();
            cached = { bytes, count: (await PDFDocument.load(bytes)).getPageCount() };
          } else {
            if (!browser) {
              const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
              const executablePath =
                process.env.CHROME_EXECUTABLE_PATH ||
                (process.env.FUNCTIONS_EMULATOR === 'true' && existsSync(localChrome)
                  ? localChrome
                  : await chromium.executablePath());
              browser = await puppeteer.launch({
                executablePath,
                args: process.env.FUNCTIONS_EMULATOR === 'true' ? ['--no-sandbox'] : chromium.args,
                headless: true,
              });
            }
            const page = await browser.newPage();
            try {
              await page.setRequestInterception(true);
              page.on('request', (r) => {
                if (r.url().startsWith('data:') || r.url().startsWith('about:')) void r.continue();
                else void r.abort();
              });
              await page.setContent(printHtml, { waitUntil: 'load' });
              await page.waitForFunction('typeof window.renderRundown === "function"');
              const result = await page.evaluate(
                async (p) => {
                  const win = window as unknown as {
                    renderRundown: (p: unknown) => Promise<void>;
                    __RENDER_DONE: { pageCount: number; warning: string | null };
                  };
                  await win.renderRundown(p);
                  return win.__RENDER_DONE;
                },
                JSON.parse(JSON.stringify(payload)),
              );
              if (result.warning) warnings.add(result.warning);
              const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
              cached = { bytes, count: result.pageCount };
              await cacheFile.save(Buffer.from(bytes), {
                contentType: 'application/pdf',
                metadata: { metadata: { warning: result.warning ?? '' } },
              });
            } finally {
              await page.close().catch(() => {});
            }
          }
          memoryCache.set(hash, cached);
        }
        documents.set(ref.templateId, cached.bytes);
        counts[ref.templateId] = cached.count;
        rendered++;
        await job.update({
          message: `Rendering ${rendered} of ${docsTotal} documents…`,
          completed: rendered,
          total: docsTotal,
        });
      }
      const plan = planPack(person.pack, counts);
      if (plan.sides.length > 1000)
        throw new HttpsError(
          'resource-exhausted',
          'This pack exceeds 1,000 printed sides. Reduce copies.',
        );
      packs.push({
        person,
        plan,
        documents,
        templates,
        sessionName: session.name,
        eventName: event.name,
        dateTime: new Intl.DateTimeFormat('en-AU', {
          timeZone: event.timeZone,
          dateStyle: 'full',
          timeStyle: 'short',
        }).format(session.startAt.toDate()),
      });
    }
    await job.update({ message: 'Assembling print-ready packs…' });
    const bytes = await assemblePacks(packs, all),
      path = `tenants/${tenantId}/exports/${sessionId}/${all ? 'all' : recipients[0].id}-${jobId}.pdf`;
    await bucket()
      .file(path)
      .save(Buffer.from(bytes), {
        contentType: 'application/pdf',
        metadata: { cacheControl: 'private, max-age=300' },
      });
    await job.update({
      status: 'complete',
      message: 'Session packs ready',
      path,
      completedAt: new Date(),
    });
    return {
      path,
      sourcePages: packs.reduce((n, p) => n + p.plan.pages, 0),
      pages: (await PDFDocument.load(bytes)).getPageCount(),
      sheets: packs.reduce((n, p) => n + p.plan.sheets, 0),
      warning: [...warnings].join(' · '),
    };
  } catch (e) {
    if (jobCreated)
      await job
        .set(
          {
            status: 'failed',
            message: e instanceof HttpsError ? e.message : 'PDF export failed. Try again.',
            completedAt: new Date(),
          },
          { merge: true },
        )
        .catch(() => {});
    if (e instanceof HttpsError) throw e;
    console.error('PDF export failed', e);
    throw new HttpsError('internal', 'PDF export failed. Try again or check the function logs.');
  } finally {
    await browser?.close().catch(() => {});
  }
}
