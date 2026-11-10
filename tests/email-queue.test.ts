import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  queueEmails,
  queueExistingPack,
  retryEmailJob,
  processEmailJob,
} from '../functions/src/email-queue';
import { defaultPack } from '../app/src/types';

const m = vi.hoisted(() => ({ docs: new Map<string, any>(), render: vi.fn(), send: vi.fn() }));
vi.mock('../functions/src/export', () => ({ exportPacks: m.render }));
vi.mock('../functions/src/email-pack', async (original) => ({
  ...(await original<typeof import('../functions/src/email-pack')>()),
  sendPackEmail: m.send,
}));
vi.mock('firebase-admin/firestore', async (original) => {
  const actual = await original<typeof import('firebase-admin/firestore')>();
  const collection = (path: string): any => ({
    path,
    get parent() {
      return path.includes('/') ? doc(path.slice(0, path.lastIndexOf('/'))) : null;
    },
    doc: (id: string) => doc(`${path}/${id}`),
    get: async () => ({
      docs: await Promise.all(
        [...m.docs.keys()]
          .filter((key) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/'))
          .map((key) => doc(key).get()),
      ),
    }),
  });
  const doc = (path: string): any => ({
    path,
    id: path.split('/').at(-1),
    get parent() {
      return collection(path.slice(0, path.lastIndexOf('/')));
    },
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => {
      const value = m.docs.get(path);
      return { exists: !!value, id: path.split('/').at(-1), data: () => value };
    },
    update: async (patch: any) => {
      if (!m.docs.has(path)) throw new Error('Missing document');
      m.docs.set(path, { ...m.docs.get(path), ...patch });
    },
  });
  // Stage writes so validation failures roll the whole batch back, as Firestore does.
  const db = {
    doc,
    runTransaction: async (fn: any) => {
      const writes: (() => void)[] = [];
      const result = await fn({
        get: (ref: any) => ref.get(),
        getAll: (...refs: any[]) => Promise.all(refs.map((r) => r.get())),
        create: (ref: any, value: any) => writes.push(() => m.docs.set(ref.path, value)),
        update: (ref: any, patch: any) =>
          writes.push(() => m.docs.set(ref.path, { ...m.docs.get(ref.path), ...patch })),
      });
      writes.forEach((write) => write());
      return result;
    },
  };
  return { ...actual, getFirestore: () => db };
});
import { getFirestore } from 'firebase-admin/firestore';

const event = 'tenants/a/events/e';
const request = (extra = {}) =>
  ({
    auth: { uid: 'editor' },
    data: {
      tenantId: 'a',
      eventId: 'e',
      requestId: 'batch',
      recipients: [{ personId: 'p', email: 'person@example.com' }],
      subject: 'Briefing',
      message: 'Hello team',
      ...extra,
    },
  }) as CallableRequest;
const jobs = () => [...m.docs.entries()].filter(([key]) => key.startsWith(`${event}/emailJobs/`));
const ref = (id: string) => getFirestore().doc(`${event}/emailJobs/${id}`);
beforeEach(() => {
  vi.resetAllMocks();
  m.docs.clear();
  vi.stubEnv('PACK_EMAIL_FROM', 'Rundown <admin@mtcc.org.au>');
  vi.stubEnv('PACK_EMAIL_TENANTS', 'a');
  m.docs.set('tenants/a/members/editor', { role: 'editor' });
  m.docs.set(event, { name: 'Conference' });
  m.docs.set(`${event}/sessions/s`, { name: 'Morning' });
  m.docs.set(`${event}/people/p`, {
    name: 'Person',
    email: 'person@example.com',
    pack: { ...defaultPack(), sessionIds: ['s'], templates: [{ templateId: 't', copies: 1 }] },
  });
  m.send.mockResolvedValue({ sent: true });
  m.render.mockImplementation(async (_uid, data) =>
    m.docs.set(`tenants/a/exportJobs/${data.jobId}`, { status: 'complete' }),
  );
});
afterEach(() => vi.unstubAllEnvs());

it('atomically queues immutable recipient/content records without rendering or sending in the request', async () => {
  const result = await queueEmails(request());
  expect(result.queued).toBe(1);
  expect(jobs()[0][1]).toMatchObject({
    recipientName: 'Person',
    email: 'person@example.com',
    subject: 'Briefing',
    message: 'Hello team',
    status: 'queued',
    attempt: 1,
    createdBy: 'editor',
  });
  expect(m.render).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
  await queueEmails(request());
  expect(jobs()).toHaveLength(1);
  await expect(queueEmails(request({ subject: 'Changed' }))).rejects.toMatchObject({
    code: 'already-exists',
  });
});
it('rejects an entire selection when one saved email changed', async () => {
  await expect(
    queueEmails(
      request({
        recipients: [
          { personId: 'p', email: 'person@example.com' },
          { personId: 'other', email: 'other@example.com' },
        ],
      }),
    ),
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(jobs()).toHaveLength(0);
});
it('requires editor membership, an enabled sender and an eligible pack', async () => {
  await expect(queueEmails({ ...request(), auth: undefined })).rejects.toMatchObject({
    code: 'unauthenticated',
  });
  m.docs.set('tenants/a/members/editor', { role: 'viewer' });
  await expect(queueEmails(request())).rejects.toMatchObject({ code: 'permission-denied' });
  m.docs.set('tenants/a/members/editor', { role: 'editor' });
  vi.stubEnv('PACK_EMAIL_TENANTS', 'other');
  await expect(queueEmails(request())).rejects.toMatchObject({ code: 'failed-precondition' });
  vi.stubEnv('PACK_EMAIL_TENANTS', 'a');
  m.docs.get(`${event}/people/p`).pack.sessionIds = [];
  await expect(queueEmails(request())).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(jobs()).toHaveLength(0);
});
it.each([
  { recipients: [] },
  { subject: 'x\r\nBcc: hidden' },
  { message: 'x'.repeat(5001) },
  { recipients: [{ personId: '../other', email: 'person@example.com' }] },
  {
    recipients: Array.from({ length: 101 }, () => ({ personId: 'p', email: 'person@example.com' })),
  },
  {
    recipients: [
      { personId: 'p', email: 'person@example.com' },
      { personId: 'p', email: 'person@example.com' },
    ],
  },
])('validates queue input %o', async (extra) => {
  await expect(queueEmails(request(extra))).rejects.toMatchObject({ code: 'invalid-argument' });
  expect(jobs()).toHaveLength(0);
});
it('routes old browser sends through the same persistent queue', async () => {
  const original = request();
  original.data = {
    tenantId: 'a',
    eventId: 'e',
    personId: 'p',
    jobId: 'legacy-job',
    email: 'person@example.com',
  };
  await queueExistingPack(original);
  expect(jobs()[0][1]).toMatchObject({ subject: 'Your rundowns for Conference', status: 'queued' });
  expect(m.send).not.toHaveBeenCalled();
});
it('does not queue a duplicate when an older browser retries an email already sent before the migration', async () => {
  m.docs.set('tenants/a/exportJobs/legacy-job', {
    createdBy: 'editor',
    eventId: 'e',
    fullPackPersonId: 'p',
    emailSentTo: 'person@example.com',
  });
  const original = request();
  original.data = {
    tenantId: 'a',
    eventId: 'e',
    personId: 'p',
    jobId: 'legacy-job',
    email: 'person@example.com',
  };
  await expect(queueExistingPack(original)).resolves.toMatchObject({ sent: true, queued: 0 });
  expect(jobs()).toHaveLength(0);
});
it('renders and sends independently, acknowledges duplicate events, and never resets sent jobs on a repeated enqueue', async () => {
  const {
    jobIds: [id],
  } = await queueEmails(request());
  await processEmailJob(ref(id), 1);
  expect(m.render).toHaveBeenCalledWith(
    'editor',
    expect.objectContaining({ tenantId: 'a', eventId: 'e', personId: 'p' }),
    false,
  );
  expect(m.send.mock.calls[0][0].data).toMatchObject({
    subject: 'Briefing',
    message: 'Hello team',
    email: 'person@example.com',
  });
  expect(jobs()[0][1].status).toBe('sent');
  await processEmailJob(ref(id), 1);
  await queueEmails(request());
  expect(m.send).toHaveBeenCalledTimes(1);
  expect(jobs()[0][1].status).toBe('sent');
});
it('persists failures and retries the same PDF/send key, ignoring stale attempts and duplicate retry requests', async () => {
  const {
    jobIds: [id],
  } = await queueEmails(request());
  m.send.mockRejectedValueOnce(new HttpsError('unavailable', 'Email service unavailable'));
  await processEmailJob(ref(id), 1);
  expect(jobs()[0][1]).toMatchObject({ status: 'failed', error: 'Email service unavailable' });
  const retry = { ...request(), data: { tenantId: 'a', eventId: 'e', jobId: id, attempt: 1 } };
  await retryEmailJob(retry);
  await retryEmailJob(retry);
  expect(jobs()[0][1]).toMatchObject({ status: 'queued', attempt: 2 });
  await processEmailJob(ref(id), 1);
  expect(m.send).toHaveBeenCalledTimes(1);
  await processEmailJob(ref(id), 2);
  expect(m.render).toHaveBeenCalledTimes(1);
  expect(m.send.mock.calls[0][0].data).toEqual(m.send.mock.calls[1][0].data);
  expect(jobs()[0][1].status).toBe('sent');
});
it('recovers an expired worker lease without sending concurrently or rebuilding a completed PDF', async () => {
  const {
    jobIds: [id],
  } = await queueEmails(request());
  await ref(id).update({
    status: 'sending',
    leaseUntil: Timestamp.fromMillis(Date.now() + 60_000),
    exportJobId: 'prepared',
  });
  m.docs.set('tenants/a/exportJobs/prepared', { status: 'complete' });
  await expect(processEmailJob(ref(id), 1)).rejects.toThrow('already running');
  expect(m.send).not.toHaveBeenCalled();
  await ref(id).update({ leaseUntil: Timestamp.fromMillis(0) });
  await processEmailJob(ref(id), 1);
  expect(m.render).not.toHaveBeenCalled();
  expect(m.send).toHaveBeenCalledTimes(1);
});
it('rechecks permissions in the worker and records failures without exposing a send', async () => {
  const {
    jobIds: [id],
  } = await queueEmails(request());
  m.docs.delete('tenants/a/members/editor');
  await processEmailJob(ref(id), 1);
  expect(jobs()[0][1].status).toBe('failed');
  expect(m.render).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
});
it('requires a fresh composition after the safe provider retry window expires', async () => {
  const {
    jobIds: [id],
  } = await queueEmails(request());
  m.send.mockRejectedValueOnce(
    new HttpsError('failed-precondition', 'Generate a fresh pack.', { newPack: true }),
  );
  await processEmailJob(ref(id), 1);
  expect(jobs()[0][1]).toMatchObject({ status: 'failed', retryable: false });
  await expect(
    retryEmailJob({ ...request(), data: { tenantId: 'a', eventId: 'e', jobId: id, attempt: 1 } }),
  ).rejects.toMatchObject({ code: 'failed-precondition' });
});
