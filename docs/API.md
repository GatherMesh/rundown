# Rundown API and MCP

The authenticated HTTP API and local stdio MCP server expose the same operations and validation schemas. They use the existing Firestore data and PDF renderer, so changes appear in the app’s realtime listeners. No service-account credentials are needed by clients.

## Connect an MCP client

1. Build with `npm ci && npm run build` (Node 24.12+ for the repository tooling).
2. Deploy the `api` Cloud Function and Hosting rewrite using the deployment instructions in the README, or start the emulators for local use.
3. Sign in to Rundown. Open your avatar menu → **API & MCP access** → **Download credentials**.
4. Move `rundown-credentials.json` outside the repository, for example to `~/.config/rundown/credentials.json`, and restrict its permissions with `chmod 600`.
5. Configure a stdio MCP client using absolute paths:

```json
{
  "mcpServers": {
    "rundown": {
      "command": "node",
      "args": ["/absolute/path/to/rundown/mcp/dist/index.js"],
      "env": {
        "RUNDOWN_CREDENTIALS_FILE": "/absolute/path/to/credentials.json",
        "RUNDOWN_DOWNLOAD_DIR": "/absolute/path/to/downloads"
      }
    }
  }
}
```

Use the format your MCP client expects for its server configuration. Set its tool timeout to at least 310 seconds for PDF exports. The server writes protocol messages to stdout and startup errors to stderr. It exposes one `rundown_<operation>` tool per operation below, plus `rundown_upload_file` and `rundown_download_file` for local image uploads and PDF/image downloads.

For short-lived credentials instead, set `RUNDOWN_API_URL` and `RUNDOWN_ID_TOKEN`. Firebase ID tokens expire; credential files let the MCP server refresh them automatically. Tokens are never MCP tool arguments. Revocation and current tenant membership are checked on each API request. The file acts as your signed-in account across all its organisations. Use a separate Firebase user with limited tenant membership for an assistant that needs narrower access.

Start with `rundown_tenants_list`, then list events and sessions. Ask the assistant to use `rundown_sessions_rundown` to inspect timings, `rundown_packs_set` to configure a pack, `rundown_exports_render` to generate it, and `rundown_download_file` to save the returned Storage path. Physical printing still uses the browser or operating system print dialog.

**Disconnect:** avatar menu → **API & MCP access** → **Revoke all sessions**. This revokes all refresh tokens for your account, including other devices, and signs you out locally. It requires a sign-in within the last five minutes; sign out and sign in first if requested. Removing a member immediately removes that user’s API access to the organisation. Signing out alone does not revoke downloaded credentials.

## HTTP interface

Production direct base URL:

```
https://australia-southeast1-gathermesh-rundown.cloudfunctions.net/api/v1
```

Hosting also routes `/api/v1/*` to the function. Use the direct function URL for long PDF jobs to avoid Hosting’s shorter request timeout. Local base URL:

```
http://127.0.0.1:5001/demo-rundown/australia-southeast1/api/v1
```

- `GET /openapi.json`: public OpenAPI 3.1 schema, generated from the same validation contract as MCP.
- `POST /<operation>`: JSON body, `Authorization: Bearer <Firebase ID token>`.
- `GET /files?tenantId=<id>&path=<Storage path>`: authenticated file download.
- Responses: `{ "data": ... }`. Errors: `{ "error": { "code": "permission-denied", "message": "..." } }`. Invalid arguments also include field paths.
- Dates are `YYYY-MM-DD`; timestamps are ISO 8601 strings with offsets, returned in UTC. Durations are integer seconds. `timeZone` must be an IANA name.
- Lists return `{ records, nextCursor }`, ordered by document ID. Pass `limit` (1–100, default 100) and `after: nextCursor` until the cursor is null. Sort items by `order`, sessions by `startAt`, and categories by `order` when displaying lists. The `sessions_rundown` operation returns items in running order.
- Creates accept `{ ...scope, data }` and assign IDs. Gets/deletes accept `{ ...scope, id }`. Updates accept `{ ...scope, id, data }`, patch top-level fields and replace nested objects/arrays. Omit read-only fields such as `id`, `order` on items, `itemCount`, `sortKey`, audit timestamps, image `url` and derived timing.
- Unknown fields are rejected. There is no arbitrary Firestore path/query endpoint.

Example using an ID token in an environment variable:

```sh
export RUNDOWN_API_URL='https://australia-southeast1-gathermesh-rundown.cloudfunctions.net/api/v1'
curl --fail-with-body "$RUNDOWN_API_URL/events_list" \
  -H "Authorization: Bearer $RUNDOWN_ID_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"YOUR_TENANT_ID"}'
```

Create a timed item:

```json
{
  "tenantId": "YOUR_TENANT_ID",
  "eventId": "YOUR_EVENT_ID",
  "sessionId": "YOUR_SESSION_ID",
  "data": {
    "title": "Welcome",
    "durationSec": 240,
    "categoryId": "YOUR_CATEGORY_ID",
    "personIds": [],
    "av": { "audio": "Host microphone live" }
  }
}
```

Send this to `items_create`. New items append to the session; use `items_reorder` with `{ ...scope, id, beforeId }` to move one before another, or `beforeId: null` to move it to the end. Item counts update in the same transaction. Session updates automatically maintain `sortKey`.

## Operations and permissions

| Operations                                        | Scope                                       | Access                                         |
| ------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `tenants_list`, `tenants_create`                  | None                                        | Signed-in user                                 |
| `tenants_get`, `tenants_update`, `tenants_delete` | `id` is the tenant                          | Read: member; changes: owner                   |
| `events_*`, `categories_*`, `templates_*`         | `tenantId`                                  | Read: member; changes: editor/owner            |
| `sessions_*`, `people_*`                          | `tenantId`, `eventId`                       | Read: member; changes: editor/owner            |
| `items_*`                                         | `tenantId`, `eventId`, `sessionId`          | Read: member; changes: editor/owner            |
| `members_list`                                    | `tenantId`                                  | Member                                         |
| `members_set`, `members_remove`                   | `tenantId`, `uid`; set also takes `role`    | Owner                                          |
| `items_reorder`, `items_duplicate`                | Item scope plus `id`                        | Editor/owner                                   |
| `sessions_duplicate`                              | Event scope plus `id`, optional `name`      | Editor/owner                                   |
| `sessions_move`                                   | Event scope plus `id`, `destinationEventId` | Editor/owner                                   |
| `templates_duplicate`                             | Tenant scope plus `id`, optional `name`     | Editor/owner                                   |
| `sessions_rundown`                                | Full session scope                          | Member                                         |
| `packs_set`                                       | Event scope plus `personId`, `pack`         | Editor/owner                                   |
| `exports_render`                                  | Session scope, optional `personId`          | Member                                         |
| `exports_list`, `exports_get`                     | `tenantId`; get also takes `jobId`          | Member                                         |
| `assets_upload`, `assets_remove`                  | See below                                   | Tenant logo: owner; other images: editor/owner |
| `auth_revoke`                                     | None                                        | Recently signed-in user                        |

`*` means `list`, `get`, `create`, `update`, `delete`. See the OpenAPI document for the complete fields of templates, people, categories, sessions, events and packs.

Membership changes update `users/{uid}.tenantIds` alongside the membership, making the tenant visible in the app. Target users must already have a Firebase Auth account. Owners cannot remove or demote themselves. Tenant discovery uses the user profile, filtering out stale or unauthorized memberships; memberships added manually in Firestore must also update the profile.

Session moves match assigned people by email or name/role, creating missing destination people. Duplication retains shared image references. `categories_update` and `templates_update` accept `archived`; existing pack references continue to work when a template is archived.

## Images and exports

`assets_upload` takes `tenantId`, `name`, `contentType` (`image/png` or `image/jpeg`) and raw `base64` (no data-URL prefix). Omit the other IDs for a tenant logo, supply `eventId` for an event logo, or supply `eventId`, `sessionId`, `itemId` for a slide. The server validates the bytes, reads dimensions, uploads to a server-generated tenant path, and attaches the image. Images are limited to 10 MiB. Existing Firebase download URLs are generated for app previews, as with browser uploads. `assets_remove` detaches the reference; bytes remain because duplicates may share them.

`exports_render` renders one person when `personId` is supplied, otherwise all enabled packs. It returns `jobId`, `path`, PDF page/sheet counts and warnings. The call completes after rendering. Another client can inspect `exports_list`/`exports_get` while it runs. Failed jobs remain available there. Do not automatically retry a timed-out export: check its job first. The original `renderPack` and `renderAllPacks` callable functions remain available.

Download the returned `path` through `GET /files` with the bearer token, or `rundown_download_file`. MCP downloads stream into newly created files with restricted permissions. Exports use the same shared renderer and print settings as the application.

## Deletion and bounds

- Deleting a session atomically removes its items. Item deletion adjusts `itemCount` atomically.
- People with assignments cannot be deleted unless `removeAssignments: true` is provided; those assignments are removed atomically across the event.
- Referenced categories/templates cannot be deleted, including template references in disabled packs and category filters in templates. Archive them or remove the references first.
- Events must have no sessions or people. Organisations must have no events, categories, templates or export jobs. Empty organisation deletion also removes memberships/profile entries. Export/cache cleanup remains an administrator task; this API deliberately has no recursive organisation purge.
- Mutations refuse work requiring more than 450 writes or a scanned collection over 450 records. No partial batch is applied. Reduce the selection/workspace first; list endpoints remain paginated. The existing app has a separate callable for large session deletion.
- The API accepts bodies up to 14 MiB. PDF export limits remain 100 recipients, 500 session items and 1,000 printed sides per pack, with 1–20 copies per template.
- MCP is a local stdio server; the HTTP API is not a remote Streamable HTTP MCP/OAuth endpoint.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:api
npm run test:rules
```

`test:api` requires built functions, print renderer and MCP output. It starts isolated emulators under `demo-rundown`, exercises real authenticated HTTP requests and the built stdio server, renders/downloads PDFs, and removes its test tenants/users. It refuses to run without emulator environment variables. On macOS it uses installed Chrome for PDFs; otherwise configure `CHROME_EXECUTABLE_PATH`.

Protocol implementation follows the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/). Authentication uses Firebase’s [revocation-aware ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens) and [refresh-token endpoint](https://firebase.google.com/docs/reference/rest/auth#section-refresh-token).
