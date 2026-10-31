import { afterEach, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../mcp/src/server';
import { ApiClient, validateUrl } from '../mcp/src/client';
import { operations } from '../functions/src/api-contract';
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((f) => f()));
});
it('discovers and invokes the real MCP tools through a protocol client', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { records: [{ id: 'tenant' }], nextCursor: null } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const server = createServer(
    new ApiClient({ apiUrl: 'https://rundown.test/api/v1', idToken: 'secret' }, fetcher),
  );
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  closing.push(
    () => client.close(),
    () => server.close(),
  );
  await Promise.all([server.connect(a), client.connect(b)]);
  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(Object.keys(operations).length + 2);
  expect(
    tools.tools.find((t) => t.name === 'rundown_items_delete')?.annotations?.destructiveHint,
  ).toBe(true);
  const result = await client.callTool({ name: 'rundown_tenants_list', arguments: {} });
  expect(result.structuredContent).toEqual({
    data: { records: [{ id: 'tenant' }], nextCursor: null },
  });
  expect(fetcher.mock.calls[0]).toMatchObject([
    'https://rundown.test/api/v1/tenants_list',
    { headers: { Authorization: 'Bearer secret' } },
  ]);
  const bad = await client.callTool({
    name: 'rundown_items_create',
    arguments: { tenantId: '../evil' },
  });
  expect(bad.isError).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('returns API failures as tool errors', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: 'permission-denied', message: 'Editor access required.' },
        }),
        { status: 403 },
      ),
  );
  const server = createServer(
    new ApiClient({ apiUrl: 'https://rundown.test/api/v1', idToken: 'secret' }, fetcher),
  );
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  closing.push(
    () => client.close(),
    () => server.close(),
  );
  await Promise.all([server.connect(a), client.connect(b)]);
  const result = await client.callTool({ name: 'rundown_tenants_list', arguments: {} });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    { type: 'text', text: 'permission-denied: Editor access required.' },
  ]);
});
it('refreshes credentials once for concurrent calls and keeps credentials out of tool inputs', async () => {
  const fetcher = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).includes('securetoken')
            ? { id_token: 'fresh', refresh_token: 'new-refresh', expires_in: '3600' }
            : { data: {} },
        ),
      ),
  );
  const client = new ApiClient(
    { apiUrl: 'https://rundown.test/api/v1', refreshToken: 'refresh', apiKey: 'key' },
    fetcher,
  );
  await Promise.all([client.call('tenants_list', {}), client.call('tenants_list', {})]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.filter(([u]) => String(u).includes('securetoken'))).toHaveLength(1);
});
it('refuses insecure non-local endpoints and credential-bearing URLs', () => {
  for (const url of [
    'http://example.com/api',
    'https://user:pass@example.com/api',
    'https://example.com/api?token=secret',
  ])
    expect(() => validateUrl(url)).toThrow();
  expect(validateUrl('http://127.0.0.1:5001/api/v1/')).toBe('http://127.0.0.1:5001/api/v1');
});
