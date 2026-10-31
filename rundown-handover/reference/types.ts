// Domain types for Rundown. Copy into app/src/types and functions/src/types.
import type { Timestamp } from 'firebase/firestore';

export type Role = 'owner' | 'editor' | 'viewer';

export interface StoredImage {
  path: string;          // Firebase Storage path
  name: string;
  width: number;
  height: number;
  contentType: string;
}

export interface Tenant { id: string; name: string; logo?: StoredImage; createdAt: Timestamp; createdBy: string }
export interface Member { uid: string; role: Role; displayName: string; email: string; addedAt: Timestamp }

export interface Category { id: string; name: string; bg: string; fg: string; order: number; archived?: boolean }

export interface Event {
  id: string;
  name: string;
  startDate: string;     // YYYY-MM-DD
  endDate: string;
  timeZone: string;      // IANA, default 'Australia/Brisbane'
  venue?: string;
  logo?: StoredImage;
}

export type Sides = 'single' | 'duplexLong' | 'duplexShort';
export type Scaling = 'fit' | 'actual' | '2up' | '4up';

export interface PackTemplateRef { templateId: string; copies: number }

export interface PackSettings {
  enabled: boolean;
  templates: PackTemplateRef[];   // ordered
  sides: Sides;
  scaling: Scaling;
  collate: boolean;
  newSheetPerTemplate: boolean;
  coverSheet: boolean;
}

export const defaultPack = (): PackSettings => ({
  enabled: false, templates: [], sides: 'single', scaling: 'fit',
  collate: true, newSheetPerTemplate: true, coverSheet: false,
});

export interface Person { id: string; name: string; role?: string; email?: string; initials?: string; pack: PackSettings }

export interface Session {
  id: string;
  name: string;
  subtitle?: string;
  startAt: Timestamp;
  sortKey: Timestamp;
  itemCount: number;
}

export interface AvNotes { audio?: string; video?: string; lighting?: string; camera?: string; slides?: string }

export interface Item {
  id: string;
  order: string;          // fractional index
  title: string;
  durationSec: number;
  categoryId: string;
  personIds: string[];
  notes?: string;
  script?: string;
  av: AvNotes;
  imageSlide?: StoredImage | null;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

/** Item with derived values — never persisted. */
export interface ComputedItem extends Item {
  number: number;         // 1-based
  startSec: number;       // offset from session start
  endSec: number;
  category: Category;
  people: Person[];
  context?: boolean;      // neighbour shown for context (recipientPlusNeighbours)
  isRecipientItem?: boolean;
}

export type HeaderField = 'sessionName' | 'eventName' | 'sessionDateTime' | 'logo' | 'sessionSubtitle' | 'personName';
export type ItemStyle = 'table' | 'cards' | 'cueCard' | 'compact';
export type ColumnKey =
  | 'start' | 'duration' | 'end' | 'number' | 'title' | 'category' | 'people' | 'notes' | 'script'
  | 'audio' | 'video' | 'lighting' | 'camera' | 'slides' | 'imageSlide';
export type ColumnWidth = 'auto' | `${number}px` | `${number}fr`;

export interface TemplateColumn { key: ColumnKey; visible: boolean; width: ColumnWidth }

export interface Template {
  id: string;
  name: string;
  description?: string;
  orientation: 'portrait' | 'landscape';
  paper: 'A4';
  pageMode: { kind: 'flow' } | { kind: 'fit'; pages: number };
  header: Record<HeaderField, { show: boolean; align: 'left' | 'right' }>;
  itemStyle: ItemStyle;
  columns: TemplateColumn[];
  filter: { scope: 'all' | 'recipient' | 'recipientPlusNeighbours'; categoryIds: string[] | null };
  updatedAt?: Timestamp;
}

// ---- Pack planner (pure; see docs/PDF_EXPORT.md) ----

export type OutputSide =
  | { kind: 'blank' }
  | { kind: 'cover' }
  | {
      kind: 'pages';
      cells: { templateId: string; copy: number; page: number /* 1-based */ }[]; // 1 cell unless n-up
      rotate180?: boolean;   // emulated short-edge back
    };

export interface PlannedPack { sides: OutputSide[]; sheets: number; pages: number /* source pages */ }

export declare function planPack(settings: PackSettings, docPageCounts: Record<string, number>): PlannedPack;
export declare function planCombinedJob(packs: { settings: PackSettings; plan: PlannedPack }[]): OutputSide[];
