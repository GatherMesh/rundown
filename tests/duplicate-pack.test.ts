import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkspace } from '../app/src/stores/workspace';
import { defaultPack } from '../app/src/types';

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../app/src/boot/firebase', () => ({
  db: {},
  storage: {},
  auth: {},
  functions: {},
  emulator: true,
}));
vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }));
vi.mock('firebase/firestore', async (original) => ({
  ...(await original<typeof import('firebase/firestore')>()),
  doc: (_db: unknown, path: string) => ({ path }),
  updateDoc: mocks.update,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  setActivePinia(createPinia());
  mocks.update.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const w = useWorkspace();
  w.tenantId = 'tenant';
  w.eventId = 'event';
  w.role = 'editor';
  w.people = [
    {
      id: 'source',
      name: 'Source',
      pack: {
        ...defaultPack(),
        enabled: true,
        sessionIds: ['evening', 'morning'],
        templates: [
          { templateId: 'cue', copies: 2 },
          { templateId: 'producer', copies: 1 },
        ],
        sides: 'duplexShort',
        scaling: '4up',
        collate: false,
        newSheetPerTemplate: false,
        coverSheet: true,
      },
    },
    { id: 'target', name: 'Target', role: 'Host', email: 'host@example.com', pack: defaultPack() },
  ];
  return w;
}

it('copies the complete pack to the recipient through tenant-scoped autosave', async () => {
  const w = setup();
  const identity = { ...w.people[1] };
  w.duplicatePack('source', 'target');
  expect(w.people[1]).toEqual({ ...identity, pack: w.people[0].pack });
  await w.flush();
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
    { path: 'tenants/tenant/events/event/people/target' },
    { pack: w.people[0].pack },
  );
  w.people[1].pack.templates[0].copies = 9;
  w.people[1].pack.sessionIds!.push('extra');
  expect(w.people[0].pack.templates[0].copies).toBe(2);
  expect(w.people[0].pack.sessionIds).toEqual(['evening', 'morning']);
});

it.each([undefined, []])('preserves legacy all-session or empty selection (%s)', async (ids) => {
  const w = setup();
  if (ids) w.people[0].pack.sessionIds = ids;
  else delete w.people[0].pack.sessionIds;
  w.people[1].pack.sessionIds = ['previous'];
  w.duplicatePack('source', 'target');
  await w.flush();
  expect(w.people[1].pack).toEqual(w.people[0].pack);
  expect(mocks.update.mock.calls[0][1].pack.sessionIds).toEqual(ids);
});

it.each([
  ['source', 'source'],
  ['missing', 'target'],
  ['source', 'other-event-person'],
])('rejects invalid source/recipient pairs (%s, %s)', async (source, target) => {
  const w = setup();
  const before = JSON.stringify(w.people);
  expect(() => w.duplicatePack(source, target)).toThrow('Choose another person');
  await w.flush();
  expect(JSON.stringify(w.people)).toBe(before);
  expect(mocks.update).not.toHaveBeenCalled();
});

it('blocks viewers before changing local or saved settings', async () => {
  const w = setup();
  w.role = 'viewer';
  expect(() => w.duplicatePack('source', 'target')).toThrow('Editor access required');
  expect(w.people[1].pack).toEqual(defaultPack());
  await w.flush();
  expect(mocks.update).not.toHaveBeenCalled();
});

it('retains a failed copy for retry through the existing save flow', async () => {
  const w = setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.update.mockRejectedValueOnce(new Error('Offline'));
  w.duplicatePack('source', 'target');
  await expect(w.flush()).rejects.toThrow('Changes could not be saved');
  expect(w.status).toBe('Save failed');
  await w.flush();
  expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(w.status).toBe('Saved · just now');
});
