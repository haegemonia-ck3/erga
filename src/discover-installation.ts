import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PublicError, safeError } from './config.js';

import { readGitHubPrivateKey } from './github-auth.js';

async function discover() {
  const appId = process.env.GITHUB_APP_ID;
  const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  const repository = process.env.GITHUB_REPOSITORIES?.split(',')[0];
  if (!appId || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new PublicError('Set GITHUB_APP_ID, a GitHub private key, and GITHUB_REPOSITORIES first.');
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: appId, iat: now - 60, exp: now + 540 })}`;
  const jwt = input + '.' + createSign('RSA-SHA256').update(input).sign(readGitHubPrivateKey({ privateKey: process.env.GITHUB_PRIVATE_KEY, privateKeyPath: keyPath }), 'base64url');
  const response = await fetch(`https://api.github.com/repos/${repository}/installation`, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Erga-Hegemonia' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new PublicError(`Installation lookup failed (HTTP ${response.status}). Check the App ID, PEM, and repository installation.`);
  const installation = await response.json() as { id: number; permissions: Record<string, string> };
  if (!Number.isSafeInteger(installation.id)) throw new PublicError('Invalid installation response.');
  const env = readFileSync('.env.local', 'utf8');
  const line = `GITHUB_INSTALLATION_ID=${installation.id}`;
  writeFileSync('.env.local', /^GITHUB_INSTALLATION_ID=.*$/m.test(env) ? env.replace(/^GITHUB_INSTALLATION_ID=.*$/m, line) : env + '\n' + line + '\n');
  console.log(`Installation ID saved: ${installation.id}`);
  console.log('App permissions:', JSON.stringify(installation.permissions));
}
discover().catch(e => { console.error(safeError(e)); process.exit(1); });
