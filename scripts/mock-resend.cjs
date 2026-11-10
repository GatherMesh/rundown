// Emulator-only provider stub. Use with NODE_OPTIONS=--require=<absolute path to this file>.
// It never sends email and only accepts the seeded smoke-test recipients.
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://api.resend.com/emails') return originalFetch(url, options);
  const body = JSON.parse(options.body);
  if (!['priya@example.com', 'margaret@example.com'].includes(body.to?.[0]))
    throw new Error('The smoke-test provider refuses other recipients.');
  const key = options.headers['Idempotency-Key'];
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Missing send idempotency key.');
  const directory = resolve(__dirname, '../artifacts/email-deliveries');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, key + '.json');
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (previous && JSON.stringify(previous.body) !== JSON.stringify(body))
    return new Response(JSON.stringify({ message: 'Idempotency payload changed' }), {
      status: 409,
    });
  const count = (previous?.count ?? 0) + 1;
  writeFileSync(path, JSON.stringify({ body, count }));
  const failed = body.to[0] === 'priya@example.com' && count === 1;
  return new Response(
    JSON.stringify(failed ? { message: 'Simulated temporary provider failure' } : { id: key }),
    {
      status: failed ? 503 : 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
};
