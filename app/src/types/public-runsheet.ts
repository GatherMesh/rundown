export interface RunsheetLink {
  tenantId: string;
  eventId: string;
  personId: string;
  token: string;
}

export interface PublicRunsheet {
  eventName: string;
  timeZone: string;
  person: { name: string; role?: string };
  sessions: { id: string; name: string; startAt: string }[];
  sessionId: string | null;
  views: { id: string; name: string; html: string }[];
}
