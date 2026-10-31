import { describe, expect, it } from 'vitest';
import { operations, openApiDocument } from '../functions/src/api-contract';
import { checkRole, validateImagePath } from '../functions/src/api-service';
import { assetTarget, decodeImage } from '../functions/src/api-http';
import seed from '../reference/seed.json';
import { defaultPack } from '../app/src/types';

it('accepts per-person session selection and optional export session scope', () => {
  const args = { tenantId: 't', eventId: 'e', personId: 'p' };
  for (const sessionIds of [undefined, [], ['s1', 's2']])
    expect(
      operations.packs_set.schema.safeParse({
        ...args,
        pack: { ...defaultPack(), sessionIds },
      }).success,
    ).toBe(true);
  for (const sessionIds of [['s', 's'], ['../other'], 's', null])
    expect(
      operations.packs_set.schema.safeParse({
        ...args,
        pack: { ...defaultPack(), sessionIds },
      }).success,
    ).toBe(false);
  for (const scope of [args, { ...args, sessionId: 's' }, { tenantId: 't', eventId: 'e' }])
    expect(operations.exports_render.schema.safeParse(scope).success).toBe(true);
});
const item = {
  tenantId: 'a',
  eventId: 'e',
  sessionId: 's',
  data: { title: 'Cue', durationSec: 60, categoryId: 'c' },
};
it('publishes all operations with strict schemas in OpenAPI', () => {
  const spec = openApiDocument();
  expect(Object.keys(spec.paths)).toHaveLength(Object.keys(operations).length + 1);
  expect(
    spec.paths['/items_create'].post.requestBody.content['application/json'].schema
      .additionalProperties,
  ).toBe(false);
  for (const [name, op] of Object.entries(operations))
    expect(op.schema.safeParse({ unexpected: true }).success, name).toBe(false);
});
it('accepts every seed template and rejects duplicate columns / injected styles', () => {
  for (const { id, ...data } of seed.templates)
    expect(operations.templates_create.schema.safeParse({ tenantId: 'a', data }).success, id).toBe(
      true,
    );
  const { id, ...data } = seed.templates[0];
  expect(
    operations.templates_create.schema.safeParse({
      tenantId: 'a',
      data: { ...data, columns: [data.columns[0], data.columns[0]] },
    }).success,
  ).toBe(false);
  expect(
    operations.templates_create.schema.safeParse({
      tenantId: 'a',
      data: { ...data, columns: [{ ...data.columns[0], width: '1fr; color:red' }] },
    }).success,
  ).toBe(false);
});
it('accepts Dense Cards when creating and updating templates', () => {
  const { id, ...data } = seed.templates[0];
  expect(
    operations.templates_create.schema.safeParse({
      tenantId: 'a',
      data: { ...data, itemStyle: 'denseCards' },
    }).success,
  ).toBe(true);
  expect(
    operations.templates_update.schema.safeParse({
      tenantId: 'a',
      id,
      data: { itemStyle: 'denseCards' },
    }).success,
  ).toBe(true);
});
it.each([undefined, '#123aBC', '', 'red', '#123', '#123456;display:none', null])(
  'validates optional template column text colour %s',
  (color) => {
    const { id, ...data } = seed.templates[0];
    const columns = [{ ...data.columns[0], color }];
    const valid = color === undefined || color === '#123aBC';
    expect(
      operations.templates_create.schema.safeParse({
        tenantId: 'a',
        data: { ...data, columns },
      }).success,
    ).toBe(valid);
    expect(
      operations.templates_update.schema.safeParse({ tenantId: 'a', id, data: { columns } })
        .success,
    ).toBe(valid);
  },
);
it.each(['all', 'first', 'invalid'])('validates header pages setting %s', (headerPages) => {
  const { id, ...data } = seed.templates[0];
  expect(
    operations.templates_create.schema.safeParse({
      tenantId: 'a',
      data: { ...data, headerPages },
    }).success,
  ).toBe(headerPages !== 'invalid');
  expect(
    operations.templates_update.schema.safeParse({
      tenantId: 'a',
      id,
      data: { headerPages },
    }).success,
  ).toBe(headerPages !== 'invalid');
});
it.each([-1, 1.5, 86401, '60', null])('rejects invalid duration %s', (durationSec) => {
  expect(
    operations.items_create.schema.safeParse({ ...item, data: { ...item.data, durationSec } })
      .success,
  ).toBe(false);
});
it('rejects arbitrary paths, forged audit fields and stored derived values', () => {
  for (const patch of [
    { tenantId: '../b' },
    { sessionId: 's/items/x' },
    { data: { ...item.data, startSec: 0 } },
    { data: { ...item.data, updatedBy: 'other' } },
  ])
    expect(operations.items_create.schema.safeParse({ ...item, ...patch }).success).toBe(false);
  expect(operations.items_create.schema.parse(item)).toEqual(item);
  expect(
    operations.sessions_update.schema.safeParse({
      tenantId: 'a',
      eventId: 'e',
      id: 's',
      data: { itemCount: 99 },
    }).success,
  ).toBe(false);
});
it('requires explicit complete nested settings and valid ISO timestamps', () => {
  expect(
    operations.packs_set.schema.safeParse({
      tenantId: 'a',
      eventId: 'e',
      personId: 'p',
      pack: { enabled: true },
    }).success,
  ).toBe(false);
  expect(
    operations.sessions_create.schema.safeParse({
      tenantId: 'a',
      eventId: 'e',
      data: { name: 'S', startAt: '2027-03-27T19:00:00+10:00' },
    }).success,
  ).toBe(true);
  expect(
    operations.sessions_create.schema.safeParse({
      tenantId: 'a',
      eventId: 'e',
      data: { name: 'S', startAt: '2027-03-27T19:00:00' },
    }).success,
  ).toBe(false);
});
it('enforces roles including invalid membership roles', () => {
  expect(() => checkRole('viewer', 'read')).not.toThrow();
  expect(() => checkRole('viewer', 'edit')).toThrow();
  expect(() => checkRole('editor', 'owner')).toThrow();
  expect(() => checkRole(undefined, 'read')).toThrow();
  expect(() => checkRole('invalid', 'read')).toThrow();
  expect(() => checkRole('owner', 'owner')).not.toThrow();
});
it('confines images to the tenant and known image locations', () => {
  expect(() => validateImagePath('tenants/a/logo/file.png', 'a')).not.toThrow();
  for (const path of [
    'tenants/b/logo/f.png',
    'tenants/a/exports/secret.pdf',
    'tenants/a/logo/../b',
    'https://evil.test/img',
  ])
    expect(() => validateImagePath(path, 'a')).toThrow();
  expect(() => assetTarget({ tenantId: 'a', itemId: 'i' })).toThrow();
  expect(assetTarget({ tenantId: 'a', eventId: 'e', sessionId: 's', itemId: 'i' }).field).toBe(
    'imageSlide',
  );
});
it('checks image bytes, not only declared MIME type', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=';
  expect(decodeImage(png, 'image/png')).toMatchObject({ width: 1, height: 1 });
  expect(() => decodeImage(png, 'image/jpeg')).toThrow();
  expect(() =>
    decodeImage(Buffer.from('<script>alert(1)</script>').toString('base64'), 'image/png'),
  ).toThrow();
  expect(() => decodeImage('invalid!', 'image/png')).toThrow();
});

it.each(['left', 'center', 'right', 'invalid'])(
  'validates logo placement %s on create and update',
  (align) => {
    const { id, ...data } = seed.templates[0];
    const header = { ...data.header, logo: { show: true, align } };
    expect(
      operations.templates_create.schema.safeParse({ tenantId: 'a', data: { ...data, header } })
        .success,
    ).toBe(align !== 'invalid');
    expect(
      operations.templates_update.schema.safeParse({ tenantId: 'a', id, data: { header } }).success,
    ).toBe(align !== 'invalid');
  },
);
it('keeps centre placement exclusive to the logo', () => {
  const { id, ...data } = seed.templates[0];
  const header = { ...data.header, sessionName: { show: true, align: 'center' } };
  expect(
    operations.templates_create.schema.safeParse({ tenantId: 'a', data: { ...data, header } })
      .success,
  ).toBe(false);
});
