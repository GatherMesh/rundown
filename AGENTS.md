# AGENTS.md — Rundown (event rundown + Session Pack printing)

You are building **Rundown**, a multi-tenant web app for planning event sessions as timed
rundowns and printing a different **Session Pack** PDF for each person with one click.

Read these before writing code, in this order:

1. `docs/SPEC.md` — product spec: entities, screens, behaviour, acceptance criteria
2. `docs/DATA_MODEL.md` — Firestore layout, TypeScript types, security rules, indexes
3. `docs/PDF_EXPORT.md` — template rendering, pagination, pack assembly, printing
4. `docs/DESIGN.md` — visual tokens and how to read the design files
5. `design/screens/*.png` — the approved designs (source of truth for layout)

Reference code (copy in, don't import from this folder):

- `reference/types.ts` — domain types to start `src/types/` from
- `reference/firestore.rules` — starting security rules
- `reference/seed.json` — seed data that matches the designs exactly

## Stack (fixed)

| Layer | Choice |
|---|---|
| Front end | Vue 3 (`<script setup>`, TypeScript, Composition API) + **Quasar 2** (Vite CLI) |
| State | Pinia stores wrapping Firestore listeners |
| Data | **Cloud Firestore** (realtime listeners, offline persistence on) |
| Files | **Firebase Storage** (tenant logos, item image slides) |
| Auth | **Firebase Auth** (Google + email link) |
| Server | **Cloud Functions for Firebase (2nd gen, Node 20, TypeScript)** — PDF rendering only |
| PDF | Puppeteer (`puppeteer-core` + `@sparticuz/chromium`) for page render, `pdf-lib` for pack assembly |
| Tests | Vitest (unit), Firebase Emulator Suite (rules + functions), Playwright (e2e, optional) |
| Lint | ESLint + Prettier, `strict: true` TS |

Light mode only. Desktop-first (1280–1440 px); must not break at tablet width.

## Repository layout to create

```
/app                 Quasar app
  /src/types         domain types (from reference/types.ts)
  /src/stores        Pinia: tenant, events, sessions, items, people, categories, templates, packs
  /src/pages         SessionsPage, TemplatesPage, ExportPage, PeoplePage, CategoriesPage
  /src/components    item table, item detail panel, template editor, pack editor
  /src/render        SHARED template renderer (Vue components + paginator) — used by the
                     in-app preview AND by the PDF function. Keep it framework-light and pure.
/functions           Cloud Functions: renderPack, renderAllPacks
/firestore.rules
/storage.rules
/firestore.indexes.json
```

The **shared renderer** is the most important architectural rule: the Templates page preview,
the Export page "Preview PDF" and the server PDF must all come from the same render code, so
what the user sees is what prints. Build it as a separate Vite entry (`/app/src/render/print.html`)
that takes a JSON payload and renders A4 pages; Puppeteer loads that same built page.

## Milestones (do them in order; each ends green on tests)

1. **Scaffold** — Quasar + Firebase wiring, emulators, auth, tenant switcher, app shell & nav.
2. **Reference data** — Categories page, Events, People page (event-scoped). Seed loader.
3. **Sessions** — session list, session header form, items table (drag reorder, computed start
   times), item detail panel (all fields incl. AV tabs + image slide upload), autosave.
4. **Renderer** — shared render package: header, 4 item styles, columns, filters, paginator.
5. **Templates** — editor + live preview ("Preview as <person>").
6. **Export** — per-person pack config, Preview PDF, Print pack, Print all packs (Cloud Function).
7. **Polish** — empty states, errors, keyboard shortcuts, performance pass.

## Working rules

- Match `design/screens/*.png` closely; use the tokens in `docs/DESIGN.md`. Theme Quasar via
  `quasar.variables.scss` rather than overriding component CSS ad hoc.
- Never store derived values (item start times, session end, page counts) in Firestore —
  compute them. See `docs/SPEC.md §Derived values`.
- Durations are integer **seconds**. Times are Firestore `Timestamp` + an IANA `timeZone` on the
  event (default `Australia/Brisbane`). Format with `Intl.DateTimeFormat`, never by hand.
- All tenant data lives under `tenants/{tenantId}/…`; every query is tenant-scoped.
- Write unit tests for: time computation, item filtering, pagination, pack assembly page/sheet
  counts. The worked examples in `docs/PDF_EXPORT.md §Worked examples` must pass as tests.
- If the spec is ambiguous, pick the simplest reading, implement it, and add a line to
  `docs/DECISIONS.md` (create it) explaining the choice. Don't stall.
