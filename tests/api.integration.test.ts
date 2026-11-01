import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PDFDocument } from 'pdf-lib';
import seed from '../reference/seed.json';
import { computeItems } from '../app/src/render/domain';
import { packRevision } from '../app/src/render/reprints';
import type { Category, Item, Person, Template } from '../app/src/types';

const projectId = 'demo-rundown';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST)
  throw new Error('Run API integration tests through npm run test:api (emulators only).');
const app = initializeApp({ projectId, storageBucket: 'demo-rundown.appspot.com' }, 'api-tests');
const db = getFirestore(app),
  auth = getAuth(app);
const base = `http://127.0.0.1:5001/${projectId}/australia-southeast1/api/v1`;
const prefix = `api-test-${randomUUID()}`;
const users: Record<string, { uid: string; token: string }> = {};
const tenants: string[] = [];
let tenantId: string;
const pack = {
  enabled: false,
  templates: [],
  sides: 'single',
  scaling: 'fit',
  collate: true,
  newSheetPerTemplate: true,
  coverSheet: false,
};
const ev = {
  name: 'Event',
  startDate: '2027-03-27',
  endDate: '2027-03-28',
  timeZone: 'Australia/Brisbane',
};
const scope = () => ({ tenantId, eventId: 'event', sessionId: 'session' });
async function callable(name: string, data: unknown, role = 'owner') {
  const response = await fetch(base.replace('/api/v1', `/${name}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users[role].token}` },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, ...(await response.json()) };
}
async function request(operation: string, args: unknown, role = 'owner', status = 200) {
  const response = await fetch(`${base}/${operation}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(users[role] ? { Authorization: `Bearer ${users[role].token}` } : {}),
    },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
beforeAll(async () => {
  for (const role of ['owner', 'editor', 'viewer', 'outsider', 'newmember']) {
    const uid = `${prefix}-${role}`,
      email = `${uid}@example.com`;
    await auth.createUser({ uid, email, password: 'test-password-42' });
    const response = await fetch(
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-password-42', returnSecureToken: true }),
      },
    );
    const body = await response.json();
    if (!body.idToken) throw new Error('Emulator sign-in failed');
    users[role] = { uid, token: body.idToken };
  }
}, 30_000);
beforeEach(async () => {
  tenantId = `${prefix}-${tenants.length}`;
  tenants.push(tenantId);
  const root = db.doc(`tenants/${tenantId}`),
    batch = db.batch();
  batch.set(root, { name: 'API test', createdBy: users.owner.uid, createdAt: Timestamp.now() });
  for (const role of ['owner', 'editor', 'viewer'])
    batch.set(root.collection('members').doc(users[role].uid), { role });
  batch.set(root.collection('categories').doc('category'), {
    name: 'Spoken',
    bg: '#ffffff',
    fg: '#000000',
    order: 0,
  });
  batch.set(root.collection('events').doc('event'), ev);
  const session = root.collection('events').doc('event').collection('sessions').doc('session');
  const stamp = Timestamp.fromDate(new Date('2027-03-27T19:00:00+10:00'));
  batch.set(session, { name: 'Session', startAt: stamp, sortKey: stamp, itemCount: 0 });
  batch.set(root.collection('events').doc('event').collection('people').doc('person'), {
    name: 'Person',
    pack,
  });
  await batch.commit();
});
afterAll(async () => {
  for (const id of tenants) {
    await db.recursiveDelete(db.doc(`tenants/${id}`));
    await getStorage(app)
      .bucket()
      .deleteFiles({ prefix: `tenants/${id}/` });
  }
  for (const user of Object.values(users)) {
    await auth.deleteUser(user.uid);
    await db.doc(`users/${user.uid}`).delete();
  }
  await deleteApp(app);
}, 30_000);

it('exposes schema discovery and requires real Firebase authentication and membership', async () => {
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  expect(spec.paths['/items_create']).toBeDefined();
  await request('events_list', { tenantId }, 'none', 401);
  await request('events_list', { tenantId }, 'outsider', 403);
  await request('events_list', { tenantId }, 'viewer');
  await request(
    'events_update',
    { tenantId, id: 'event', data: { name: 'Changed' } },
    'viewer',
    403,
  );
  await request('events_update', { tenantId, id: 'event', data: { name: 'Changed' } }, 'editor');
  await request('tenants_update', { id: tenantId, data: { name: 'Changed' } }, 'editor', 403);
  await request('events_list', { tenantId: `${tenantId}/../other` }, 'owner', 400);
  await request('constructor', {}, 'owner', 404);
});
it('creates organisations atomically, manages members and synchronizes discovery profiles', async () => {
  const created = await request('tenants_create', { data: { name: 'New' } });
  tenants.push(created.id);
  const ownerMembership = await db.doc(`tenants/${created.id}/members/${users.owner.uid}`).get();
  expect(ownerMembership.data()?.role).toBe('owner');
  await request('members_set', { tenantId: created.id, uid: users.newmember.uid, role: 'editor' });
  const listed = await request('tenants_list', {}, 'newmember');
  expect(listed.records.some((r: { id: string }) => r.id === created.id)).toBe(true);
  await request('members_set', { tenantId, uid: users.editor.uid, role: 'owner' }, 'editor', 403);
  await request('members_remove', { tenantId, uid: users.owner.uid }, 'owner', 409);
  await request('members_remove', { tenantId: created.id, uid: users.newmember.uid });
  expect((await request('tenants_list', {}, 'newmember')).records).toHaveLength(0);
  await request('events_list', { tenantId: created.id }, 'newmember', 403);
  await request('tenants_delete', { id: created.id });
  expect((await db.doc(`tenants/${created.id}`).get()).exists).toBe(false);
});
it('preserves counts under concurrent edits and computes timing after reordering', async () => {
  const [a, b] = await Promise.all(
    [60, 120].map((durationSec) =>
      request(
        'items_create',
        {
          ...scope(),
          data: { title: 'Cue', durationSec, categoryId: 'category', personIds: ['person'] },
        },
        'editor',
      ),
    ),
  );
  const ref = db.doc(`tenants/${tenantId}/events/event/sessions/session`);
  expect((await ref.get()).data()?.itemCount).toBe(2);
  await request('items_reorder', { ...scope(), id: b.id, beforeId: a.id });
  const rundown = await request('sessions_rundown', scope(), 'viewer');
  expect(rundown.items.map((i: { id: string }) => i.id)).toEqual([b.id, a.id]);
  expect(rundown.items.map((i: { startSec: number }) => i.startSec)).toEqual([0, 120]);
  expect(rundown.endAt).toBe('2027-03-27T09:03:00.000Z');
  expect(rundown.runtimeSec).toBe(180);
  expect((await ref.collection('items').doc(a.id).get()).data()?.startSec).toBeUndefined();
  const duplicate = await request('items_duplicate', { ...scope(), id: a.id });
  expect((await ref.get()).data()?.itemCount).toBe(3);
  await request('items_delete', { ...scope(), id: duplicate.id });
  expect((await ref.get()).data()?.itemCount).toBe(2);
  await request('items_delete', { ...scope(), id: duplicate.id }, 'owner', 404);
  expect((await ref.get()).data()?.itemCount).toBe(2);
}, 30_000);
it('validates references, time zones, dates and rejects forged derived/audit data', async () => {
  await request(
    'items_create',
    { ...scope(), data: { title: 'Bad', durationSec: 60, categoryId: 'missing' } },
    'owner',
    404,
  );
  await request(
    'items_create',
    {
      ...scope(),
      data: { title: 'Bad', durationSec: 60, categoryId: 'category', personIds: ['missing'] },
    },
    'owner',
    404,
  );
  await request(
    'items_create',
    {
      ...scope(),
      data: { title: 'Bad', durationSec: 60, categoryId: 'category', updatedBy: users.owner.uid },
    },
    'owner',
    400,
  );
  await request(
    'events_update',
    { tenantId, id: 'event', data: { timeZone: 'Bad/Time' } },
    'owner',
    400,
  );
  await request(
    'events_update',
    { tenantId, id: 'event', data: { endDate: '2026-01-01' } },
    'owner',
    400,
  );
  await request(
    'sessions_update',
    { tenantId, eventId: 'event', id: 'session', data: { itemCount: 7 } },
    'owner',
    400,
  );
  await request('sessions_update', {
    tenantId,
    eventId: 'event',
    id: 'session',
    data: { startAt: '2027-03-28T09:00:00+10:00' },
  });
  const session = (await db.doc(`tenants/${tenantId}/events/event/sessions/session`).get()).data()!;
  expect(session.sortKey.isEqual(session.startAt)).toBe(true);
});
it('protects category/template references and atomically removes person assignments', async () => {
  const item = await request('items_create', {
    ...scope(),
    data: { title: 'Cue', durationSec: 60, categoryId: 'category', personIds: ['person'] },
  });
  await request('categories_delete', { tenantId, id: 'category' }, 'owner', 409);
  await request('people_delete', { tenantId, eventId: 'event', id: 'person' }, 'owner', 409);
  await request('people_delete', {
    tenantId,
    eventId: 'event',
    id: 'person',
    removeAssignments: true,
  });
  expect((await request('items_get', { ...scope(), id: item.id })).personIds).toEqual([]);
  const { id, ...data } = seed.templates[0];
  const template = await request('templates_create', { tenantId, data });
  const person = await request('people_create', {
    tenantId,
    eventId: 'event',
    data: { name: 'New person' },
  });
  await request('packs_set', {
    tenantId,
    eventId: 'event',
    personId: person.id,
    pack: { ...pack, enabled: true, templates: [{ templateId: template.id, copies: 2 }] },
  });
  await request('templates_delete', { tenantId, id: template.id }, 'owner', 409);
  const copy = await request('templates_duplicate', { tenantId, id: template.id });
  await request('templates_delete', { tenantId, id: copy.id });
});
it('duplicates and moves sessions with assignments, then deletes the complete item subtree', async () => {
  await request('items_create', {
    ...scope(),
    data: { title: 'Cue', durationSec: 60, categoryId: 'category', personIds: ['person'] },
  });
  const copy = await request('sessions_duplicate', { tenantId, eventId: 'event', id: 'session' });
  expect(copy.itemCount).toBe(1);
  const target = await request('events_create', { tenantId, data: { ...ev, name: 'Destination' } });
  const move = await request('sessions_move', {
    tenantId,
    eventId: 'event',
    id: copy.id,
    destinationEventId: target.id,
  });
  expect((await db.doc(`tenants/${tenantId}/events/event/sessions/${copy.id}`).get()).exists).toBe(
    false,
  );
  const rundown = await request('sessions_rundown', {
    tenantId,
    eventId: target.id,
    sessionId: move.id,
  });
  expect(rundown.items[0].people[0].name).toBe('Person');
  await request('events_delete', { tenantId, id: target.id }, 'owner', 409);
  await request('sessions_delete', { tenantId, eventId: target.id, id: move.id });
  expect(
    (await db.collection(`tenants/${tenantId}/events/${target.id}/sessions/${move.id}/items`).get())
      .size,
  ).toBe(0);
  await request('people_delete', {
    tenantId,
    eventId: target.id,
    id: rundown.items[0].people[0].id,
  });
  await request('events_delete', { tenantId, id: target.id });
});
it('paginates without losing records and does not write under missing parents', async () => {
  for (let i = 0; i < 3; i++)
    await request('categories_create', {
      tenantId,
      data: { name: `C${i}`, bg: '#ffffff', fg: '#000000', order: i + 1 },
    });
  const first = await request('categories_list', { tenantId, limit: 2 });
  const second = await request('categories_list', { tenantId, limit: 2, after: first.nextCursor });
  expect(new Set([...first.records, ...second.records].map((r) => r.id)).size).toBe(4);
  expect(second.nextCursor).toBeNull();
  await request(
    'items_create',
    {
      ...scope(),
      sessionId: 'missing',
      data: { title: 'Cue', durationSec: 60, categoryId: 'category' },
    },
    'owner',
    404,
  );
});
it('uploads, attaches, downloads and detaches images without cross-tenant access', async () => {
  const image = {
    tenantId,
    eventId: 'event',
    name: 'pixel.png',
    contentType: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=',
  };
  await request('assets_upload', image, 'viewer', 403);
  const uploaded = await request('assets_upload', image, 'editor');
  expect(uploaded.width).toBe(1);
  const event = await request('events_get', { tenantId, id: 'event' });
  expect(event.logo.path).toBe(uploaded.path);
  expect((await fetch(event.logo.url)).status).toBe(200);
  const download = await fetch(
    `${base}/files?${new URLSearchParams({ tenantId, path: uploaded.path })}`,
    { headers: { Authorization: `Bearer ${users.viewer.token}` } },
  );
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer()).toString('base64')).toBe(image.base64);
  const denied = await fetch(
    `${base}/files?${new URLSearchParams({ tenantId, path: 'tenants/other/logo/file.png' })}`,
    { headers: { Authorization: `Bearer ${users.owner.token}` } },
  );
  expect(denied.status).toBe(400);
  await request(
    'events_update',
    { tenantId, id: 'event', data: { logo: { ...uploaded, path: 'tenants/other/logo/file.png' } } },
    'owner',
    400,
  );
  await request('assets_remove', { tenantId, eventId: 'event' });
  expect((await request('events_get', { tenantId, id: 'event' })).logo).toBeNull();
});
it('renders PDFs through both API and existing callable exports, preserving completed jobs on ID reuse', async () => {
  const { id, ...data } = seed.templates[0];
  const template = await request('templates_create', { tenantId, data });
  await request('items_create', {
    ...scope(),
    data: { title: 'API PDF cue', durationSec: 60, categoryId: 'category', personIds: ['person'] },
  });
  await request('packs_set', {
    tenantId,
    eventId: 'event',
    personId: 'person',
    pack: { ...pack, enabled: true, templates: [{ templateId: template.id, copies: 1 }] },
  });
  const result = await request('exports_render', { ...scope(), personId: 'person' }, 'viewer');
  expect(result.pages).toBe(1);
  expect((await request('exports_get', { tenantId, jobId: result.jobId }, 'viewer')).status).toBe(
    'complete',
  );
  const response = await fetch(
    `${base}/files?${new URLSearchParams({ tenantId, path: result.path })}`,
    { headers: { Authorization: `Bearer ${users.viewer.token}` } },
  );
  expect((await PDFDocument.load(await response.arrayBuffer())).getPageCount()).toBe(1);
  const url = base.replace('/api/v1', '/renderPack');
  const invoke = (jobId: string) =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${users.viewer.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: { ...scope(), personId: 'person', jobId } }),
    });
  const jobId = randomUUID();
  expect((await invoke(jobId)).status).toBe(200);
  expect((await invoke(jobId)).ok).toBe(false);
  expect((await request('exports_get', { tenantId, jobId })).status).toBe('complete');
}, 120_000);
it('exports each person’s selected sessions individually, together, and globally', async () => {
  const { id, ...data } = seed.templates[0];
  const template = await request('templates_create', { tenantId, data });
  await request('items_create', {
    ...scope(),
    data: { title: 'Selected session cue', durationSec: 60, categoryId: 'category' },
  });
  const second = await request('sessions_duplicate', { tenantId, eventId: 'event', id: 'session' });
  await request('sessions_update', {
    tenantId,
    eventId: 'event',
    id: second.id,
    data: { name: 'Second session', startAt: '2027-03-28T19:00:00+10:00' },
  });
  const settings = {
    ...pack,
    enabled: true,
    templates: [{ templateId: template.id, copies: 1 }],
    sessionIds: ['session', second.id],
  };
  await request('packs_set', { tenantId, eventId: 'event', personId: 'person', pack: settings });
  const other = await request('people_create', {
    tenantId,
    eventId: 'event',
    data: { name: 'Other person', pack: { ...settings, sessionIds: [second.id] } },
  });
  await request('people_create', {
    tenantId,
    eventId: 'event',
    data: { name: 'Disabled person', pack: { ...settings, enabled: false } },
  });
  const individual = await request('exports_render', { ...scope(), personId: 'person' }, 'viewer');
  expect(individual).toMatchObject({ sourcePages: 1, sheets: 1, pages: 1 });
  const person = await request(
    'exports_render',
    { tenantId, eventId: 'event', personId: 'person' },
    'viewer',
  );
  expect(person).toMatchObject({ sourcePages: 2, sheets: 2, pages: 4 });
  const all = await request('exports_render', { tenantId, eventId: 'event' }, 'viewer');
  expect(all).toMatchObject({ sourcePages: 3, sheets: 3, pages: 6 });
  const [bytes] = await getStorage(app).bucket().file(all.path).download();
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(6);
  await request('exports_render', { ...scope(), personId: other.id }, 'viewer', 409);
  await request('packs_set', {
    tenantId,
    eventId: 'event',
    personId: 'person',
    pack: { ...settings, sessionIds: [] },
  });
  await request(
    'exports_render',
    { tenantId, eventId: 'event', personId: 'person' },
    'viewer',
    409,
  );
  const remaining = await request('exports_render', { tenantId, eventId: 'event' }, 'viewer');
  expect(remaining).toMatchObject({ sourcePages: 1, sheets: 1, pages: 2 });
}, 120_000);

it('connects the built stdio MCP server to the real API', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp/dist/index.js'],
    env: { ...process.env, RUNDOWN_API_URL: base, RUNDOWN_ID_TOKEN: users.owner.token } as Record<
      string,
      string
    >,
  });
  const client = new Client({ name: 'integration', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'rundown_events_list', arguments: { tenantId } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: { records: [{ id: 'event', name: 'Event' }] },
    });
  } finally {
    await client.close();
  }
}, 30_000);

it('preserves seed image placeholders when editing and duplicating existing items', async () => {
  const ref = db.doc(`tenants/${tenantId}/events/event/sessions/session/items/seed`);
  await ref.set({
    title: 'Seed',
    durationSec: 60,
    categoryId: 'category',
    personIds: [],
    av: {},
    order: 'a0',
    imageSlide: {
      path: 'seed/slide.png',
      name: 'slide.png',
      width: 1920,
      height: 1080,
      contentType: 'image/png',
    },
  });
  await db.doc(`tenants/${tenantId}/events/event/sessions/session`).update({ itemCount: 1 });
  await request('items_update', { ...scope(), id: 'seed', data: { title: 'Updated' } });
  const copy = await request('items_duplicate', { ...scope(), id: 'seed' });
  expect(copy.imageSlide.path).toBe('seed/slide.png');
});
it('refuses oversized atomic mutations without partially deleting data', async () => {
  const session = db.doc(`tenants/${tenantId}/events/event/sessions/session`);
  const batch = db.batch();
  for (let i = 0; i < 450; i++)
    batch.set(session.collection('items').doc(String(i)), { title: 'Cue' });
  batch.update(session, { itemCount: 450 });
  await batch.commit();
  await request('sessions_delete', { tenantId, eventId: 'event', id: 'session' }, 'owner', 429);
  expect((await session.get()).exists).toBe(true);
  expect((await session.collection('items').get()).size).toBe(450);
}, 30_000);
it('rejects revoked Firebase ID tokens on subsequent API requests', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await request('auth_revoke', {}, 'newmember');
  await request('tenants_list', {}, 'newmember', 401);
});

it('tracks confirmed printed snapshots and reprints complete affected sessions only', async () => {
  const root = db.doc(`tenants/${tenantId}`),
    event = root.collection('events').doc('event');
  const template = {
    ...seed.templates[0],
    id: 'report',
    itemStyle: 'cueCard',
    filter: { scope: 'recipient', categoryIds: null },
  } as Template;
  await root.collection('templates').doc('report').set(template);
  const settings = {
    ...pack,
    enabled: true,
    sessionIds: ['session', 'later'],
    templates: [{ templateId: 'report', copies: 1 }],
  };
  const people: Person[] = ['person', 'other'].map((id) => ({
    id,
    name: id,
    pack: settings as Person['pack'],
  }));
  const items: Item[] = people.map((p, i) => ({
    id: p.id,
    title: `Cue for ${p.name}`,
    durationSec: 60,
    order: `a${i}`,
    categoryId: 'category',
    personIds: [p.id],
    av: {},
  }));
  items.push({
    ...items[0],
    id: 'unchanged',
    title: 'Unchanged cue in the same session',
    order: 'a2',
  });
  for (const p of people) await event.collection('people').doc(p.id).set(p);
  for (const [index, sessionId] of ['session', 'later'].entries()) {
    const session = event.collection('sessions').doc(sessionId),
      startAt = Timestamp.fromMillis(1806145200000 + index * 86400000);
    await session.set({ name: sessionId, startAt, sortKey: startAt, itemCount: items.length });
    for (const item of items) await session.collection('items').doc(item.id).set(item);
  }
  const printRecords = event.collection('printRecords');
  const exportJob = async (extra = {}) => {
    const jobId = randomUUID();
    const response = await callable('renderAllPacks', {
      tenantId,
      eventId: 'event',
      jobId,
      ...extra,
    });
    expect(response.status, JSON.stringify(response)).toBe(200);
    return {
      jobId,
      result: response.result,
      job: (await root.collection('exportJobs').doc(jobId).get()).data()!,
    };
  };
  const initial = await exportJob();
  expect(initial.result.sourcePages).toBe(6);
  expect((await printRecords.get()).empty).toBe(true); // Rendering/previewing cannot clear or establish print history.
  const category = (await root.collection('categories').doc('category').get()).data()!;
  const session = (await event.collection('sessions').doc('session').get()).data()!;
  const clientRevision = await packRevision(
    [
      {
        tenant: { name: 'API test', logoUrl: 'https://example.com/client-url' },
        event: { name: ev.name, timeZone: ev.timeZone },
        session: { name: 'session', startAt: session.startAt.toDate().toISOString() },
        template,
        recipient: { id: 'person', name: 'person' },
        items: computeItems(items, [{ id: 'category', ...category } as Category], people),
      },
    ],
    people[0].pack,
  );
  expect(
    initial.job.revisions.find((r: any) => r.personId === 'person' && r.sessionId === 'session')
      .revision,
  ).toBe(clientRevision);
  expect(
    (await callable('confirmPrint', { tenantId, jobId: initial.jobId }, 'viewer')).status,
  ).toBe(400); // Cannot confirm someone else's job.
  expect(
    (await callable('confirmPrint', { tenantId, jobId: initial.jobId }, 'outsider')).status,
  ).toBe(403);
  expect((await callable('confirmPrint', { tenantId, jobId: initial.jobId })).status).toBe(200);
  expect((await printRecords.get()).size).toBe(4);
  expect((await callable('confirmPrint', { tenantId, jobId: initial.jobId })).status).toBe(200); // Idempotent.
  await event
    .collection('sessions')
    .doc('session')
    .collection('items')
    .doc('person')
    .update({ title: 'Updated cue' });
  // A person printed individually still needs updates when excluded from global Print All.
  await event.collection('people').doc('person').update({ 'pack.enabled': false });
  const reprint = await exportJob({ reprintsOnly: true });
  expect(reprint.result.sourcePages).toBe(2); // The unchanged cue is reprinted too.
  expect(reprint.job.revisions.map((r: any) => [r.personId, r.sessionId])).toEqual([
    ['person', 'session'],
  ]);
  // An edit made after this PDF was generated must survive its confirmation.
  await event
    .collection('sessions')
    .doc('session')
    .collection('items')
    .doc('person')
    .update({ script: 'New script while printing' });
  await callable('confirmPrint', { tenantId, jobId: reprint.jobId });
  const latest = await exportJob({ reprintsOnly: true });
  expect(latest.job.revisions).toHaveLength(1);
  await callable('confirmPrint', { tenantId, jobId: latest.jobId });
  expect(
    (
      await callable('renderAllPacks', {
        tenantId,
        eventId: 'event',
        jobId: randomUUID(),
        reprintsOnly: true,
      })
    ).status,
  ).toBe(400);
  // A previously unconfirmed older print job cannot roll back the recorded version.
  const old = { ...initial.job, printConfirmedAt: undefined };
  delete old.printConfirmedAt;
  const oldJob = randomUUID();
  await root.collection('exportJobs').doc(oldJob).set(old);
  await callable('confirmPrint', { tenantId, jobId: oldJob });
  expect(
    (
      await callable('renderAllPacks', {
        tenantId,
        eventId: 'event',
        jobId: randomUUID(),
        reprintsOnly: true,
      })
    ).status,
  ).toBe(400);
}, 120_000);
