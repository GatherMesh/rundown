import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { Timestamp } from 'firebase/firestore';
import { useWorkspace } from '../app/src/stores/workspace';
import seed from '../reference/seed.json';
import type { Template } from '../app/src/types';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  commit: vi.fn(),
  batchDelete: vi.fn(),
  callable: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../app/src/boot/firebase', () => ({
  db: {},
  functions: {},
  storage: {},
  auth: {},
  emulator: true,
}));
vi.mock('quasar', () => ({ Notify: { create: mocks.notify } }));
vi.mock('firebase/functions', () => ({ httpsCallable: () => mocks.callable }));
vi.mock('firebase/firestore', async (original) => {
  const actual = await original<typeof import('firebase/firestore')>();
  const ref = (base: { path?: string }, ...parts: string[]) => ({
    path: [base.path, ...parts].filter(Boolean).join('/'),
  });
  return {
    ...actual,
    doc: ref,
    collection: ref,
    query: (r: unknown) => r,
    onSnapshot: vi.fn(() => vi.fn()),
    getDocsFromServer: mocks.read,
    deleteDoc: mocks.remove,
    updateDoc: mocks.update,
    writeBatch: () => ({ delete: mocks.batchDelete, commit: mocks.commit }),
  };
});

const sessionPath = 'tenants/a/events/event/sessions/session';
function snapshot(paths: string[], data: Record<string, unknown>[] = []) {
  const docs = paths.map((path, i) => ({
    ref: { path },
    id: path.split('/').at(-1),
    data: () => data[i],
  }));
  return { docs, size: docs.length };
}
function setup() {
  const w = useWorkspace();
  w.tenantId = 'a';
  w.eventId = 'event';
  w.sessionId = 'session';
  w.role = 'editor';
  w.sessions = ['session', 'next'].map((id) => ({
    id,
    name: id,
    startAt: Timestamp.now(),
    sortKey: Timestamp.now(),
    itemCount: 0,
  }));
  w.templates = [{ ...seed.templates[0], id: 'template' } as Template];
  return w;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  setActivePinia(createPinia());
  mocks.commit.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.callable.mockResolvedValue({ data: { deleted: true } });
});
afterEach(() => vi.unstubAllGlobals());

it('deletes every server item and the session in one batch, then selects the next session', async () => {
  const w = setup();
  mocks.read.mockResolvedValue(snapshot([`${sessionPath}/items/a`, `${sessionPath}/items/b`]));
  await w.removeSession('session');
  expect(mocks.batchDelete.mock.calls.map(([ref]) => ref.path)).toEqual([
    `${sessionPath}/items/a`,
    `${sessionPath}/items/b`,
    sessionPath,
  ]);
  expect(mocks.commit).toHaveBeenCalledOnce();
  expect(w.sessionId).toBe('next');
  expect(w.items).toEqual([]);
});
it('clears the selection when deleting the last session', async () => {
  const w = setup();
  w.sessions = w.sessions.slice(0, 1);
  mocks.read.mockResolvedValue(snapshot([]));
  await w.removeSession('session');
  expect(w.sessionId).toBe('');
  expect(w.session).toBeUndefined();
});
it.each([499, 500])('uses the correct deletion path for %i items', async (count) => {
  const w = setup();
  mocks.read.mockResolvedValue(
    snapshot(Array.from({ length: count }, (_, i) => `${sessionPath}/items/${i}`)),
  );
  await w.removeSession('session');
  if (count === 499) {
    expect(mocks.batchDelete).toHaveBeenCalledTimes(500);
    expect(mocks.callable).not.toHaveBeenCalled();
  } else {
    expect(mocks.callable).toHaveBeenCalledWith({
      tenantId: 'a',
      eventId: 'event',
      sessionId: 'session',
    });
    expect(mocks.commit).not.toHaveBeenCalled();
  }
});
it('keeps session selection and data when deletion fails', async () => {
  const w = setup();
  mocks.read.mockResolvedValue(snapshot([]));
  mocks.commit.mockRejectedValue(new Error('Failed'));
  await expect(w.removeSession('session')).rejects.toThrow('Failed');
  expect(w.sessionId).toBe('session');
  expect(w.sessions).toHaveLength(2);
});
it('does not switch the user back if they navigate during deletion', async () => {
  const w = setup();
  mocks.read.mockImplementation(async () => {
    w.eventId = 'different-event';
    w.sessionId = 'different-session';
    return snapshot([]);
  });
  await w.removeSession('session');
  expect(w.sessionId).toBe('different-session');
  expect(mocks.batchDelete).toHaveBeenCalledWith({ path: sessionPath });
});
it('blocks deletion of a template used in a disabled pack in another event', async () => {
  const w = setup();
  mocks.read
    .mockResolvedValueOnce(snapshot(['tenants/a/events/event', 'tenants/a/events/other']))
    .mockResolvedValueOnce(snapshot([]))
    .mockResolvedValueOnce(
      snapshot(
        ['tenants/a/events/other/people/person'],
        [{ pack: { enabled: false, templates: [{ templateId: 'template', copies: 1 }] } }],
      ),
    );
  expect(await w.removeTemplate('template')).toBe(false);
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(w.templates).toHaveLength(1);
});
it('flushes a pending edit before deleting an unused template', async () => {
  const w = setup();
  w.patchTemplate('template', { name: 'Renamed' });
  mocks.read.mockResolvedValue(snapshot([]));
  expect(await w.removeTemplate('template')).toBe(true);
  expect(mocks.update).toHaveBeenCalledOnce();
  expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.remove.mock.invocationCallOrder[0],
  );
  expect(mocks.remove).toHaveBeenCalledWith({ path: 'tenants/a/templates/template' });
  expect(w.templates).toEqual([]);
});
it('does not delete a template when usage cannot be checked online', async () => {
  const w = setup();
  mocks.read.mockRejectedValue(new Error('Offline'));
  await expect(w.removeTemplate('template')).rejects.toThrow('Offline');
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('rejects viewer deletion before any reads or writes', async () => {
  const w = setup();
  w.role = 'viewer';
  await expect(w.removeSession('session')).rejects.toThrow('Editor access required');
  await expect(w.removeTemplate('template')).rejects.toThrow('Editor access required');
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
