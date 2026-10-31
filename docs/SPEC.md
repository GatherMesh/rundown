# Rundown — Product Spec

## 1. Purpose

Event producers build a timed running order ("rundown") for each session of an event, then print
a **Session Pack** for each person involved. Each person's pack is different: which report
templates it includes, how many copies, how it's laid out and printed, and whose name is in the
header. The headline feature is **one-click printing of every person's pack**.

## 2. Entities and relationships

| Relationship | Meaning |
|---|---|
| Tenant 1:n Events | An organisation (e.g. "QCEC") owns many events |
| Tenant 1:n Categories | Item categories (Music, Spoken, Video…) are tenant-wide |
| Tenant 1:n Templates | Report templates are tenant-wide, reusable across events *(decision — see §9)* |
| Event 1:n Sessions | "Easter Convention 2027" has sessions like "Saturday Evening Celebration" |
| Event 1:n People | People are scoped to an event (speaker, host, audio tech…) |
| Session 1:n Items | A session's rundown is an ordered list of items *(the brief's "Items to Sessions 1:n")* |
| Items n:n People | An item has 0..n people; a person is on 0..n items |

### Item fields

| Field | Type | Required |
|---|---|---|
| Title | string | yes |
| Duration | seconds (edit as `mm:ss` or `h:mm:ss`) | yes |
| Category | ref → Category | yes |
| People | refs → event People (0..n) | no |
| Notes | plain text (multi-line) | no |
| Script | plain text (multi-line; v2 may be rich text) | no |
| AV notes | five plain-text fields: **Audio, Video, Lighting, Camera, Slides** | no |
| Image slide | one image file in Storage (+ width/height) | no |

### Session fields

Session Name, Event (ref), Date & start time, Subtitle. (Logo comes from the tenant, optionally
overridden on the event.)

## 3. Derived values (compute, never store)

- **Item start** = session start + sum of durations of all earlier items (by `order`).
- **Item end** = start + duration. **Session runtime** = sum of durations. **Session end** = start + runtime.
- **Item number** = 1-based position.
- Display times as `h:mm` (12-hour, no am/pm inside tables; with am/pm in headers), durations as `m:ss`
  or `h:mm:ss` when ≥ 1 hour. Use the event's `timeZone`.

## 4. Screens

Global shell (see every screen PNG): top bar with app mark, **tenant switcher**, nav tabs
**Sessions · Templates · Export · People · Categories**, save status ("Saved · just now"), avatar.

### 4.1 Sessions page — `design/screens/Main.png`

Three columns:

1. **Left sidebar** — Event picker (name, date range, session count). Sessions list grouped by
   day, each with start time; current session highlighted. "+ New session".
2. **Centre**
   - *Session card*: inputs for Session name, Event (select), Date, Start time, Subtitle. Buttons:
     Duplicate (copies session + items), **Print packs** (→ Export page for this session).
     Summary strip: item count, runtime, end time, number of distinct people.
   - *Items table*: columns ⠿ drag handle · # · Start · Dur · Item · Category (coloured pill) ·
     People · Attached (badges for Notes / Script / AV / Slide when non-empty).
     Drag to reorder; start times update live. Click a row to select it (blue left bar + tint).
     Footer: "+ Add item" and **Quick add** chips per category (adds an item of that category at
     the end, 5:00 default, focuses Title).
   - Keyboard: ↑/↓ moves selection, `Enter` focuses title in detail panel, `⌘/Ctrl+D` duplicates
     item, `Delete` deletes (with undo toast).
3. **Right detail panel** for the selected item: "Item N of M · starts h:mm", close ×. Fields:
   Title, Duration, Category, People (chips with role + remove, "+ Add person" autocomplete over
   event people, with "create new person"), Notes, Script ("Open full editor" opens a large
   dialog), **AV notes** as a 5-tab segmented control (a dot marks tabs with content), **Image
   slide** (thumbnail, filename, Replace, Remove; drag-and-drop upload; PNG/JPG ≤ 10 MB).

Autosave on blur / 600 ms debounce. Realtime: other editors' changes appear live.

### 4.2 Templates page — `design/screens/Templates.png`

1. **Left**: template list (name, orientation icon, "Landscape · Table rows"), "+ New".
2. **Centre**: editor for the selected template.
   - **Page**: Orientation (Portrait / Landscape segmented), Paper (A4, locked), Page count
     (*Flow onto as many pages as needed* | *Fit to N pages*).
   - **Header**: Show header on All pages (default) or First page only. Six toggles, each with a position (Left/Right; Logo also supports Centre): Session name, Event name,
     Session date & time, Logo, Session subtitle, **Person name** (filled per recipient at export).
     Every rendered page has a footer numbered "Page x of y" within that template document.
   - **Item style**: Table rows | Cards | Dense Cards | Cue card (one item per block, large script) | Compact list.
   - **Columns** (ordered, drag to reorder, each with a visible checkbox and width):
     Start, Duration, End, #, Title, Category, People, Notes, Script, Audio, Video, Lighting,
     Camera, Slides, Image slide. Width is `auto`, a px value, or `1fr`-style flex. In non-table
     styles, "columns" = which fields show and in what order.
     Each column has an optional text colour, saved per template, with a reset to the layout default.
     Cards and Dense Cards have a left accent in the item's category colour.
   - **Which items**: All items · Only the recipient's items · Recipient's items + one either side
     (neighbours render dimmed as context, as in `PackSpeaker.png`). Plus a category filter.
     Gaps between visible items show the omitted item numbers and duration.
   - Header shows "Used in N session packs". Buttons: Duplicate, Save template.
3. **Right**: live A4 preview (scaled), "Preview as <person>" select, "Page x of y · A4 landscape".
   Preview uses the current session (last one opened) and the shared renderer.

### 4.3 Export page — `design/screens/Export.png`

- Header: "Session packs", event name, summary of enabled people and total sheets across their
  selected sessions, **Download all (PDF)** and global **Print All**.
- People table (every person in the event): enable switch · avatar/name/role · templates with
  copy counts · selected session count · Scaling · total Sheets (computed) · Print all for person.
  The enable switch controls inclusion in global Print All; individual print actions remain available.
  Click a row to edit that person's pack in the side panel.
- **Side panel — pack settings for the selected person**
  - Duplicate config: choose another person in this event and replace their entire export
    configuration, including selected sessions and the Print All toggle. The recipient keeps
    their identity and item assignments; subsequent config edits are independent.
  - Sessions: checkbox per event session, with its name, event-local date/time and computed sheets.
    Preview and Print on each checked session produce just that person's sheets for that session.
    **Print all for person** produces every checked session in chronological order in one PDF.
  - Templates in this pack: ordered list (drag), copies stepper (−/×n/+). "+ Add template".
    The same templates and print settings apply to each checked session.
  - Sides: Single | Double · long edge | Double · short edge.
  - Scaling: Fit to A4 | Actual size | 2 per sheet | 4 per sheet.
  - Options: Collate copies · Start each template on a new sheet · Add a cover sheet with name.
  - Summary: total pages and sheets for the person's checked sessions. Preview all (PDF).
  - Sheet layout: a local session selector shows each sheet's front and back, identifying template,
    page, copy and blank sides. It changes only this layout preview, never the export selection.
    Mixed portrait/landscape backs rotate 90° automatically in Fit to A4 and Actual size.

Pack settings and selected session IDs are stored **per event person**. Global Print All groups
packs by person, then chronological session, with every session pack starting on a new sheet.
Existing packs without session IDs include all sessions; new packs start with none selected.

### 4.4 People page (not designed — follow the same visual system)

Event-scoped list: name, role, email (optional), initials override, items count in the selected
session. Add / edit / delete (block delete if on items; offer "remove from items").

### 4.5 Categories page (not designed)

Tenant-wide list with name, colour (pick from the 7 pill palettes in `DESIGN.md`, plus custom),
drag to reorder, item count. Delete only when unused.

## 5. Printed output

See `docs/PDF_EXPORT.md`. Reference pages: `design/screens/PackProducer.png` (landscape, table
rows, all items) and `design/screens/PackSpeaker.png` (portrait, cards, recipient + neighbours).

## 6. Permissions

Tenant members have a role: `owner` (manage members + everything), `editor` (edit all data),
`viewer` (read, preview, print). Enforced in `firestore.rules`.

## 7. Non-functional

- Session with 60 items renders the editor at 60 fps when dragging; table virtualisation not needed below 200 items.
- "Print all packs" for 10 people × 3 templates returns a PDF in < 20 s.
- Works offline for editing (Firestore persistence); printing needs connectivity.

## 8. Acceptance criteria (must pass)

1. Loading `reference/seed.json` reproduces the data in every design PNG (same times, totals, names),
   with two known mock-up slips: the Sessions summary should say **5 people** (distinct people
   assigned to items), not 8; and Export sheet counts are computed (see criterion 4).
   Expected values are in `seed.json → expected`.
2. Reordering item 7 above item 6 changes item 6's start from 7:38 to 8:13 and leaves the end time 8:41.
3. Template "Speaker Cue Cards" previewed as Rev. Margaret Hill shows Offering (dimmed, "Before"),
   Message (full card), Response song (dimmed, "After"), Benediction (full card) — matching PackSpeaker.png.
4. Margaret's pack for the seed session = **3 pages / 3 sheets**, and the pack-assembly worked
   examples in `PDF_EXPORT.md` pass as unit tests. (The Sheets numbers in `Export.png` are
   illustrative; real values are computed from rendered page counts.)
5. "Print all packs" produces one PDF in which every person's pack starts on the front of a new sheet
   and single-sided packs have blank backs (see PDF_EXPORT §Combined job).
6. Person name in each header is the recipient's.

## 9. Decisions already made (keep unless told otherwise)

- "1:n Items to Sessions" is read as **Session has many Items**; items are not shared across sessions.
  Duplicating a session copies items.
- Templates are **tenant-wide**; categories are tenant-wide; people are **event-scoped**.
- Pack settings live on the event person; a per-session override is out of scope for v1.
- Logo: tenant logo, overridable per event.
- Only A4 in v1 (keep `paper` in the model so Letter/A3 can be added).
- Script is plain text in v1.
