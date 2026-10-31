# Rundown — handover package

Event rundown software with per-person printable **Session Packs**. This folder is the complete
brief for an implementing agent (Codex). Start with **`AGENTS.md`**.

```
AGENTS.md              stack, repo layout, milestones, working rules  ← start here
docs/SPEC.md           product spec, screens, acceptance criteria, decisions
docs/DATA_MODEL.md     Firestore collections, storage paths, queries, deletion rules
docs/PDF_EXPORT.md     renderer, pagination, pack assembly, one-click print, worked examples
docs/DESIGN.md         tokens, typography, Quasar mapping, how to read the design files
design/screens/        PNG of each designed screen and printed page (source of truth)
design/static/         same screens as static HTML
design/source/         original .dc.html design sources
reference/types.ts     TypeScript domain types + pure planner signatures
reference/firestore.rules
reference/seed.json    seed data matching the designs, with expected computed values
```

Stack: Vue 3 + Quasar 2, Firebase (Auth, Firestore, Storage, Cloud Functions 2nd gen),
Puppeteer + pdf-lib for PDFs. Light mode. A4 only in v1.

To use: copy this folder into a new repo root (or unzip it there), then ask Codex:
"Read AGENTS.md and implement milestone 1."
