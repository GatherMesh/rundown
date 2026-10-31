# Templates, pagination and Session Pack PDFs

The pipeline has four stages. Stages 1–3 are the **shared renderer** (`app/src/render`), used by
the in-app preview and by the Cloud Function. Stage 4 is server-only.

```
(session, template, recipient) ──1 build payload──▶ RenderPayload
RenderPayload ──2 filter items──▶ visible items (+ context items)
visible items ──3 render + paginate──▶ A4 pages (HTML) ──Puppeteer──▶ "document" PDF (n pages)
documents for a person ──4 assemble pack──▶ person PDF ──concat──▶ "Print all packs" PDF
```

## 1. Payload

```ts
interface RenderPayload {
  tenant: { name: string; logoUrl?: string };
  event: { name: string; timeZone: string; logoUrl?: string };
  session: { name: string; subtitle?: string; startAt: string /* ISO */ };
  items: ComputedItem[];            // ordered, with startSec/endSec offsets, number, category, people resolved
  template: Template;
  recipient: { id: string; name: string; role?: string } | null;  // null = preview without person
  meta: { copyIndex?: number; copyCount?: number };                 // footer "copy 1 of 2"
}
```
In the function, image paths are resolved to data URLs before rendering (no network at render time).
Fonts (Inter 400/500/600/700, JetBrains Mono 400/500) are bundled as local woff2 in the print app.

## 2. Filtering

1. Category filter: if `filter.categoryIds` is non-null, keep only those categories.
2. Scope:
   - `all` — everything.
   - `recipient` — items whose `personIds` include the recipient.
   - `recipientPlusNeighbours` — recipient items, plus the item immediately before and after each
     (from the category-filtered list) marked `context: true` and rendered dimmed / compact with a
     "Before" / "After" label (see `PackSpeaker.png`). De-duplicate; keep original order.
3. If `recipient` is null, `recipient*` scopes behave as `all` and the Person-name header shows
   "[Person name]".

Numbers and start times always come from the **full** session, not the filtered list.
When consecutive visible items have omitted items between them, show a dashed separator with
the omitted item numbers and their total duration. Keep it with the next visible item when
paginating (and only on the first segment of a continued cue card). This also exposes gaps
caused by category filters; leading/trailing omissions do not add separators.

## 3. Render + paginate

Page boxes in CSS px at 96 dpi: A4 portrait **794 × 1123**, landscape **1123 × 794**.
Margins 40–48 px (see PNGs). Each page = optional header + body + footer.
`template.headerPages` selects `all` (default when omitted) or `first`. First-page-only headers
leave the full body space available on subsequent pages, including fit mode and cue continuations.
Table column headings still repeat. Footer page numbers appear on every page and count within
each template document, restarting for each template/copy (not across the assembled pack).

- **Header**: fields per `template.header`; left group = logo + session name (h1) + event/subtitle
  line; right group = "Prepared for" + person name + date & time. Hidden fields collapse. Centre logo placement uses a middle column between equal-width left/right text groups.
- **Footer**: `{template name} · copy x of n` · `Runtime h:mm:ss · ends h:mm am` · `Page x of y`.
- **Item styles**
  - `table` — one row per item, header row repeated on each page, visible columns in order,
    widths from the template (`auto` → content, `px`, `fr`). Title cell shows category as a small
    caps line underneath. Rows ≥ 1 px rules. Recipient rows get a light tint (#F3F5F8).
  - `cards` — one bordered card per item: category · item no., title, start/length/finish,
    then each visible field as a labelled block; image slide as a 16:9 thumbnail. Context items
    render as a single compact line.
  - `denseCards` — the same single-column cards with tighter padding, smaller headings, inline
    field labels and smaller image thumbnails. Body text stays at 12 px; filtering, highlighting,
    field order and whole-card pagination behave like `cards`.
  - `cueCard` — **one item per page**, large type (script 15–18 px, line-height 1.6). A script
    longer than the page continues on following pages with "(cont.)" in the title.
  - `compact` — one line per item: start · title · people, with selected AV fields as a second line.
- **Paginator**: render every block into an off-screen measuring container at the body width,
  measure heights, then greedily fill pages (available height = page − header − footer − margins;
  table header row counts on every page). Never split a table row or card; a single block taller
  than a page gets its own page and its text is clipped with a visible "⋯ continues in app" marker
  (cue card script is the only content that flows across pages).
- **pageMode `fit` (N pages)**: binary-search a uniform scale in [0.6, 1.0] (apply to the body
  only, header stays 100%) for the largest scale that fits in N pages. If 0.6 still doesn't fit,
  render at 0.6 in flow mode and surface a warning in Templates/Export ("Needs 3 pages, set to 2").
- Signal completion with `window.__RENDER_DONE = { pageCount }` after fonts (`document.fonts.ready`)
  and all images have loaded.

The in-app preview renders the same components inside a scaled container.

## 4. Pack assembly (Cloud Function)

`renderPack({ tenantId, eventId, sessionId?, personId, jobId })` and
`renderAllPacks({ tenantId, eventId, sessionId?, jobId })` — callable functions.
Omit `sessionId` to render each recipient's checked sessions; supply it for just that session
(which must be checked for that recipient). Disabled people are excluded from global exports.
Explicit single-person exports remain available regardless of their global enable switch.
Deleted or moved-away session IDs are ignored. New packs start with no sessions; legacy packs
without `sessionIds` include all sessions. Sessions are ordered by start time within each person.

1. For each template in the person's pack, render one **document** (Puppeteer:
   `page.pdf({ preferCSSPageSize: true, printBackground: true })`, print CSS sets
   `@page { size: A4 landscape|portrait; margin: 0 }`). Cache by SHA-256 of the payload at
   `tenants/{t}/exports/cache/{hash}.pdf`; copies reuse the same document (footer copy numbers make
   payloads differ — render the footer copy number as a pdf-lib overlay instead so one render serves
   all copies).
2. Run the **pure planner** `planPack(settings, docPageCounts) → OutputPage[]` (unit-tested, no I/O):
   - **Units**: expand each template by `copies`. `collate: true` → each copy is a unit
     (A1 A2 B1). `collate: false` → each template is one unit whose pages repeat in place
     (p1 p1 p2 p2 …).
   - **Scaling / imposition** turns source pages into sheet sides:
     - `fit` — each source page scaled to A4 minus a 4 mm safe border. The front chooses the
       sheet orientation; a back with the opposite orientation rotates 90° before fitting.
     - `actual` — 100 %, centred, with the same 90° rotation for a mixed-orientation back.
     - `2up` — 2 pages per side on a sheet of the opposite orientation (two portrait pages
       side by side on landscape). `4up` — 2×2 grid, same orientation as the source.
       Each page is fitted into its cell, rotated 90° if that gives a larger scale.
   - **newSheetPerTemplate** — every unit starts on a fresh **sheet**: pad with blank sides so the
     unit begins on a front (duplex) / on a new side (single). For n-up, a unit also starts on a new
     side (no mixing units in one side).
   - **Sides**: `single` → 1 side per sheet. `duplexLong` → 2 sides per sheet.
     `duplexShort` → 2 sides per sheet, and in the combined job (always long-edge) every back side
     is rotated 180° to emulate short-edge flipping.
   - **coverSheet** — prepend a cover side (name large, role, session, event, date & time, list of
     contents "Producer Rundown ×2"). In duplex its back is blank.
   - **sheets** = number of sides ÷ (duplex ? 2 : 1), rounded up after padding.
3. Impose with `pdf-lib` (`embedPage` + `drawPage` with scale/rotation), stamp footers
   ("copy x of n"), set viewer preferences (`Duplex: DuplexFlipLongEdge` or `Simplex`,
   `PrintScaling: None`), upload to `tenants/{t}/exports/{sessionId}/{personId}.pdf`, return a
   signed URL.

### Combined job — "Print all packs"

One PDF, printed **two-sided, long edge**, so a single print dialog handles everyone.
"Print all for person" uses this same combined mode for that person’s checked sessions:

- People in Export-table order, enabled only; within each person, their checked sessions in chronological order.
- Every pack starts on the **front of a new sheet** (pad to an even number of sides).
- `single` packs: insert a blank back after **every** side.
- `duplexShort` packs: rotate back sides 180°.
- Viewer prefs `DuplexFlipLongEdge`. The client shows a one-line reminder: "Print two-sided, flip on
  long edge".

**One click**: the client calls `renderAllPacks`, fetches the PDF as a blob, loads it into a hidden
`<iframe>` via an object URL and calls `iframe.contentWindow.print()`; if the browser blocks that,
open the PDF in a new tab. "Download all (PDF)" saves the same file. Show progress
("Rendering 4 of 12 documents…") via a Firestore job doc `tenants/{t}/exportJobs/{jobId}` the
function updates.

## Worked examples (make these unit tests of `planPack` / the combined planner)

Doc page counts are inputs. "b" = blank side.

| # | Pack | Settings | Sides out | Sheets |
|---|---|---|---|---|
| A | Cue Cards (1p) ×2, Producer (1p) ×1 | duplexLong, fit, collate, newSheet | CC b CC b PR b = 6 | **3** |
| B | Producer (1p) ×2, Host Script (4p) ×1 | duplexLong, fit, collate, newSheet | PR b PR b HS1 HS2 HS3 HS4 = 8 | **4** |
| C | Producer (1p) ×1 | single, 2up | [PR + empty cell] = 1 | **1** |
| D | Audio Sheet (1p) ×2 | single, fit, newSheet | AS AS = 2 | **2** |
| E | T (3p) ×2 | single, fit, collate **false** | p1 p1 p2 p2 p3 p3 = 6 | **6** |
| F | T (10p) ×1 | duplexLong, 4up | [1–4] [5–8] [9–10] b = 4 | **2** |
| G | A (1p) ×1, B (1p) ×1 | duplexLong, fit, newSheet **false** | A B = 2 | **1** |
| H | Example A + coverSheet | as A | Cover b CC b CC b PR b = 8 | **4** |

Combined job of A + B + C + D (C and D are single-sided → blank backs):
A 6 + B 8 + C (1 + b) 2 + D (AS b AS b) 4 = **20 sides = 10 sheets**, every pack starting on a front.
