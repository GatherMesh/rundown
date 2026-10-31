import { z } from 'zod';

export const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const name = z.string().trim().min(1).max(300);
const text = z.string().max(100_000);
const uniqueIds = z
  .array(id)
  .max(100)
  .refine((v) => new Set(v).size === v.length, 'Duplicate IDs');
export const imageSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  name: z.string().min(1).max(255),
  width: z.number().int().positive().max(30_000),
  height: z.number().int().positive().max(30_000),
  contentType: z.enum(['image/png', 'image/jpeg']),
});
export const packSchema = z
  .strictObject({
    enabled: z.boolean(),
    sessionIds: uniqueIds.optional(),
    templates: z
      .array(z.strictObject({ templateId: id, copies: z.number().int().min(1).max(20) }))
      .max(20)
      .refine(
        (v) => new Set(v.map((r) => r.templateId)).size === v.length,
        'Use copies instead of duplicate templates',
      ),
    sides: z.enum(['single', 'duplexLong', 'duplexShort']),
    scaling: z.enum(['fit', 'actual', '2up', '4up']),
    collate: z.boolean(),
    newSheetPerTemplate: z.boolean(),
    coverSheet: z.boolean(),
  })
  .refine((p) => !p.enabled || p.templates.length > 0, 'An enabled pack needs a template');
const headerField = z.strictObject({ show: z.boolean(), align: z.enum(['left', 'right']) });
export const recordSchemas = {
  tenants: z.strictObject({ name, logo: imageSchema.nullable().optional() }),
  categories: z.strictObject({
    name,
    bg: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    fg: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    order: z.number().finite(),
    archived: z.boolean().optional(),
  }),
  events: z.strictObject({
    name,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    timeZone: z.string().min(1).max(100),
    venue: z.string().max(1000).optional(),
    logo: imageSchema.nullable().optional(),
  }),
  people: z.strictObject({
    name,
    role: z.string().max(300).optional(),
    email: z.union([z.email(), z.literal('')]).optional(),
    initials: z.string().max(10).optional(),
    pack: packSchema.optional(),
  }),
  sessions: z.strictObject({
    name,
    subtitle: z.string().max(1000).optional(),
    startAt: z.iso.datetime({ offset: true }),
  }),
  items: z.strictObject({
    title: z.string().trim().min(1).max(500),
    durationSec: z.number().int().min(0).max(86400),
    categoryId: id,
    personIds: uniqueIds.optional(),
    notes: text.optional(),
    script: text.optional(),
    av: z
      .strictObject({
        audio: text.optional(),
        video: text.optional(),
        lighting: text.optional(),
        camera: text.optional(),
        slides: text.optional(),
      })
      .optional(),
    imageSlide: imageSchema.nullable().optional(),
  }),
  templates: z.strictObject({
    name,
    archived: z.boolean().optional(),
    description: z.string().max(2000).optional(),
    orientation: z.enum(['portrait', 'landscape']),
    paper: z.literal('A4'),
    pageMode: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('flow') }),
      z.strictObject({ kind: z.literal('fit'), pages: z.number().int().min(1).max(100) }),
    ]),
    headerPages: z.enum(['all', 'first']).optional(),
    header: z.strictObject({
      sessionName: headerField,
      eventName: headerField,
      sessionDateTime: headerField,
      logo: headerField,
      sessionSubtitle: headerField,
      personName: headerField,
    }),
    itemStyle: z.enum(['table', 'cards', 'denseCards', 'cueCard', 'compact']),
    columns: z
      .array(
        z.strictObject({
          key: z.enum([
            'start',
            'duration',
            'end',
            'number',
            'title',
            'category',
            'people',
            'notes',
            'script',
            'audio',
            'video',
            'lighting',
            'camera',
            'slides',
            'imageSlide',
          ]),
          visible: z.boolean(),
          width: z.string().regex(/^(auto|(?:[1-9]\d{0,3})(?:\.\d{1,2})?(?:px|fr))$/),
        }),
      )
      .max(16)
      .refine((v) => new Set(v.map((c) => c.key)).size === v.length, 'Duplicate columns'),
    filter: z.strictObject({
      scope: z.enum(['all', 'recipient', 'recipientPlusNeighbours']),
      categoryIds: uniqueIds.nullable(),
    }),
  }),
};
export type Resource = keyof typeof recordSchemas;
export type Action = 'list' | 'get' | 'create' | 'update' | 'delete';
export interface Operation {
  description: string;
  schema: z.ZodObject;
  access: 'read' | 'edit' | 'owner' | 'signedIn';
  resource?: Resource;
  action?: Action;
  destructive?: boolean;
}
export const operations: Record<string, Operation> = {};
const tenantScope = { tenantId: id };
const eventScope = { ...tenantScope, eventId: id };
const sessionScope = { ...eventScope, sessionId: id };
const paging = { limit: z.number().int().min(1).max(100).optional(), after: id.optional() };
for (const [resource, schema] of Object.entries(recordSchemas) as [Resource, z.ZodObject][]) {
  const scope =
    resource === 'tenants'
      ? {}
      : resource === 'items'
        ? sessionScope
        : ['sessions', 'people'].includes(resource)
          ? eventScope
          : tenantScope;
  for (const action of ['list', 'get', 'create', 'update', 'delete'] as Action[]) {
    // Tenant removal is deliberately empty-only; members are removed atomically.
    const shape = {
      ...scope,
      ...(action === 'list' ? paging : action === 'create' ? { data: schema } : { id }),
      ...(action === 'update'
        ? {
            data: schema
              .partial()
              .refine((v) => Object.keys(v).length > 0, 'Provide at least one field'),
          }
        : {}),
      ...(resource === 'people' && action === 'delete'
        ? { removeAssignments: z.boolean().optional() }
        : {}),
    };
    operations[`${resource}_${action}`] = {
      resource,
      action,
      schema: z.strictObject(shape),
      access:
        resource === 'tenants'
          ? action === 'create' || action === 'list'
            ? 'signedIn'
            : action === 'get'
              ? 'read'
              : 'owner'
          : ['list', 'get'].includes(action)
            ? 'read'
            : 'edit',
      destructive: action === 'delete',
      description: `${action} ${resource}. ${action === 'list' ? 'Paginated by document ID; use nextCursor as after. Sort sessions by startAt, items by order, categories by order.' : action === 'update' ? 'Patch top-level fields; nested objects and arrays are replaced in full.' : action === 'delete' ? 'Rejects referenced categories/templates and nonempty events/organisations. Session deletion also deletes its items.' : ''}`,
    };
  }
}
function add(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  access: Operation['access'],
  destructive = false,
) {
  operations[name] = { description, schema: z.strictObject(shape), access, destructive };
}
add('members_list', 'List organisation members.', { ...tenantScope, ...paging }, 'read');
add(
  'members_set',
  'Add an existing Firebase user or change their role. Owner only; cannot change your own membership.',
  { ...tenantScope, uid: id, role: z.enum(['owner', 'editor', 'viewer']) },
  'owner',
);
add(
  'members_remove',
  'Remove a member and their organisation profile entry. Owner only; cannot remove yourself.',
  { ...tenantScope, uid: id },
  'owner',
  true,
);
add(
  'items_reorder',
  'Move an item before another item, or to the end with beforeId=null. Timing is recomputed.',
  { ...sessionScope, id, beforeId: id.nullable() },
  'edit',
);
add('items_duplicate', 'Copy an item to the end of its session.', { ...sessionScope, id }, 'edit');
add(
  'sessions_duplicate',
  'Copy a session and all its items within its event.',
  { ...eventScope, id, name: name.optional() },
  'edit',
);
add(
  'sessions_move',
  'Move a session to another event atomically. Match people by email or name/role, creating missing people.',
  { ...eventScope, id, destinationEventId: id },
  'edit',
  true,
);
add(
  'templates_duplicate',
  'Copy a template in the organisation.',
  { ...tenantScope, id, name: name.optional() },
  'edit',
);
add(
  'sessions_rundown',
  'Read the complete ordered rundown with derived item numbers, offsets, runtime, end time, and resolved people/categories. Nothing derived is stored.',
  sessionScope,
  'read',
);
add(
  'packs_set',
  'Replace a person’s event-wide pack settings.',
  { ...eventScope, personId: id, pack: packSchema },
  'edit',
);
add(
  'exports_render',
  'Generate a PDF with the shared renderer. Omit personId for all enabled people; omit sessionId for each person’s enabled sessions. Returns jobId, Storage path and counts; then download the file. May take several minutes.',
  { ...eventScope, sessionId: id.optional(), personId: id.optional() },
  'read',
);
add(
  'exports_list',
  'List export jobs and progress for an organisation.',
  { ...tenantScope, ...paging },
  'read',
);
add('exports_get', 'Read export job progress or failure.', { ...tenantScope, jobId: id }, 'read');
add(
  'assets_upload',
  'Upload a PNG/JPEG (base64, maximum 10 MiB) and attach it as a logo or item slide. Omit eventId for tenant logo; provide eventId for event logo; provide all IDs for item slide.',
  {
    ...tenantScope,
    eventId: id.optional(),
    sessionId: id.optional(),
    itemId: id.optional(),
    name: z.string().min(1).max(255),
    contentType: z.enum(['image/png', 'image/jpeg']),
    base64: z.string().min(4).max(13_981_016),
  },
  'edit',
);
add(
  'assets_remove',
  'Detach the logo or item slide. Existing bytes are retained because duplicated sessions/items may share them.',
  {
    ...tenantScope,
    eventId: id.optional(),
    sessionId: id.optional(),
    itemId: id.optional(),
  },
  'edit',
  true,
);
add(
  'auth_revoke',
  'Revoke all refresh tokens for your account (including MCP credentials). Requires a sign-in in the last five minutes.',
  {},
  'signedIn',
  true,
);

export function openApiDocument() {
  return {
    openapi: '3.1.0',
    info: { title: 'Rundown API', version: '1.0.0' },
    servers: [{ url: '/api/v1' }],
    security: [{ firebaseAuth: [] }],
    components: {
      securitySchemes: {
        firebaseAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID token' },
      },
    },
    paths: {
      ...Object.fromEntries(
        Object.entries(operations).map(([name, op]) => [
          `/${name}`,
          {
            post: {
              operationId: name,
              description: op.description,
              requestBody: {
                required: true,
                content: {
                  'application/json': { schema: z.toJSONSchema(op.schema, { io: 'input' }) },
                },
              },
              responses: {
                '200': { description: 'JSON { data: result }; timestamps are ISO 8601 strings.' },
                '400': { description: 'Invalid arguments' },
                '401': { description: 'Sign in again' },
                '403': { description: 'Insufficient tenant role' },
                '404': { description: 'Missing record' },
                '409': { description: 'Reference or state conflict' },
              },
            },
          },
        ]),
      ),
      '/files': {
        get: {
          operationId: 'download_file',
          description: 'Download an export PDF or image with the same Firebase bearer token.',
          parameters: [
            { name: 'tenantId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'File bytes',
              content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            '403': { description: 'Not a tenant member' },
            '404': { description: 'File not found' },
          },
        },
      },
    },
  };
}
