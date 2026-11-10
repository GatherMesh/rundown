# Implementation decisions

- Each newly generated PDF gets one print timestamp (date, time with seconds and the event's
  timezone), stamped during final sheet assembly so cached template PDFs never reuse an old
  date. Stamp every content side and cover; padding backs stay blank. N-up layouts reserve a
  small footer band so the timestamp remains readable at physical sheet size.
- Export tracks the last confirmed printed snapshot per event/person/session in server-only
  `printRecords`. After a successful print the operator chooses **Mark as printed**; previews,
  downloads and cancelled dialogs do not advance the baseline. Existing paper copies cannot be
  inferred, so tracking starts with the first confirmed print. Changes to a selected template,
  print settings, session header/runtime or a recipient's filtered items require a full session
  reprint, including every configured template and copy. Item comparisons conservatively include
  all fields on included items, even hidden fields. Edit metadata and image download URLs are
  ignored. Global enable switches and cover/selected-session changes do not dirty session pages.
  Reprints include previously printed people even if excluded from Print All, but only their
  currently selected sessions, and omit person-wide covers. Confirm the snapshot actually
  generated, retaining any newer edits as outstanding; an older job cannot replace a newer print
  record. Print jobs are limited to 450 person/session combinations for atomic confirmation.

- Template name replaces Session subtitle in the print header and uses the template's existing
  editable name. Keep the persisted `header.sessionSubtitle` key so saved visibility/alignment
  settings and API clients continue to work without a data migration; session subtitles remain
  editable on sessions but no longer print in this header slot.

- Cover sheets belong to the person’s full pack: one before all selected sessions, with the
  event, session count/date range and templates per session. Individual session exports omit
  covers. The Export summary counts the cover once, separately from session-only sheet counts.

- Cards and Dense Cards use the category's existing foreground colour for a 4 px left accent,
  including compact context neighbours. Per-template column `color` overrides text (labels and
  values) in all styles; omitted/reset colours preserve layout defaults. Accents remain category-based
  even when the Category field is hidden or has a custom text colour. Image pixels are unchanged.

- Duplicating an export config replaces another existing event person's complete pack settings,
  including session selection and enabled state, after choosing the recipient in a replacement
  dialog. It does not duplicate the person or item assignments. Legacy all-session selection is
  preserved; copied arrays are independent. The copied pack uses the recipient's name and items.

- Export selection is per person via `pack.sessionIds`; no global session selection. Omitted IDs preserve all-session coverage for legacy packs, while new packs start with `[]`. Editing the checkboxes saves an explicit list, so future sessions require selection. Deleted/moved-away IDs are ignored. The existing person enable switch controls global Print All only. Both global Print All and Print all for person group sessions chronologically and use the combined long-edge duplex assembly, with a fresh sheet for every session pack.

- Templates can show the header on all pages or only the first; existing templates default to all. Later pages reclaim the header space. Every page retains "Page x of y" in its footer, numbered within that template document rather than across copies, cover sheets or the assembled pack.

- A duplex sheet uses the front's orientation; a differently oriented back rotates 90° in both Fit to A4 and Actual size (which retains 100% scale). Pack order determines the front/back sequence; the Export panel lists the actual planned sheets, including blank sides.
- Filtered reports mark omitted middle runs with item numbers and duration, including category-filter gaps. Separators stay with the next visible item and do not repeat on cue-card continuations. Leading/trailing omissions are left unmarked; recipient and neighbour selection is unchanged.

- Dense Cards is an additional template item style (`denseCards`): a denser single-column version of Cards, using the same fields and shared renderer, with inline labels and 12 px body text. It retains whole-card pagination and the existing oversized-card continuation notice.

- The Organisation page lets owners upload or replace the tenant logo (PNG/JPG, up to 10 MB), matching existing tenant-document permissions. Other members can view it. It saves immediately and uses the existing template/logo rendering; event logos retain priority. Replaced files are retained, consistent with the existing asset API.

- Sessions and templates have explicit Delete confirmation dialogs. Session deletion removes its item documents; up to 499 items plus the session are deleted atomically in the client, with a callable function for larger sessions. Uploaded image files are retained because duplicated sessions/items can share their paths.
- Template deletion checks packs in every tenant event, including disabled packs, and requires connectivity. Referenced templates can be archived instead: existing packs still render them, but new pack selections omit archived templates. Show archived exposes them for unarchiving or deletion after their pack references are removed.

- Firebase Hosting is the deployment target alongside Firebase Auth, Firestore, Storage, and Functions. Local development uses a `demo-rundown` emulator project; production config is supplied separately.
- Follow the written neighbour-filter algorithm: Margaret's speaker report includes the walk-out item after Benediction. The supplied screenshot and acceptance criterion omit that neighbour despite specifying one either side.
- A single Pinia workspace store owns scoped listeners and pending writes, so changing tenant/event/session tears down subscriptions together.
- The supplied seed uses named sample slide paths without image files. These render as labelled placeholders until an image is uploaded.
- Source documents keep their natural A4 orientation; a mixed-orientation n-up side uses its first source page to choose sheet orientation and fits other pages into its cells.
- Use Node 22 for Cloud Functions: Google decommissioned Node 20 on 2026-10-30, one day before implementation (https://docs.cloud.google.com/functions/docs/runtime-support).
- Table-style Category appears underneath Title when both fields are enabled, matching the approved printed design and avoiding a duplicate Category column. Other visible columns retain their configured order.
- Card-style timing, title, category and item number form a compact card heading; the remaining fields retain their configured order.
- Moving a session to another event atomically copies its items and matches assigned people by email or name/role, creating destination people when needed; the original session is removed only in the same successful batch.
- Browser printing uses PDF viewer preferences plus an explicit one-line reminder. Physical printer settings are controlled by the browser and printer driver.
- Highlight recipient-assigned items in every print layout with the primary light tint (#EEF3FF), including shared assignments; context neighbours remain unhighlighted. This makes the original faint table-only tint clearer in person-specific previews and exports.

- Add an authenticated HTTP operation API as an explicit expansion beyond PDF-only Cloud Functions. A local stdio MCP server calls that API with Firebase user credentials; both surfaces share strict input schemas and tenant roles. Remote MCP/OAuth hosting is outside this change.
- API mutations use transactions, validate references and maintain session item counts. They are limited to 450 writes/scanned records, with empty-only event/tenant deletion and no recursive tenant purge. API timestamps are ISO 8601; stored timestamps remain Firestore Timestamp values.
- The avatar menu exports user credentials for API/MCP access. Credential files contain refresh tokens, are ignored by Git, and can be revoked through recent-sign-in-only session revocation. API image uploads generate the same preview download URLs as app uploads.

- Logo placement supports Centre (`center`), placing the logo or tenant-name fallback at the horizontal centre of the header between equal-width text groups. Other header fields retain Left/Right placement; hidden logos retain the existing two-column layout.

- Header logos preserve their aspect ratio and fit the height set by the visible text (or the existing minimum header height), limited by the remaining width. Long text wraps while reserving a minimum 56 px logo slot. Left/right logos sit alongside the text in both page orientations; centred logos remain at the page centre. The logo itself never increases header height.

- Email sends the full configured multi-session pack as a separate PDF attachment for each selected event person, independent of Print All and print tracking. Owners and editors of sender-enabled tenants may send via Resend. The styled HTML and plain-text versions reuse the existing stable person runsheet link; the PDF is a snapshot and the link shows current saved content. Each export job is the idempotency key for retries within 23 hours. Attachments are limited to 25 MB before encoding.

- Email composition has an editable subject (defaulting to the event name) and an optional shared plain-text message after the greeting. Drafts stay on the Email page for the current page visit. Message line breaks are preserved and HTML is escaped. Queued compositions are immutable; retry keeps the same address/content and completed export job, while editing content requires a new composition.

- Owners/editors can copy a stable public runsheet link per event person. A random 192-bit token lives in the server-only `tenants/{tenantId}/events/{eventId}/runsheetLinks/{personId}` document. Anyone with the link can read current selected sessions, regardless of the Print All toggle. The callable returns only rendered visible content, never raw people records or emails; ordinary Firestore access remains private. The mobile view uses the shared renderer's fields, filters, context and highlights as continuous cards, showing each configured template once and ignoring print copies, covers, scaling and pagination. Content reloads on opening, session selection or Refresh. Deleted people/events/tenants and deselected sessions stop being available through existing links.

- Generic session links use the same sharing and public-read callables, with a separate server-only token at `tenants/{tenantId}/events/{eventId}/sessionRunsheetLinks/{sessionId}`. Export provides a session picker and Copy session link. A generic link is limited to that session and shows all items and all item fields using a built-in Full runsheet view, with no recipient, pack or saved-template dependency. Names are resolved for assigned people; email addresses and update metadata remain private. Existing person-specific URLs and tokens keep working.

- Email composition and delivery history live on an event-scoped Email page with Compose/Queue tabs. A callable atomically creates up to 100 recipient jobs under `events/{eventId}/emailJobs`; Firestore write events drive a background worker, using existing Firebase infrastructure. Jobs continue after the browser closes. The worker uses a transactional ten-minute lease, attempt numbers and server-only queue writes to tolerate duplicate or interrupted events. Normal failures are visible and manually retryable; no automatic resend is attempted for handled provider errors. Jobs are processed as worker capacity allows, without a strict FIFO guarantee. Rundown data is read when PDF preparation begins; address/subject/message are fixed at enqueue.

- Email attachments remove only blank padding pages produced by our own assembler (no content streams), keep all rendered pages/covers/copies/n-up layout, and undo printer-only short-edge page rotations. Print PDFs are unchanged. Metadata preservation keeps attachment bytes stable across safe retries. Queue history shows the latest 100 jobs in the current event.
