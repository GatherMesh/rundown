import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { Timestamp } from 'firebase/firestore';
import { useWorkspace } from '../app/src/stores/workspace';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  update: vi.fn(),
  download: vi.fn(),
  bitmap: vi.fn(),
}));
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
vi.mock('firebase/storage', () => ({
  ref: (_storage: unknown, path: string) => ({ fullPath: path }),
  uploadBytes: mocks.upload,
  getDownloadURL: mocks.download,
}));
const png = { name: 'org logo.png', type: 'image/png', size: 100 } as File;
function setup() {
  const w = useWorkspace();
  w.tenantId = 'a';
  w.role = 'owner';
  w.tenants = ['a', 'b'].map((id) => ({
    id,
    name: id,
    createdBy: 'owner',
    createdAt: Timestamp.now(),
  }));
  return w;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('createImageBitmap', mocks.bitmap);
  setActivePinia(createPinia());
  mocks.bitmap.mockResolvedValue({ width: 320, height: 160, close: vi.fn() });
  mocks.upload.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue('https://example.com/logo.png');
});
afterEach(() => vi.unstubAllGlobals());

it('uploads a logo to the selected tenant and saves metadata used by previews', async () => {
  const w = setup();
  await w.uploadOrganisationLogo(png);
  expect(mocks.upload).toHaveBeenCalledWith(
    { fullPath: expect.stringMatching(/^tenants\/a\/logo\/.+-org_logo.png$/) },
    png,
    { contentType: 'image/png' },
  );
  expect(mocks.update).toHaveBeenCalledWith(
    { path: 'tenants/a' },
    {
      logo: expect.objectContaining({
        name: png.name,
        width: 320,
        height: 160,
        contentType: 'image/png',
        url: 'https://example.com/logo.png',
      }),
    },
  );
  expect(w.tenant?.logo?.url).toBe('https://example.com/logo.png');
});
it('keeps the upload attached to its original organisation when switching during upload', async () => {
  const w = setup();
  mocks.upload.mockImplementation(async () => {
    w.tenantId = 'b';
  });
  await w.uploadOrganisationLogo(png);
  expect(mocks.update).toHaveBeenCalledWith({ path: 'tenants/a' }, expect.anything());
  expect(w.tenant?.logo).toBeUndefined();
  expect(w.tenants[0].logo?.name).toBe(png.name);
});
it.each(['editor', 'viewer'] as const)(
  'blocks %s uploads before touching storage',
  async (role) => {
    const w = setup();
    w.role = role;
    await expect(w.uploadOrganisationLogo(png)).rejects.toThrow('Owner access required');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  },
);
it.each([
  { ...png, type: 'image/svg+xml' },
  { ...png, size: 10 * 1024 * 1024 + 1 },
])('rejects unsupported or oversized images', async (file) => {
  await expect(setup().uploadOrganisationLogo(file as File)).rejects.toThrow('PNG or JPG');
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});
it('keeps the saved logo if a replacement cannot be saved', async () => {
  const w = setup();
  await w.uploadOrganisationLogo(png);
  const previous = { ...w.tenant!.logo };
  mocks.update.mockRejectedValue(new Error('Offline'));
  await expect(w.uploadOrganisationLogo({ ...png, name: 'new.png' } as File)).rejects.toThrow(
    'Offline',
  );
  expect(w.tenant?.logo).toEqual(previous);
});
it('does not change the tenant if upload fails', async () => {
  const w = setup();
  mocks.upload.mockRejectedValue(new Error('Upload failed'));
  await expect(w.uploadOrganisationLogo(png)).rejects.toThrow('Upload failed');
  expect(mocks.update).not.toHaveBeenCalled();
  expect(w.tenant?.logo).toBeUndefined();
});
