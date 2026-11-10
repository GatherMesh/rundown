import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { sendPackEmail } from '../functions/src/email-pack';
import { validPersonEmail } from '../app/src/types/person-email';
import { packEmailMessage } from '../functions/src/pack-email-template';

const m = vi.hoisted(() => ({
  member: vi.fn(),
  getAll: vi.fn(),
  file: vi.fn(),
  update: vi.fn(),
  fetch: vi.fn(),
  share: vi.fn(),
}));
vi.mock('../functions/src/public-runsheet', () => ({ createRunsheetLink: m.share }));
vi.mock('firebase-admin/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase-admin/firestore')>()),
  getFirestore: () => ({
    doc: (path: string) => ({ path, get: m.member, update: m.update }),
    getAll: m.getAll,
  }),
}));
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ file: m.file }) }),
}));

const request = {
  auth: { uid: 'producer' },
  data: { tenantId: 'a', eventId: 'e', personId: 'p', jobId: 'j', email: 'person@example.com' },
} as CallableRequest;
const job = {
  createdBy: 'producer',
  status: 'complete',
  eventId: 'e',
  eventName: 'Conference',
  fullPackPersonId: 'p',
  personName: 'Alex',
  path: 'tenants/a/exports/event/p-j.pdf',
  completedAt: { toMillis: () => Date.now() },
};
function documents(overrides = {}, email = request.data.email) {
  m.getAll.mockResolvedValue([
    { data: () => ({ ...job, ...overrides }) },
    { data: () => ({ email }) },
  ]);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('PACK_EMAIL_FROM', 'sender@example.com');
  vi.stubEnv('PACK_EMAIL_TENANTS', 'a,b');
  vi.stubEnv('RESEND_API_KEY', 'test');
  vi.stubEnv('GCLOUD_PROJECT', 'demo-rundown');
  vi.stubGlobal('fetch', m.fetch);
  m.member.mockResolvedValue({ data: () => ({ role: 'editor' }) });
  documents();
  m.file.mockReturnValue({
    getMetadata: async () => [{ size: '123' }],
    download: async () => [Buffer.from('%PDF')],
  });
  m.fetch.mockResolvedValue({ ok: true });
  m.share.mockResolvedValue({ token: 'a'.repeat(48) });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('attaches only the full PDF for the saved event person', async () => {
  await expect(sendPackEmail(request)).resolves.toEqual({ sent: true });
  expect(m.file).toHaveBeenCalledWith(job.path);
  expect(m.getAll.mock.calls[0].map((ref: { path: string }) => ref.path)).toEqual([
    'tenants/a/exportJobs/j',
    'tenants/a/events/e/people/p',
  ]);
  const body = JSON.parse(m.fetch.mock.calls[0][1].body);
  expect(body.to).toEqual(['person@example.com']);
  const link = `https://demo-rundown.web.app/runsheet/a/e/p/${'a'.repeat(48)}`;
  expect(body.html).toContain(`href="${link}"`);
  expect(body.html).toContain('Hi Alex,');
  expect(body.text).toContain(link);
  expect(m.share).toHaveBeenCalledWith(
    expect.objectContaining({
      auth: request.auth,
      data: { tenantId: 'a', eventId: 'e', personId: 'p' },
    }),
  );
  expect(body.attachments).toEqual([
    { filename: 'Session pack.pdf', content: Buffer.from('%PDF').toString('base64') },
  ]);
  expect(m.update).toHaveBeenCalledWith({ emailSentTo: request.data.email });
});
it('escapes names in HTML and removes line breaks from the subject', () => {
  const message = packEmailMessage(
    '<img src=x>',
    'Event & friends\r\nBcc: hidden',
    'https://example.com/?a=1&b=2',
  );
  expect(message.html).toContain('Hi &lt;img src=x&gt;,');
  expect(message.html).toContain('Event &amp; friends');
  expect(message.html).not.toContain('<img');
  expect(message.html).toContain('?a=1&amp;b=2');
  expect(message.subject).not.toMatch(/[\r\n]/);
});
it('uses the configured app URL and does not accept a caller-supplied URL', async () => {
  vi.stubEnv('PACK_EMAIL_APP_URL', 'https://rundown.example.com');
  await sendPackEmail(request);
  expect(JSON.parse(m.fetch.mock.calls[0][1].body).text).toContain(
    'https://rundown.example.com/runsheet/',
  );
  await expect(
    sendPackEmail({ ...request, data: { ...request.data, url: 'https://evil.example' } }),
  ).rejects.toMatchObject({ code: 'invalid-argument' });
});
it('keeps an unconfirmed network submission retryable', async () => {
  m.fetch.mockRejectedValueOnce(new Error('Timed out'));
  await expect(sendPackEmail(request)).rejects.toMatchObject({ code: 'unavailable' });
  expect(m.update).not.toHaveBeenCalled();
  await expect(sendPackEmail(request)).resolves.toEqual({ sent: true });
});
it.each([
  { fullPackPersonId: undefined },
  { fullPackPersonId: 'other' },
  { eventId: 'other' },
  { createdBy: 'other' },
  { status: 'failed' },
])('rejects an unrelated or incomplete export %o', async (override) => {
  documents(override);
  await expect(sendPackEmail(request)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(m.fetch).not.toHaveBeenCalled();
});
it('rejects a replaced address and a malformed recipient list', async () => {
  documents({}, 'someone-else@example.com');
  await expect(sendPackEmail(request)).rejects.toThrow('saved email address changed');
  const email = 'a@example.com,b@example.com';
  expect(validPersonEmail(email)).toBe(false);
  await expect(
    sendPackEmail({ ...request, data: { ...request.data, email } }),
  ).rejects.toMatchObject({ code: 'invalid-argument' });
  expect(m.fetch).not.toHaveBeenCalled();
});
it('requires an authenticated editor in a sender-enabled tenant', async () => {
  await expect(sendPackEmail({ ...request, auth: undefined })).rejects.toMatchObject({
    code: 'unauthenticated',
  });
  m.member.mockResolvedValueOnce({ data: () => ({ role: 'viewer' }) });
  await expect(sendPackEmail(request)).rejects.toMatchObject({ code: 'permission-denied' });
  vi.stubEnv('PACK_EMAIL_TENANTS', 'other');
  await expect(sendPackEmail(request)).rejects.toThrow('not enabled');
  expect(m.fetch).not.toHaveBeenCalled();
});
it('allows retry of a failed submission with the same key and acknowledges a completed send only once', async () => {
  m.fetch.mockResolvedValueOnce({ ok: false, status: 429 });
  await expect(sendPackEmail(request)).rejects.toMatchObject({ code: 'unavailable' });
  expect(m.update).not.toHaveBeenCalled();
  await sendPackEmail(request);
  expect(m.fetch.mock.calls[0][1].headers['Idempotency-Key']).toEqual(
    m.fetch.mock.calls[1][1].headers['Idempotency-Key'],
  );
  documents({ emailSentTo: request.data.email });
  await sendPackEmail(request);
  expect(m.fetch).toHaveBeenCalledTimes(2);
});
it('requires a new export for an expired job or an oversized PDF', async () => {
  m.file.mockReturnValue({ getMetadata: async () => [{ size: 26 * 1024 * 1024 }] });
  await expect(sendPackEmail(request)).rejects.toMatchObject({
    code: 'resource-exhausted',
    details: { newPack: true },
  });
  documents({ completedAt: { toMillis: () => 0 } });
  await expect(sendPackEmail(request)).rejects.toMatchObject({ details: { newPack: true } });
  expect(m.fetch).not.toHaveBeenCalled();
});
