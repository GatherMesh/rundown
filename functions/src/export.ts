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
import { selectPackJobs } from '../../app/src/render/pack-selection';
import { packRevision, requiresReprint, type PrintRecord } from '../../app/src/render/reprints';
import { packSchema } from './api-contract';
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
    sessionId = data.sessionId === undefined ? undefined : id(data.sessionId, 'session'),
    personId = all ? undefined : id(data.personId, 'person'),
    jobId = id(data.jobId, 'job'),
    reprintsOnly = data.reprintsOnly === true,
    printedAt = new Date().toISOString();
  if (data.reprintsOnly !== undefined && typeof data.reprintsOnly !== 'boolean')
    throw new HttpsError('invalid-argument', 'Invalid reprint selection.');
  if (reprintsOnly && (!all || sessionId))
    throw new HttpsError('invalid-argument', 'Reprints must use the event-wide export.');
  const root = db.doc(`tenants/${tenantId}`),
    eventRef = root.collection('events').doc(eventId);
  const membership = await root.collection('members').doc(uid).get();
  if (!['owner', 'editor', 'viewer'].includes(membership.data()?.role))
    throw new HttpsError('permission-denied', 'You are not a member of this organisation.');
  const job = root.collection('exportJobs').doc(jobId);
  let browser: Browser | undefined;
  let jobCreated = false;
  try {
    await job.create({
      status: 'running',
      message: 'Loading session packs…',
      createdAt: new Date(),
      createdBy: uid,
    });
    jobCreated = true;
    const [tenantDoc, eventDoc, sessionDocs, categoryDocs, templateDocs, peopleDocs] =
      await Promise.all([
        root.get(),
        eventRef.get(),
        eventRef.collection('sessions').orderBy('sortKey').get(),
        root.collection('categories').get(),
        root.collection('templates').get(),
        eventRef.collection('people').get(),
      ]);
    if (!tenantDoc.exists || !eventDoc.exists)
      throw new HttpsError('not-found', 'The event no longer exists.');
    if (sessionId && !sessionDocs.docs.some((s) => s.id === sessionId))
      throw new HttpsError('not-found', 'The session no longer exists.');
    const tenant = tenantDoc.data()!,
      event = eventDoc.data()!;
    const people = peopleDocs.docs.map((d) => ({ id: d.id, ...d.data() }) as Person),
      templates = templateDocs.docs.map((d) => ({ id: d.id, ...d.data() }) as Template);
    if (personId && !people.some((p) => p.id === personId))
      throw new HttpsError('not-found', 'The person no longer exists.');
    const candidates = people.filter((p) =>
      personId ? p.id === personId : reprintsOnly || p.pack.enabled,
    );
    for (const p of candidates)
      if (!packSchema.shape.sessionIds.safeParse(p.pack.sessionIds).success)
        throw new HttpsError('failed-precondition', `Check the pack settings for ${p.name}.`);
    let jobs = reprintsOnly
      ? candidates.flatMap((p) =>
          selectPackJobs([p], sessionDocs.docs, p.id).map((j) => ({ ...j, coverSheet: false })),
        )
      : selectPackJobs(candidates, sessionDocs.docs, personId, sessionId);
    const records = reprintsOnly
      ? (await eventRef.collection('printRecords').get()).docs.map((d) => d.data() as PrintRecord)
      : [];
    if (reprintsOnly)
      jobs = jobs.filter((j) =>
        records.some((r) => r.personId === j.person.id && r.sessionId === j.session.id),
      );
    if (!jobs.length)
      throw new HttpsError(
        'failed-precondition',
        'Enable at least one session for a person’s pack.',
      );
    if (jobs.length > 450)
      throw new HttpsError('resource-exhausted', 'Print up to 450 person/session packs at a time.');
    const recipients = [...new Set(jobs.map((j) => j.person))];
    if (recipients.length > 100 || new Set(jobs.map((j) => j.session.id)).size > 100)
      throw new HttpsError(
        'resource-exhausted',
        'Export up to 100 people and 100 sessions at a time.',
      );
    for (const p of recipients) {
      if (!packSchema.safeParse(p.pack).success || !p.pack.templates.length)
        throw new HttpsError(
          'failed-precondition',
          `Check the templates and pack settings for ${p.name}.`,
        );
      for (const ref of p.pack.templates)
        if (!templates.some((t) => t.id === ref.templateId))
          throw new HttpsError(
            'failed-precondition',
            `Check the templates and copy counts for ${p.name}.`,
          );
    }
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
    const sessionItems = new Map<string, ReturnType<typeof computeItems>>();
    for (const { session } of jobs) {
      if (sessionItems.has(session.id)) continue;
      const itemDocs = await session.ref.collection('items').orderBy('order').limit(501).get();
      if (itemDocs.size > 500)
        throw new HttpsError('resource-exhausted', 'Export up to 500 items per session.');
      const items = computeItems(
        itemDocs.docs.map((d) => ({ id: d.id, ...d.data() }) as Item),
        categoryDocs.docs.map((d) => ({ id: d.id, ...d.data() }) as Category),
        people,
      );
      sessionItems.set(session.id, items);
    }
    const makePayload = (
      person: Person,
      sessionDoc: (typeof sessionDocs.docs)[number],
      template: Template,
    ): RenderPayload => {
      const session = sessionDoc.data();
      return {
        tenant: { name: tenant.name },
        event: { name: event.name, timeZone: event.timeZone },
        session: {
          name: session.name,
          subtitle: session.subtitle,
          startAt: session.startAt.toDate().toISOString(),
        },
        items: sessionItems.get(sessionDoc.id)!,
        template,
        recipient: { id: person.id, name: person.name, role: person.role },
      };
    };
    const revisions: PrintRecord[] = [];
    for (const { person, session } of jobs) {
      const revision = await packRevision(
        person.pack.templates.map((ref) =>
          makePayload(
            person,
            session,
            templates.find((t) => t.id === ref.templateId)!,
          ),
        ),
        person.pack,
        event.logo ?? tenant.logo,
      );
      revisions.push({ personId: person.id, sessionId: session.id, revision, printedAt });
    }
    if (reprintsOnly) {
      jobs = jobs.filter((j) =>
        requiresReprint(
          records.find((r) => r.personId === j.person.id && r.sessionId === j.session.id),
          revisions.find((r) => r.personId === j.person.id && r.sessionId === j.session.id)!
            .revision,
        ),
      );
      if (!jobs.length) throw new HttpsError('failed-precondition', 'No reprints are required.');
    }
    for (const items of sessionItems.values())
      for (const item of items)
        if (item.imageSlide)
          item.imageSlide = { ...item.imageSlide, url: await resolveImage(item.imageSlide) };
    const [tenantLogo, eventLogo] = await Promise.all([
      resolveImage(tenant.logo),
      resolveImage(event.logo),
    ]);
    const printPath = join(__dirname, '../print/src/render/print.html'),
      printHtml = await readFile(printPath, 'utf8');
    const docsTotal = jobs.reduce((n, j) => n + j.person.pack.templates.length, 0);
    let rendered = 0;
    const packs: PackDocument[] = [],
      warnings = new Set<string>();
    const memoryCache = new Map<string, { bytes: Uint8Array; count: number }>();
    for (const { person, session: sessionDoc, coverSheet } of jobs) {
      const session = sessionDoc.data();
      const documents = new Map<string, Uint8Array>(),
        counts: Record<string, number> = {};
      for (const ref of person.pack.templates) {
        const template = templates.find((t) => t.id === ref.templateId)!;
        const payload = makePayload(person, sessionDoc, template);
        payload.tenant.logoUrl = tenantLogo;
        payload.event.logoUrl = eventLogo;
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
      const plan = planPack(person.pack, counts, coverSheet);
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
        timeZone: event.timeZone,
      });
    }
    await job.update({ message: 'Assembling print-ready packs…' });
    const combined = all || !sessionId;
    const bytes = await assemblePacks(packs, combined, printedAt),
      path = `tenants/${tenantId}/exports/${sessionId ?? 'event'}/${all ? 'all' : recipients[0].id}-${jobId}.pdf`;
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
      eventId,
      ...(personId && !sessionId
        ? { fullPackPersonId: personId, personName: recipients[0].name, eventName: event.name }
        : {}),
      revisions: revisions.filter((r) =>
        jobs.some((j) => j.person.id === r.personId && j.session.id === r.sessionId),
      ),
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

// Only acknowledge the server's rendered snapshot, never a client-supplied revision.
export async function confirmPrinted(uid: string, input: Record<string, unknown>) {
  const tenantId = id(input.tenantId, 'organisation'),
    jobId = id(input.jobId, 'job');
  const db = getFirestore(),
    root = db.doc(`tenants/${tenantId}`);
  if (
    !['owner', 'editor', 'viewer'].includes(
      (await root.collection('members').doc(uid).get()).data()?.role,
    )
  )
    throw new HttpsError('permission-denied', 'You are not a member of this organisation.');
  const jobRef = root.collection('exportJobs').doc(jobId);
  await db.runTransaction(async (tx) => {
    const job = (await tx.get(jobRef)).data();
    if (!job || job.createdBy !== uid || job.status !== 'complete' || !job.revisions?.length)
      throw new HttpsError('failed-precondition', 'This print job is not ready to confirm.');
    if (job.printConfirmedAt) return;
    const revisions = job.revisions as PrintRecord[];
    // Bound the transaction; large exports can be split into smaller print jobs.
    if (revisions.length > 450)
      throw new HttpsError(
        'resource-exhausted',
        'Confirm up to 450 person/session packs at a time.',
      );
    const refs = revisions.map((r) =>
      root
        .collection('events')
        .doc(job.eventId)
        .collection('printRecords')
        .doc(
          createHash('sha256')
            .update(JSON.stringify([r.personId, r.sessionId]))
            .digest('hex'),
        ),
    );
    const previous = await tx.getAll(...refs);
    revisions.forEach((revision, index) => {
      if (!previous[index].exists || previous[index].data()!.printedAt <= revision.printedAt)
        tx.set(refs[index], revision);
    });
    tx.update(jobRef, { printConfirmedAt: new Date() });
  });
  return { confirmed: true };
}
