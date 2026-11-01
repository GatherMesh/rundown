import { expect, it } from 'vitest';
import { computeItems } from '../app/src/render/domain';
import { packRevision, requiresReprint, printDate } from '../app/src/render/reprints';
import type { RenderPayload } from '../app/src/render/renderer';
import type { Category, Item, Person, Template } from '../app/src/types';
import seed from '../reference/seed.json';

const person = seed.people.find((p) => p.id === 'margaret')! as Person;
function document(): RenderPayload {
  return {
    tenant: { name: 'QCEC', logoUrl: 'https://example.com/client-logo' },
    event: { name: 'Event', timeZone: 'Australia/Brisbane' },
    session: {
      name: 'Session',
      startAt: seed.sessions.find((s) => s.id === 'sat-evening')!.startAt,
    },
    recipient: { id: person.id, name: person.name, role: person.role },
    template: {
      ...structuredClone(seed.templates[0]),
      filter: { scope: 'recipient', categoryIds: null },
    } as Template,
    items: computeItems(
      structuredClone(seed.sessions.find((s) => s.id === 'sat-evening')!.items) as Item[],
      structuredClone(seed.categories) as Category[],
      structuredClone(seed.people) as Person[],
    ),
  };
}
const revision = (p: RenderPayload, settings = person.pack) => packRevision([p], settings);

it('compares with confirmed copies; initial copies and previews require no reprint', async () => {
  const before = await revision(document());
  expect(requiresReprint(undefined, before)).toBe(false);
  const record = {
    personId: person.id,
    sessionId: 's',
    revision: before,
    printedAt: '2026-11-01T00:00:00Z',
  };
  expect(requiresReprint(record, before)).toBe(false);
  const changed = document();
  changed.items.find((i) => i.personIds.includes(person.id))!.script = 'New script';
  expect(requiresReprint(record, await revision(changed))).toBe(true);
  // Confirming an earlier PDF must leave subsequent edits outstanding.
  const later = structuredClone(changed);
  later.items.find((i) => i.personIds.includes(person.id))!.script = 'Another change';
  expect(
    requiresReprint({ ...record, revision: await revision(changed) }, await revision(later)),
  ).toBe(true);
  expect(requiresReprint(record, await revision(document()))).toBe(false);
});

it('ignores unrelated filtered items, edit metadata, image URLs and other people’s pack settings', async () => {
  const before = await revision(document()),
    changed = document();
  changed.tenant.logoUrl = 'data:image/png;base64,server-image';
  changed.template.updatedAt = {} as Template['updatedAt'];
  const unrelated = changed.items.find((i) => !i.personIds.includes(person.id))!;
  unrelated.title = 'Not in this recipient’s report';
  for (const item of changed.items) {
    item.updatedBy = 'someone-else';
    for (const p of item.people) p.pack.templates = [];
  }
  expect(await revision(changed)).toBe(before);
  expect(
    await revision(changed, {
      ...person.pack,
      enabled: !person.pack.enabled,
      sessionIds: [],
      coverSheet: true,
    }),
  ).toBe(before);
});

it('detects timing shifts, removals, assignments, template changes and copy/settings changes', async () => {
  const before = await revision(document());
  for (const change of [
    (p: RenderPayload) => {
      p.items[0].durationSec += 60;
      p.items = computeItems(p.items, seed.categories as Category[], seed.people as Person[]);
    },
    (p: RenderPayload) => {
      p.items = p.items.filter((i) => !i.personIds.includes(person.id));
    },
    (p: RenderPayload) => {
      p.items[0].personIds.push(person.id);
    },
    (p: RenderPayload) => {
      p.template.orientation = 'portrait';
    },
    (p: RenderPayload) => {
      p.session.name = 'New session name';
    },
  ]) {
    const changed = document();
    change(changed);
    expect(await revision(changed)).not.toBe(before);
  }
  expect(await revision(document(), { ...person.pack, scaling: '4up' })).not.toBe(before);
  expect(
    await revision(document(), {
      ...person.pack,
      templates: person.pack.templates.map((t) => ({ ...t, copies: t.copies + 1 })),
    }),
  ).not.toBe(before);
});

it('prints the date, time including seconds, and the event timezone', () => {
  expect(printDate('2026-10-31T23:12:34Z', 'Australia/Brisbane')).toBe(
    '01 Nov 2026, 09:12:34 am AEST',
  );
});
