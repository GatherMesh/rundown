import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { mkdir, open } from 'node:fs/promises';
import { resolve, basename, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { operations, id } from '../../functions/src/api-contract';
import { ApiClient } from './client';

function result(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
  };
}
async function handled(fn: () => Promise<unknown>) {
  try {
    return result(await fn());
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error instanceof Error ? error.message : 'Rundown request failed.',
        },
      ],
    };
  }
}
export function createServer(
  client: ApiClient,
  downloadDirectory = process.env.RUNDOWN_DOWNLOAD_DIR ?? resolve('artifacts/rundown-downloads'),
) {
  const server = new McpServer(
    { name: 'rundown', version: '1.0.0' },
    {
      instructions:
        'Control Rundown using authenticated tenant-scoped tools. Start with rundown_tenants_list. IDs come from list/create responses. Lists paginate by ID; pass nextCursor as after until null. Durations are integer seconds; startAt uses ISO 8601 with offset. Nested objects in updates are replaced. Use rundown_sessions_rundown for computed timing. Exports render PDFs; download them with rundown_download_file. Printing to a physical device requires the user’s print dialog.',
    },
  );
  for (const [name, op] of Object.entries(operations)) {
    server.registerTool(
      `rundown_${name}`,
      {
        description: op.description,
        inputSchema: op.schema,
        annotations: {
          readOnlyHint: (op.access === 'read' && name !== 'exports_render') || op.action === 'list',
          destructiveHint: op.destructive ?? false,
          idempotentHint: op.action === 'get' || op.action === 'list',
          openWorldHint: false,
        },
      },
      async (args) => handled(() => client.call(name, args)),
    );
  }
  server.registerTool(
    'rundown_upload_file',
    {
      description:
        'Upload a local PNG/JPEG and attach it as an organisation/event logo or item slide. Same scopes as assets_upload; reads only the supplied absolute file path.',
      inputSchema: z.strictObject({
        tenantId: id,
        eventId: id.optional(),
        sessionId: id.optional(),
        itemId: id.optional(),
        filePath: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ filePath, ...args }) =>
      handled(async () => {
        if (!isAbsolute(filePath)) throw new Error('filePath must be absolute.');
        const file = await open(filePath, 'r');
        let bytes: Buffer;
        try {
          if (!(await file.stat()).isFile() || (await file.stat()).size > 10 * 1024 * 1024)
            throw new Error('Choose a PNG/JPEG file up to 10 MiB.');
          bytes = await file.readFile();
          if (bytes.length > 10 * 1024 * 1024) throw new Error('File exceeds 10 MiB.');
        } finally {
          await file.close();
        }
        const contentType = bytes[0] === 137 && bytes[1] === 80 ? 'image/png' : 'image/jpeg';
        return client.call('assets_upload', {
          ...args,
          name: basename(filePath),
          contentType,
          base64: bytes.toString('base64'),
        });
      }),
  );
  server.registerTool(
    'rundown_download_file',
    {
      description:
        'Save an exported PDF or image to RUNDOWN_DOWNLOAD_DIR (default: artifacts/rundown-downloads). Returns the absolute local path. Never overwrites existing files.',
      inputSchema: z.strictObject({ tenantId: id, path: z.string().min(1).max(1024) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ tenantId, path }) =>
      handled(async () => {
        const response = await client.download(tenantId, path);
        await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
        const filePath = resolve(
          downloadDirectory,
          `${randomUUID()}-${basename(path).replace(/[^A-Za-z0-9._-]/g, '_')}`,
        );
        const file = await open(filePath, 'wx', 0o600);
        try {
          if (!response.body) throw new Error('Empty download response.');
          for await (const chunk of response.body) await file.writeFile(chunk);
        } finally {
          await file.close();
        }
        return { filePath, contentType: response.headers.get('content-type') };
      }),
  );
  return server;
}
