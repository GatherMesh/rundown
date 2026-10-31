# Implementation decisions

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
