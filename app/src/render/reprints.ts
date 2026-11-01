import { filterItems } from './domain';
import type { RenderPayload } from './renderer';
import type { PackSettings, StoredImage } from '../types';

export interface PrintRecord {
  personId: string;
  sessionId: string;
  revision: string;
  printedAt: string;
}

// URLs and edit metadata differ between client/server and do not change printed content.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([key, v]) => v !== undefined && !['updatedAt', 'updatedBy', 'url'].includes(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export async function packRevision(
  documents: RenderPayload[],
  settings: PackSettings,
  logo?: StoredImage,
): Promise<string> {
  const { enabled, sessionIds, coverSheet, ...printSettings } = settings;
  const content = canonical({
    version: 1,
    printSettings,
    logo,
    documents: documents.map((p) => ({
      tenant: p.tenant.name,
      event: { name: p.event.name, timeZone: p.event.timeZone },
      session: p.session,
      recipient: p.recipient,
      template: p.template,
      runtime: p.items.at(-1)?.endSec ?? 0,
      items: filterItems(p.items, p.template, p.recipient?.id ?? null).map((item) => ({
        ...item,
        people: item.people.map((person) => ({ id: person.id, name: person.name })),
        // The context label also depends on the preceding unfiltered item's assignment.
        previousAssigned:
          p.items[item.number - 2]?.personIds.includes(p.recipient?.id ?? '') ?? false,
      })),
    })),
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function requiresReprint(record: PrintRecord | undefined, revision: string): boolean {
  return !!record && record.revision !== revision;
}

export function printDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}
