import { readFile } from 'node:fs/promises';

export interface Credentials {
  apiUrl: string;
  idToken?: string;
  refreshToken?: string;
  apiKey?: string;
  authEmulatorUrl?: string;
}
export function validateUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Use an HTTPS API URL (HTTP is allowed only on localhost).');
  return url.toString().replace(/\/$/, '');
}
export async function loadCredentials(): Promise<Credentials> {
  const data: Credentials = process.env.RUNDOWN_CREDENTIALS_FILE
    ? JSON.parse(await readFile(process.env.RUNDOWN_CREDENTIALS_FILE, 'utf8'))
    : { apiUrl: process.env.RUNDOWN_API_URL ?? '', idToken: process.env.RUNDOWN_ID_TOKEN };
  if (!data.apiUrl || (!data.idToken && !(data.refreshToken && data.apiKey)))
    throw new Error(
      'Set RUNDOWN_CREDENTIALS_FILE to credentials downloaded from Rundown, or set RUNDOWN_API_URL and RUNDOWN_ID_TOKEN.',
    );
  data.apiUrl = validateUrl(data.apiUrl);
  if (data.authEmulatorUrl) {
    data.authEmulatorUrl = validateUrl(data.authEmulatorUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(data.authEmulatorUrl).hostname))
      throw new Error('Auth emulator must be localhost.');
  }
  return data;
}
export class ApiClient {
  private token = '';
  private expiresAt = 0;
  private refreshing?: Promise<string>;
  constructor(
    private credentials: Credentials,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async getToken() {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    if (this.refreshing) return this.refreshing;
    if (!this.credentials.refreshToken || !this.credentials.apiKey)
      return this.credentials.idToken!;
    this.refreshing = (async () => {
      const origin = this.credentials.authEmulatorUrl
        ? `${this.credentials.authEmulatorUrl}/securetoken.googleapis.com`
        : 'https://securetoken.googleapis.com';
      const response = await this.fetcher(
        `${origin}/v1/token?key=${encodeURIComponent(this.credentials.apiKey!)}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: this.credentials.refreshToken!,
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          'Authentication expired or revoked. Download fresh credentials from Rundown.',
        );
      const result = (await response.json()) as {
        id_token: string;
        refresh_token: string;
        expires_in: string;
      };
      if (!result.id_token || !Number.isFinite(Number(result.expires_in)))
        throw new Error('Invalid authentication response.');
      this.token = result.id_token;
      this.credentials.refreshToken = result.refresh_token || this.credentials.refreshToken;
      this.expiresAt = Date.now() + Math.max(0, Number(result.expires_in) - 60) * 1000;
      return this.token;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  private async request(path: string, options: RequestInit) {
    const response = await this.fetcher(`${this.credentials.apiUrl}/${path}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(310_000),
      headers: { ...options.headers, Authorization: `Bearer ${await this.getToken()}` },
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: { code: string; message: string };
      };
      if (response.status === 401) {
        this.token = '';
        this.expiresAt = 0;
      }
      throw new Error(
        result.error
          ? `${result.error.code}: ${result.error.message}`
          : `Rundown API returned HTTP ${response.status}.`,
      );
    }
    return response;
  }
  async call(operation: string, args: unknown): Promise<unknown> {
    const response = await this.request(operation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return ((await response.json()) as { data: unknown }).data;
  }
  async download(tenantId: string, path: string) {
    return this.request(`files?${new URLSearchParams({ tenantId, path })}`, { method: 'GET' });
  }
}
