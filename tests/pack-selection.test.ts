import { expect, it } from 'vitest';
import { includesSession, selectPackJobs } from '../app/src/render/pack-selection';
import { defaultPack, type Person } from '../app/src/types';
import { planPack, planCombinedJob } from '../app/src/render/domain';

const sessions = [{ id: 'morning' }, { id: 'evening' }];
const people: Person[] = [
  {
    id: 'a',
    name: 'A',
    pack: { ...defaultPack(), enabled: true, sessionIds: ['evening', 'morning'] },
  },
  {
    id: 'b',
    name: 'B',
    pack: { ...defaultPack(), enabled: true, sessionIds: ['evening', 'deleted'] },
  },
  { id: 'c', name: 'C', pack: { ...defaultPack(), enabled: false, sessionIds: ['morning'] } },
  { id: 'd', name: 'D', pack: { ...defaultPack(), enabled: true } },
];
const keys = (jobs: ReturnType<typeof selectPackJobs>) =>
  jobs.map(({ person, session }) => `${person.id}/${session.id}`);

it('global Print All groups checked sessions by enabled person in session order', () => {
  expect(keys(selectPackJobs(people, sessions))).toEqual(['a/morning', 'a/evening', 'b/evening']);
});
it('Print all for person prints only that person’s checked sessions, independent of global enable', () => {
  expect(keys(selectPackJobs(people, sessions, 'a'))).toEqual(['a/morning', 'a/evening']);
  expect(keys(selectPackJobs(people, sessions, 'c'))).toEqual(['c/morning']);
});
it('individual session printing cannot include an unchecked or nonexistent session', () => {
  expect(keys(selectPackJobs(people, sessions, 'b', 'evening'))).toEqual(['b/evening']);
  expect(selectPackJobs(people, sessions, 'b', 'morning')).toEqual([]);
  expect(selectPackJobs(people, sessions, 'b', 'deleted')).toEqual([]);
  expect(selectPackJobs(people, sessions, 'missing')).toEqual([]);
  expect(selectPackJobs(people, [], 'a')).toEqual([]);
});
it('keeps legacy all-session coverage, but new packs and explicit empty selections include none', () => {
  const { sessionIds, ...legacy } = people[0].pack;
  expect(includesSession(legacy, 'new-session')).toBe(true);
  expect(keys(selectPackJobs([{ ...people[0], pack: legacy }], sessions))).toEqual([
    'a/morning',
    'a/evening',
  ]);
  expect(includesSession(defaultPack(), 'morning')).toBe(false);
  expect(selectPackJobs(people, sessions, 'd')).toEqual([]);
});

it.each(['single', 'duplexLong', 'duplexShort'] as const)(
  'adds one cover per person across selected sessions (%s)',
  (sides) => {
    const recipients = people.map((p) => ({
      ...p,
      pack: { ...p.pack, sides, coverSheet: true, templates: [{ templateId: 't', copies: 1 }] },
    }));
    const jobs = selectPackJobs(recipients, sessions);
    expect(jobs.map((j) => j.coverSheet)).toEqual([true, false, true]);
    const packs = jobs.map((j) => ({
      settings: j.person.pack,
      plan: planPack(j.person.pack, { t: 1 }, j.coverSheet),
    }));
    expect(packs.reduce((n, p) => n + p.plan.sheets, 0)).toBe(5);
    expect(planCombinedJob(packs)).toHaveLength(10);
    expect(planCombinedJob(packs).filter((s) => s.kind === 'cover')).toHaveLength(2);
    expect(selectPackJobs(recipients, sessions, 'c').map((j) => j.coverSheet)).toEqual([true]);
    expect(selectPackJobs(recipients, sessions, 'a', 'evening')[0].coverSheet).toBe(false);
    expect(
      selectPackJobs(recipients, sessions, undefined, 'evening').every((j) => !j.coverSheet),
    ).toBe(true);
    expect(recipients[0].pack.coverSheet).toBe(true);
    expect(
      selectPackJobs(
        [{ ...recipients[0], pack: { ...recipients[0].pack, coverSheet: false } }],
        sessions,
      ).every((j) => !j.coverSheet),
    ).toBe(true);
  },
);
