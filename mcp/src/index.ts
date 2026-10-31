#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ApiClient, loadCredentials } from './client';
import { createServer } from './server';
try {
  const credentials = await loadCredentials();
  serveStdio(() => createServer(new ApiClient(credentials)));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not start Rundown MCP.');
  process.exitCode = 1;
}
