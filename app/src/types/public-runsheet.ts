export type RunsheetLink = {
  tenantId: string;
  eventId: string;
  token: string;
} & ({ personId: string; sessionId?: never } | { sessionId: string; personId?: never });

export interface PublicRunsheet {
  eventName: string;
  timeZone: string;
  person: { name: string; role?: string } | null;
  sessions: { id: string; name: string; startAt: string }[];
  sessionId: string | null;
  views: { id: string; name: string; html: string }[];
}
