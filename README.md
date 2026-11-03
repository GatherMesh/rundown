# GatherMesh Rundown

Vue 3 + Quasar event rundown editor backed by Firebase Auth, Firestore, Storage, and Node 22 Cloud Functions. Light-mode interface based on the supplied handover designs.

Production: https://gathermesh-rundown.web.app
Firebase project: `gathermesh-rundown`, Sydney (`australia-southeast1`).

## Included

- Multiple organisations and events, event-scoped people, tenant-wide categories and templates.
- Realtime sessions with autosave, offline persistence, computed timing, drag reorder, quick-add, duplication, item deletion with undo, AV fields and slide uploads.
- A4 portrait/landscape templates with configurable headers, fields, widths, text colours, filters and five item styles. Cards and Dense Cards use category-coloured left accents; live recipient previews use the same measured renderer as server PDFs.
- Person-specific session selections and packs with ordered templates, copies, collating, covers, duplex settings, 2-up/4-up imposition, download and browser printing.
- Public mobile runsheets: Copy Link for each person on Export, with session/view selection and the same template content in a continuous scroll.
- Tenant membership rules with owner/editor/viewer permissions, image-upload restrictions and authenticated callable exports.

## Local development

Use Node 24.12+ for the current Firebase browser SDK and test tooling (`nvm use`), npm 11, and Java 21+ for emulators. The deployed functions run Node 22.

```sh
npm ci
cp app/.env.example app/.env.local
npm run emulators
```

In another terminal:

```sh
npm run dev
```

Open http://localhost:9000. The emulator automatically signs in a local anonymous producer. Create an organisation and choose the sample event to load the handover data.

For the deterministic export smoke test, seed the separate local `qcec` tenant:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm run seed
node scripts/smoke-export.mjs
```

The seeded local account is `producer@example.com` / `rundown-demo`. These credentials are only used by the emulator. On macOS the PDF emulator uses installed Google Chrome; on other hosts set `CHROME_EXECUTABLE_PATH` or use the bundled Linux Chromium.

## Verification

```sh
npm run typecheck
npm test
npm run test:rules
npm run test:render
npm run build
```

If emulators are already running, run `npx vitest run tests/rules.test.ts` directly. Rules tests use test tenants `a` and `b` in the emulator. The export smoke test writes temporary PDFs into ignored `artifacts/`.

With seeded emulators and the dev server running, `node scripts/smoke-public-runsheet.mjs` checks Copy Link (including clipboard denial), anonymous access, session/view selection, template filters, invalid links and layouts from 320–1280 px. It saves screenshots in `artifacts/` and uses installed Google Chrome on macOS (`CHROME_EXECUTABLE_PATH` overrides it).

## Deployment

`app/.env.prod` contains the Firebase web app config and `VITE_USE_EMULATORS=false`. Quasar uses `.env.prod` for builds and `.env.local` for development. Keep these local files out of Git. Firebase web config values identify the project; authorization is enforced by Auth and security rules.

```sh
firebase login
npm run typecheck
npm test
npm run build
firebase deploy --project gathermesh-rundown --only hosting,firestore,storage,functions
```

Functions predeploy builds both the application and the standalone print document. Do not exclude every directory named `src` from function uploads: the bundled print document lives at `functions/print/src/render/print.html`.

If an initial function creation fails and a retry leaves the new `api` or `deleteSession` endpoint returning Cloud Run 403 errors, run `node scripts/cloud-setup.mjs functions-access` to restore browser invocation. The handlers still enforce Firebase authentication and tenant roles; this only allows requests to reach them.

Storage rules check tenant membership in Firestore. Provision the required service-agent access with `node scripts/cloud-setup.mjs storage-rules-access`; non-interactive Firebase deployments skip this IAM setup. This grants only `roles/firebaserules.firestoreServiceAgent` to the project's Firebase Storage service agent. Run `node scripts/production-smoke.mjs` to verify exports through the signed-in client Storage SDK, including denial for non-members and signed-out users. The smoke test creates and removes its own isolated QA tenant and user.

Google sign-in is configured in `firebase.json`; email-link sign-in is enabled in the Firebase project. `scripts/cloud-setup.mjs` records the provisioning calls, using an existing authenticated Firebase CLI session in memory. It never stores access tokens. The Storage bucket CORS allowlist permits the two Firebase Hosting domains and localhost:9000.

The production app starts with no organisation data. Sign in, create your organisation, and optionally include the sample event. Creating a new tenant creates its owner membership atomically. Role/member management is available through the authenticated API/MCP (`members_set` and `members_remove`); there is no separate member-management screen.

## Print behavior

On **Export**, owners/editors can use **Copy Link** beside any person to share their mobile runsheet.
Anyone with that link can view their currently selected sessions and templates without signing in.
Links remain the same as content and pack selections change; open, change session or use **Refresh**
to load saved updates. Each template appears once, with its fields, filters and recipient highlights;
print copies, covers and page breaks are omitted. Empty packs show an empty state until configured.
Deploy Hosting and the `shareRunsheet` / `publicRunsheet` Functions together to enable this feature.

Individual session PDFs set the selected duplex viewer preference. Print all for person includes that person’s checked sessions; global Print All includes every enabled person’s checked sessions. Combined jobs always use two-sided, long-edge printing; single-sided recipients receive blank backs, and short-edge backs rotate 180°. Browser/printer settings can override PDF preferences, so the app displays the required setting before printing.

Margaret's sample pack has 3 content pages and 3 sheets (6 PDF sides, including blanks). All enabled sample packs have 17 content pages and 15 sheets. The handwritten example pack-planning tests are separate from these actual rendered counts.

Sample slide references have no supplied image files. They print as filename placeholders until replaced with an uploaded image. See `docs/DECISIONS.md` for the neighbour-filter discrepancy and runtime update.

## Limits

A PDF request accepts up to 100 recipients / 100 sessions / 500 items per session and 1,000 sides per pack. Copies are limited to 20 per template. A session move is one atomic batch and refuses moves that would exceed 450 writes. Non-cue blocks taller than a page display a visible clipping notice; cue scripts continue over pages. Print jobs and cached PDFs remain in tenant Storage until removed by the project owner.

## API and MCP

Rundown includes a Firebase-authenticated HTTP API and a local stdio MCP server for controlling organisations, members, events, sessions, items, people, categories, templates, pack settings, images and PDF exports. Both use the same operation schemas and existing tenant roles.

After building/deploying, open the avatar menu → **API & MCP access** to download credentials. Configure your MCP client to run `node /absolute/path/to/rundown/mcp/dist/index.js` with `RUNDOWN_CREDENTIALS_FILE` pointing to that private file. The HTTP schema is available at `/api/v1/openapi.json`.

See [API and MCP setup, operations and examples](docs/API.md). Run `npm run test:api` after building to exercise the HTTP API, stdio MCP and PDF exports against local emulators.
