import { describe, it, expect } from 'vitest';
import seed from '../reference/seed.json';
import {
  computeItems,
  filterItems,
  formatDuration,
  parseDuration,
  time,
  planPack,
  planCombinedJob,
  paginate,
  fitPagination,
} from '../app/src/render/domain';
import type { Item, Category, Person, Template, PackSettings } from '../app/src/types';
const session = seed.sessions.find((s) => s.id === 'sat-evening')!;
const items = computeItems(
  session.items as Item[],
  seed.categories as Category[],
  seed.people as Person[],
);
const settings = (refs: [string, number][], extra: Partial<PackSettings> = {}): PackSettings => ({
  enabled: true,
  templates: refs.map(([templateId, copies]) => ({ templateId, copies })),
  sides: 'duplexLong',
  scaling: 'fit',
  collate: true,
  newSheetPerTemplate: true,
  coverSheet: false,
  ...extra,
});
describe('session timing', () => {
  it('matches supplied seed', () => {
    expect(formatDuration(items.at(-1)!.endSec)).toBe(seed.expected.runtime);
    expect(items.map((i) => time(session.startAt, i.startSec))).toEqual(seed.expected.starts);
    expect(new Set(items.flatMap((i) => i.personIds)).size).toBe(5);
  });
  it('reorders without changing runtime', () => {
    const reordered = structuredClone(session.items) as Item[];
    [reordered[5].order, reordered[6].order] = [reordered[6].order, reordered[5].order];
    const result = computeItems(reordered, seed.categories as Category[], seed.people as Person[]);
    expect(time(session.startAt, result[6].startSec)).toBe('8:13');
    expect(result.at(-1)!.endSec).toBe(6060);
  });
  it('validates durations', () => {
    expect(parseDuration('1:01:00')).toBe(3660);
    expect(() => parseDuration('4:99')).toThrow();
    expect(() => parseDuration('-3:00')).toThrow();
  });
});
it('selects recipient and deduplicates neighbours', () => {
  const template = seed.templates.find((t) => t.id === 'speaker-cue-cards')! as Template;
  const list = filterItems(items, template, 'margaret');
  expect(list.map((i) => i.number)).toEqual([6, 7, 8, 9, 10]);
});
it('marks only recipient assignments, including shared items, for highlighting', () => {
  const template = seed.templates[0] as Template;
  const assigned = items.map((item, index) => ({
    ...item,
    personIds: index === 0 ? ['someone-else', 'ross'] : ['someone-else'],
  }));
  const all = { ...template, filter: { scope: 'all' as const, categoryIds: null } };
  const highlighted = filterItems(assigned, all, 'ross');
  expect(highlighted.filter((i) => i.isRecipientItem).map((i) => i.id)).toEqual([assigned[0].id]);
  expect(highlighted).toHaveLength(assigned.length);
  expect(filterItems(highlighted, all, null).some((i) => i.isRecipientItem)).toBe(false);
  expect(filterItems(highlighted, all, 'unassigned').some((i) => i.isRecipientItem)).toBe(false);
  const neighbours = filterItems(
    assigned,
    { ...all, filter: { ...all.filter, scope: 'recipientPlusNeighbours' } },
    'ross',
  );
  expect(neighbours.map((i) => [i.isRecipientItem, i.context])).toEqual([
    [true, false],
    [false, true],
  ]);
});
it('pagination keeps blocks intact and reports impossible fit', () => {
  expect(paginate([40, 60, 50], 100)).toEqual([[0, 1], [2]]);
  expect(paginate([150, 40], 100)).toEqual([[0], [1]]);
  expect(fitPagination([100, 100, 100], 100, 1).warning).toBeTruthy();
  expect(fitPagination([60, 60], 100, 1).pages).toHaveLength(1);
});
const examples = [
  {
    name: 'A',
    s: settings([
      ['CC', 2],
      ['PR', 1],
    ]),
    counts: { CC: 1, PR: 1 },
    sheets: 3,
    sides: 6,
  },
  {
    name: 'B',
    s: settings([
      ['PR', 2],
      ['HS', 1],
    ]),
    counts: { PR: 1, HS: 4 },
    sheets: 4,
    sides: 8,
  },
  {
    name: 'C',
    s: settings([['PR', 1]], { sides: 'single', scaling: '2up' }),
    counts: { PR: 1 },
    sheets: 1,
    sides: 1,
  },
  {
    name: 'D',
    s: settings([['AS', 2]], { sides: 'single' }),
    counts: { AS: 1 },
    sheets: 2,
    sides: 2,
  },
  {
    name: 'E',
    s: settings([['T', 2]], { sides: 'single', collate: false }),
    counts: { T: 3 },
    sheets: 6,
    sides: 6,
  },
  {
    name: 'F',
    s: settings([['T', 1]], { scaling: '4up' }),
    counts: { T: 10 },
    sheets: 2,
    sides: 4,
  },
  {
    name: 'G',
    s: settings(
      [
        ['A', 1],
        ['B', 1],
      ],
      { newSheetPerTemplate: false },
    ),
    counts: { A: 1, B: 1 },
    sheets: 1,
    sides: 2,
  },
  {
    name: 'H',
    s: settings(
      [
        ['CC', 2],
        ['PR', 1],
      ],
      { coverSheet: true },
    ),
    counts: { CC: 1, PR: 1 },
    sheets: 4,
    sides: 8,
  },
];
it.each(examples)('pack example $name', ({ s, counts, sheets, sides }) => {
  const p = planPack(s, counts as Record<string, number>);
  expect(p.sheets).toBe(sheets);
  expect(p.sides).toHaveLength(sides);
});
it('combines A–D into ten sheets', () =>
  expect(
    planCombinedJob(
      examples
        .slice(0, 4)
        .map((e) => ({ settings: e.s, plan: planPack(e.s, e.counts as Record<string, number>) })),
    ),
  ).toHaveLength(20));
it('uncollated copies repeat each page in place', () =>
  expect(
    planPack(examples[4].s, { T: 3 }).sides.flatMap((s) =>
      s.kind === 'pages' ? s.cells.map((c) => c.page) : [],
    ),
  ).toEqual([1, 1, 2, 2, 3, 3]));
