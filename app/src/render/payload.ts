import type { Template, Person } from '../types';
import type { useWorkspace } from '../stores/workspace';
import type { RenderPayload } from './renderer';
export function payload(
  w: Pick<ReturnType<typeof useWorkspace>, 'session' | 'event' | 'tenant' | 'orderedItems'>,
  template: Template,
  person: Person | null,
): RenderPayload {
  if (!w.session || !w.event || !w.tenant) throw new Error('Select a session to preview.');
  return {
    tenant: { name: w.tenant.name, logoUrl: w.tenant.logo?.url },
    event: { name: w.event.name, timeZone: w.event.timeZone, logoUrl: w.event.logo?.url },
    session: {
      name: w.session.name,
      subtitle: w.session.subtitle,
      startAt: w.session.startAt.toDate().toISOString(),
    },
    items: JSON.parse(JSON.stringify(w.orderedItems)),
    template: JSON.parse(JSON.stringify(template)),
    recipient: person ? { id: person.id, name: person.name, role: person.role } : null,
  };
}
