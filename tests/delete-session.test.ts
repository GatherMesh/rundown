import { beforeEach, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { deleteSessionData } from '../functions/src/delete-session';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  commit: vi.fn(),
  remove: vi.fn(),
  member: vi.fn(),
}));
vi.mock('firebase-admin/firestore', async (original) => {
  const actual = await original<typeof import('firebase-admin/firestore')>();
  return {
    ...actual,
    getFirestore: () => ({
      doc: (path: string) => ({
        path,
        get: mocks.member,
        collection: () => ({ limit: () => ({ get: mocks.get }) }),
      }),
      batch: () => ({ delete: mocks.remove, commit: mocks.commit }),
    }),
  };
});
const request = {
  auth: { uid: 'editor' },
  data: { tenantId: 'a', eventId: 'e', sessionId: 's' },
} as CallableRequest;
function rows(count: number) {
  return {
    size: count,
    docs: Array.from({ length: count }, (_, i) => ({ ref: { path: `items/${i}` } })),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.member.mockResolvedValue({ data: () => ({ role: 'editor' }) });
  mocks.commit.mockResolvedValue(undefined);
});
it('deletes a large session in bounded batches, deleting the parent last', async () => {
  mocks.get.mockResolvedValueOnce(rows(499)).mockResolvedValueOnce(rows(2));
  await expect(deleteSessionData(request)).resolves.toEqual({ deleted: true });
  expect(mocks.commit).toHaveBeenCalledTimes(2);
  expect(mocks.remove).toHaveBeenCalledTimes(502);
  expect(mocks.remove).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: 'tenants/a/events/e/sessions/s' }),
  );
});
it('retains the parent if a batch fails so deletion can be retried', async () => {
  mocks.get.mockResolvedValue(rows(499));
  mocks.commit.mockRejectedValue(new Error('Failed'));
  await expect(deleteSessionData(request)).rejects.toThrow('Failed');
  expect(
    mocks.remove.mock.calls.some(([ref]) => ref.path === 'tenants/a/events/e/sessions/s'),
  ).toBe(false);
});
it.each(['viewer', undefined])('rejects non-editors (%s)', async (role) => {
  mocks.member.mockResolvedValue({ data: () => ({ role }) });
  await expect(deleteSessionData(request)).rejects.toMatchObject({ code: 'permission-denied' });
  expect(mocks.get).not.toHaveBeenCalled();
});
it('rejects unauthenticated and malformed requests', async () => {
  await expect(deleteSessionData({ data: request.data } as CallableRequest)).rejects.toMatchObject({
    code: 'unauthenticated',
  });
  await expect(
    deleteSessionData({ ...request, data: { ...request.data, sessionId: '../other' } }),
  ).rejects.toMatchObject({ code: 'invalid-argument' });
  expect(mocks.get).not.toHaveBeenCalled();
});
