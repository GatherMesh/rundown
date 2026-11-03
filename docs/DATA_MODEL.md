# Data model — Cloud Firestore

All app data is nested under the tenant so security rules and queries stay simple.
Types are in `reference/types.ts`.

```
tenants/{tenantId}                              Tenant
  members/{uid}                                 Member { role }
  categories/{categoryId}                       Category
  templates/{templateId}                        Template
  events/{eventId}                              Event
    people/{personId}                           Person  (+ pack settings)
    sessions/{sessionId}                        Session
      items/{itemId}                            Item
    printRecords/{hashOfPersonAndSession}        Last confirmed printed session snapshot
    runsheetLinks/{personId}                    Server-only public link token and creation audit
users/{uid}                                     UserProfile { tenantIds[], lastTenantId }
```

Storage:

```
tenants/{tenantId}/logo/{fileName}
tenants/{tenantId}/events/{eventId}/logo/{fileName}
tenants/{tenantId}/events/{eventId}/sessions/{sessionId}/items/{itemId}/{fileName}   image slides
```

## Documents

### Tenant
`{ name, logo?: StoredImage, createdAt, createdBy }`

### Member
`{ role: 'owner'|'editor'|'viewer', displayName, email, addedAt }` — doc id = Firebase Auth uid.

### Category
`{ name, bg, fg, order: number, archived?: boolean }` — `bg`/`fg` are hex colours for the pill.

### Event
`{ name, startDate: 'YYYY-MM-DD', endDate, timeZone: 'Australia/Brisbane', venue?, logo?: StoredImage }`

### Person (event-scoped)
```
{
  name, role?, email?, initials?,           // initials default from name
  pack: PackSettings                        // see below; default disabled
}
```

### Session
`{ name, subtitle?, startAt: Timestamp, sortKey: Timestamp /* = startAt */, itemCount: number }`
`itemCount` is the only denormalised field (for the sidebar); maintain it in a batched write when
items are added/removed.

### Item
```
{
  order: string,             // fractional index (use the `fractional-indexing` npm package)
  title: string,
  durationSec: number,       // integer ≥ 0
  categoryId: string,
  personIds: string[],       // event People ids — enables array-contains queries
  notes?: string,
  script?: string,
  av: { audio?: string, video?: string, lighting?: string, camera?: string, slides?: string },
  imageSlide?: StoredImage | null,
  updatedAt: Timestamp, updatedBy: uid
}
```
Use fractional `order` keys so a drag only writes one document.

### Template (tenant-wide)
```
{
  name, description?,
  orientation: 'portrait'|'landscape',
  paper: 'A4',
  pageMode: { kind: 'flow' } | { kind: 'fit', pages: number },
  headerPages?: 'all'|'first', // omitted = all pages
  header: { [K in HeaderField]: { show: boolean, align: K extends 'logo' ? 'left'|'center'|'right' : 'left'|'right' } },
  itemStyle: 'table'|'cards'|'denseCards'|'cueCard'|'compact',
  columns: { key: ColumnKey, visible: boolean, width: 'auto' | `${number}px` | `${number}fr`, color?: string /* #RRGGBB text colour; omitted = layout default */ }[],
  filter: { scope: 'all'|'recipient'|'recipientPlusNeighbours', categoryIds: string[] | null },
  updatedAt
}
```
`HeaderField` = `sessionName | eventName | sessionDateTime | logo | sessionSubtitle | personName`.
`sessionSubtitle` is the legacy persisted key for the **Template name** header option; it renders
`template.name`, preserving existing templates' visibility and alignment settings.
`ColumnKey` = `start | duration | end | number | title | category | people | notes | script |
audio | video | lighting | camera | slides | imageSlide`.

### PackSettings (embedded in Person)
```
{
  enabled: boolean,                         // include person in global Print All
  sessionIds?: string[],                     // selected event sessions; omitted = all (legacy), [] = none
  templates: { templateId: string, copies: number }[],   // ordered
  sides: 'single'|'duplexLong'|'duplexShort',
  scaling: 'fit'|'actual'|'2up'|'4up',
  collate: boolean,
  newSheetPerTemplate: boolean,
  coverSheet: boolean
}
```

### StoredImage
`{ path: string, name: string, width: number, height: number, contentType: string }`

### Print history

`printRecords` documents contain `{ personId, sessionId, revision: SHA256, printedAt: ISO8601 }`.
They store a historical print snapshot, not current derived page counts or times. Members can
read them; only the authenticated `confirmPrint({ tenantId, jobId })` function writes them from
the completed export job's server-generated `revisions`. Jobs also store `eventId` and
`printConfirmedAt`. Confirmation is atomic, idempotent, limited to the job's creator, and cannot
replace a newer record. `renderAllPacks({ ..., reprintsOnly: true })` compares these records
against current recipient/session content and exports only the outstanding full sessions.

## Queries & indexes

- Sessions for an event ordered by `sortKey` — single-field, automatic.
- Items for a session ordered by `order` — single-field, automatic.
- "Items this person is on" across a session: `where('personIds','array-contains', id)` — automatic.
- "Used in N packs" for a template: computed client-side from people of loaded events (no index).

No composite indexes are required for v1; keep `firestore.indexes.json` empty but present.

## Deletion rules

- Deleting a session deletes its items (batched, client-side ≤ 500; use a callable function if larger).
- Deleting a person removes their id from `personIds` of all items in the event (batched).
- Categories and templates can't be deleted while referenced; offer archive instead.

## Security

`runsheetLinks` stores `{ token: 48-character random hex, createdBy, createdAt }`. Clients cannot
read, list or write these documents, including tenant members. The authenticated `shareRunsheet`
callable requires owner/editor access and creates or returns the person's stable token. The
unauthenticated `publicRunsheet` callable validates that token and renders only the current person's
selected sessions and template content. It does not grant public Firestore or Storage rule access.

See `reference/firestore.rules`. Summary: a user can read a tenant's subtree iff
`tenants/{t}/members/{uid}` exists; write iff role ∈ {owner, editor}; members writable by owner.
Storage rules mirror this using `firestore.exists()` / `firestore.get()`.
