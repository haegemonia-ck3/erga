import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import { PublicError } from './config.js';

export function githubAuth(c: Partial<Pick<Config, 'githubApp' | 'githubToken'>>, request: typeof fetch = fetch): () => Promise<string> {
  if (!c.githubApp) {
    if (!c.githubToken) throw new PublicError('Configure a GitHub App or GITHUB_TOKEN.');
    return async () => c.githubToken!;
  }
  const app = c.githubApp;
  if (!/^\d+$/.test(app.installationId)) throw new PublicError('GITHUB_INSTALLATION_ID must be numeric.');
  const key = readFileSync(app.privateKeyPath, 'utf8');
  let cached: { token: string; expires: number } | undefined;
  let inflight: Promise<string> | undefined;
  const refresh = async () => {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const signingInput = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: app.appId })}`;
    const jwt = signingInput + '.' + createSign('RSA-SHA256').update(signingInput).sign(key, 'base64url');
    const response = await request(`https://api.github.com/app/installations/${app.installationId}/access_tokens`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Erga-Hegemonia' },
    });
    if (!response.ok) throw new PublicError(`GitHub App authentication failed (HTTP ${response.status}). Check the App ID, installation ID, and private key.`);
    const result = await response.json() as { token: string; expires_at: string };
    if (!result.token || !Number.isFinite(Date.parse(result.expires_at))) throw new PublicError('GitHub returned an invalid installation token response.');
    cached = { token: result.token, expires: Date.parse(result.expires_at) };
    return cached.token;
  };
  return async () => {
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    inflight ??= refresh().finally(() => { inflight = undefined; });
    return inflight;
  };
}
