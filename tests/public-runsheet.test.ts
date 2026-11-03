import { beforeEach, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import seed from '../reference/seed.json';
import { createRunsheetLink, getPublicRunsheet } from '../functions/src/public-runsheet';
import { computeItems } from '../app/src/render/domain';
import { renderRunsheet, type RenderPayload } from '../app/src/render/renderer';
import type { Category, Item, Person, Template } from '../app/src/types';

const m = vi.hoisted(() => ({ docs: new Map<string, Record<string, any>>(), storage: vi.fn() }));
vi.mock('firebase-admin/firestore', () => {
  function doc(path: string): any {
    return {
      path,
      id: path.split('/').at(-1),
      collection: (name: string) => collection(`${path}/${name}`),
      get: async () => ({
        id: path.split('/').at(-1),
        ref: doc(path),
        exists: m.docs.has(path),
        data: () => m.docs.get(path),
      }),
    };
  }
  function collection(path: string): any {
    return {
      doc: (id: string) => doc(`${path}/${id}`),
      orderBy: () => collection(path),
      limit: () => collection(path),
      get: async () => {
        const paths = [...m.docs.keys()].filter(
          (p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'),
        );
        return { docs: await Promise.all(paths.map((p) => doc(p).get())), size: paths.length };
      },
    };
  }
  return {
    getFirestore: () => ({
      doc,
      getAll: (...refs: any[]) => Promise.all(refs.map((r) => r.get())),
      runTransaction: async (fn: any) =>
        fn({
          get: (ref: any) => ref.get(),
          create: (ref: any, value: any) => m.docs.set(ref.path, value),
        }),
    }),
  };
});
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ file: m.storage }) }),
  getDownloadURL: async () => 'https://example.com/canonical-slide.png',
}));

const base = 'tenants/a',
  event = `${base}/events/e`,
  personPath = `${event}/people/p`;
const linkPath = `${event}/runsheetLinks/p`;
const token = 'a'.repeat(48);
const scope = { tenantId: 'a', eventId: 'e', personId: 'p' };
const request = (data: Record<string, unknown>, uid?: string) =>
  ({ data, auth: uid ? { uid } : undefined }) as CallableRequest;
const publicRequest = (extra = {}) => request({ ...scope, token, ...extra });
const template = (): Template => ({
  ...(structuredClone(seed.templates[0]) as Template),
  id: 't',
  name: 'My runsheet',
  columns: [
    { key: 'title', visible: true, width: '1fr' },
    { key: 'start', visible: true, width: 'auto' },
    { key: 'notes', visible: true, width: 'auto' },
    { key: 'script', visible: false, width: 'auto' },
  ],
  filter: { scope: 'recipient', categoryIds: null },
});
beforeEach(() => {
  m.docs.clear();
  m.storage.mockReset();
  m.docs.set(base, { name: 'Organisation', createdBy: 'owner' });
  m.docs.set(`${base}/members/editor`, { role: 'editor' });
  m.docs.set(`${base}/members/viewer`, { role: 'viewer' });
  m.docs.set(event, { name: 'Event', timeZone: 'Australia/Brisbane' });
  m.docs.set(linkPath, { token });
  m.docs.set(personPath, {
    name: 'Recipient',
    role: 'Speaker',
    email: 'private@example.com',
    pack: {
      ...seed.people[0].pack,
      enabled: false,
      sessionIds: ['morning'],
      templates: [{ templateId: 't', copies: 3 }],
    },
  });
  m.docs.set(`${base}/templates/t`, template());
  m.docs.set(`${base}/categories/c`, {
    id: 'c',
    name: 'Spoken',
    bg: '#ffffff',
    fg: '#333333',
    order: 0,
  });
  for (const id of ['morning', 'afternoon']) {
    m.docs.set(`${event}/sessions/${id}`, {
      name: id,
      startAt: { toDate: () => new Date('2027-03-27T09:00:00Z') },
    });
    for (let i = 0; i < 4; i++)
      m.docs.set(`${event}/sessions/${id}/items/i${i}`, {
        order: `a${i}`,
        title: i % 2 ? 'Unshared item' : `${id} item ${i}`,
        durationSec: 60,
        categoryId: 'c',
        personIds: i % 2 ? [] : ['p'],
        notes: 'Visible notes',
        script: 'Hidden script',
        av: { audio: 'Hidden audio' },
        updatedBy: 'private-user-id',
      });
  }
});

it('creates one stable random link for an authenticated editor', async () => {
  m.docs.delete(linkPath);
  const first = await createRunsheetLink(request(scope, 'editor'));
  expect(first).toMatchObject(scope);
  expect(first.token).toMatch(/^[a-f0-9]{48}$/);
  expect(await createRunsheetLink(request(scope, 'editor'))).toEqual(first);
  expect(m.docs.get(linkPath)?.createdBy).toBe('editor');
});
it('requires editor membership to publish a link', async () => {
  for (const uid of [undefined, 'viewer', 'outsider'])
    await expect(createRunsheetLink(request(scope, uid))).rejects.toMatchObject({
      code: uid ? 'permission-denied' : 'unauthenticated',
    });
});
it('serves selected sessions without auth, independently of Print All, and renders each template once', async () => {
  const result = await getPublicRunsheet(publicRequest());
  expect(result.sessions.map((s) => s.id)).toEqual(['morning']);
  expect(result.sessionId).toBe('morning');
  expect(result.views).toHaveLength(1);
  expect(result.views[0].html.match(/morning item 0/g)).toHaveLength(1);
  expect(result.views[0].html).toContain('recipient-row');
  expect(result.views[0].html).toContain('Item 2 omitted · 1:00');
  const json = JSON.stringify(result);
  for (const hidden of [
    'Unshared item',
    'Hidden script',
    'Hidden audio',
    'private@example.com',
    'private-user-id',
    'durationSec',
    'personIds',
  ])
    expect(json).not.toContain(hidden);
});
it('loads current edits and pack selections with the existing token', async () => {
  m.docs.get(`${event}/sessions/morning/items/i0`)!.title = 'Updated title';
  expect((await getPublicRunsheet(publicRequest())).views[0].html).toContain('Updated title');
  m.docs.get(personPath)!.pack.sessionIds = ['afternoon'];
  expect((await getPublicRunsheet(publicRequest())).sessionId).toBe('afternoon');
  await expect(getPublicRunsheet(publicRequest({ sessionId: 'morning' }))).rejects.toMatchObject({
    code: 'not-found',
  });
});
it('rejects unselected sessions and wrong, missing, malformed or cross-tenant tokens', async () => {
  for (const extra of [
    { sessionId: 'afternoon' },
    { token: 'b'.repeat(48) },
    { token: undefined },
    { token: '../bad' },
    { tenantId: 'other' },
  ])
    await expect(getPublicRunsheet(publicRequest(extra))).rejects.toMatchObject({
      code: 'not-found',
    });
  await expect(getPublicRunsheet(publicRequest({ tenantId: '../a' }))).rejects.toMatchObject({
    code: 'invalid-argument',
  });
});
it.each([personPath, event, base, linkPath])(
  'stops serving a deleted resource: %s',
  async (path) => {
    m.docs.delete(path);
    await expect(getPublicRunsheet(publicRequest())).rejects.toMatchObject({ code: 'not-found' });
  },
);
it('handles empty selections, missing templates and legacy all-session packs', async () => {
  m.docs.get(personPath)!.pack.sessionIds = [];
  expect(await getPublicRunsheet(publicRequest())).toMatchObject({
    sessions: [],
    views: [],
    sessionId: null,
  });
  delete m.docs.get(personPath)!.pack.sessionIds;
  m.docs.delete(`${base}/templates/t`);
  const result = await getPublicRunsheet(publicRequest({ sessionId: 'afternoon' }));
  expect(result.sessions).toHaveLength(2);
  expect(result.sessionId).toBe('afternoon');
  expect(result.views).toEqual([]);
});
it('resolves only visible, included images and rejects a cross-tenant image', async () => {
  const image = {
    path: 'tenants/other/private.png',
    url: 'https://untrusted.example/track',
    name: 'Slide',
    width: 1,
    height: 1,
    contentType: 'image/png',
  };
  m.docs.get(`${event}/sessions/morning/items/i0`)!.imageSlide = image;
  await getPublicRunsheet(publicRequest());
  expect(m.storage).not.toHaveBeenCalled();
  m.docs
    .get(`${base}/templates/t`)!
    .columns.push({ key: 'imageSlide', visible: true, width: 'auto' });
  await expect(getPublicRunsheet(publicRequest())).rejects.toMatchObject({
    code: 'permission-denied',
  });
  image.path = 'tenants/a/slide.png';
  m.storage.mockReturnValue({
    exists: async () => [true],
    getMetadata: async () => [{ size: 123, contentType: 'image/png' }],
  });
  const result = await getPublicRunsheet(publicRequest());
  expect(result.views[0].html).toContain('https://example.com/canonical-slide.png');
  expect(result.views[0].html).not.toContain('untrusted.example');
});
it('uses shared filters and safe cells, with full unpaginated scripts on mobile', () => {
  const person = { ...m.docs.get(personPath), id: 'p' } as Person;
  const p: RenderPayload = {
    tenant: { name: 'Org' },
    event: { name: 'Event', timeZone: 'Australia/Brisbane' },
    session: { name: 'Session', startAt: '2027-03-27T09:00:00Z' },
    recipient: person,
    template: template(),
    items: computeItems(
      [0, 1, 2, 3].map(
        (i) => ({ ...m.docs.get(`${event}/sessions/morning/items/i${i}`), id: `i${i}` }) as Item,
      ),
      [],
      [person],
    ),
  };
  p.items.forEach((item, index) => {
    item.personIds = index === 1 ? ['p'] : [];
  });
  p.items[1].title = '<img src=x onerror=alert(1)>';
  p.items[1].script = '<script>alert(1)</script>\n' + 'Long script. '.repeat(3000);
  p.template.columns.find((c) => c.key === 'script')!.visible = true;
  p.template.filter.scope = 'recipientPlusNeighbours';
  const html = renderRunsheet(p);
  expect(html).toContain('Before');
  expect(html).toContain('After');
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<script>');
  expect(html.match(/Long script\./g)).toHaveLength(3000);
  expect(html).not.toContain('print-clipped');
  p.template.filter.categoryIds = ['absent'];
  expect(renderRunsheet(p)).toContain('No items match this view.');
});

const genericScope = { tenantId: 'a', eventId: 'e', sessionId: 'morning' };
it('creates a stable generic session link independently of people and templates', async () => {
  m.docs.delete(personPath);
  m.docs.delete(`${base}/templates/t`);
  const link = await createRunsheetLink(request(genericScope, 'editor'));
  expect(link).toMatchObject(genericScope);
  expect(link).not.toHaveProperty('personId');
  expect(link.token).not.toBe(token);
  expect(await createRunsheetLink(request(genericScope, 'editor'))).toEqual(link);
  expect(m.docs.get(`${event}/sessionRunsheetLinks/morning`)?.token).toBe(link.token);
  const result = await getPublicRunsheet(request(link));
  expect(result.person).toBeNull();
  expect(result.sessions.map((s) => s.id)).toEqual(['morning']);
  expect(result.views).toHaveLength(1);
  const html = result.views[0].html;
  expect(html.match(/class="print-item print-card /g)).toHaveLength(4);
  for (const text of [
    'Unshared item',
    'morning item 0',
    'Visible notes',
    'Hidden script',
    'Hidden audio',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('recipient-row');
  expect(JSON.stringify(result)).not.toContain('private-user-id');
});
it('limits generic tokens to one session and keeps person and session tokens separate', async () => {
  const link = await createRunsheetLink(request(genericScope, 'editor'));
  for (const data of [
    { ...link, sessionId: 'afternoon' },
    { ...link, eventId: 'other' },
    { ...link, tenantId: 'other' },
    { ...link, personId: 'p' },
    { ...genericScope, token },
    { ...link, token: '0'.repeat(48) },
  ])
    await expect(getPublicRunsheet(request(data))).rejects.toMatchObject({ code: 'not-found' });
});
it('requires editor membership and an existing session to create a generic link', async () => {
  for (const uid of [undefined, 'viewer', 'outsider'])
    await expect(createRunsheetLink(request(genericScope, uid))).rejects.toMatchObject({
      code: uid ? 'permission-denied' : 'unauthenticated',
    });
  await expect(
    createRunsheetLink(request({ ...genericScope, sessionId: '../invalid' }, 'editor')),
  ).rejects.toMatchObject({ code: 'invalid-argument' });
  await expect(
    createRunsheetLink(request({ ...genericScope, sessionId: 'missing' }, 'editor')),
  ).rejects.toMatchObject({ code: 'not-found' });
});
it('loads current session edits and stops serving deleted sessions through generic links', async () => {
  const link = await createRunsheetLink(request(genericScope, 'editor'));
  m.docs.get(`${event}/sessions/morning/items/i0`)!.title = 'Changed session item';
  expect((await getPublicRunsheet(request(link))).views[0].html).toContain('Changed session item');
  m.docs.delete(`${event}/sessions/morning`);
  await expect(getPublicRunsheet(request(link))).rejects.toMatchObject({ code: 'not-found' });
});
