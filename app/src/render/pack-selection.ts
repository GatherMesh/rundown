import type { PackSettings, Person } from '../types';

export function includesSession(pack: PackSettings, sessionId: string): boolean {
  return pack.sessionIds === undefined || pack.sessionIds.includes(sessionId);
}

// Keep each person's sessions together, in the supplied chronological order.
export function selectPackJobs<T extends { id: string }>(
  people: Person[],
  sessions: T[],
  personId?: string,
  sessionId?: string,
): { person: Person; session: T }[] {
  return people
    .filter((p) => (personId ? p.id === personId : p.pack.enabled))
    .flatMap((person) =>
      sessions
        .filter((s) => (!sessionId || s.id === sessionId) && includesSession(person.pack, s.id))
        .map((session) => ({ person, session })),
    );
}
