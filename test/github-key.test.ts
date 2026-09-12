import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { config } from '../src/config.js';
import { githubAuth, readGitHubPrivateKey } from '../src/github-auth.js';

const env = { OPENAI_API_KEY: 'test', DISCORD_TOKEN: 'test', DISCORD_APPLICATION_ID: '1547654227881365524', DISCORD_GUILD_ID: '841238630743146496', DISCORD_CHANNEL_IDS: '844652195252273192', GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_REPOSITORIES: 'team/mod' };

test('GitHub App config accepts a contents variable without a local file and rejects a missing key', () => {
  assert.equal(config({ ...env, GITHUB_PRIVATE_KEY: 'example' }).githubApp?.privateKey, 'example');
  assert.equal(config({ ...env, GITHUB_PRIVATE_KEY: ' ', GITHUB_PRIVATE_KEY_PATH: 'local.pem' }).githubApp?.privateKeyPath, 'local.pem');
  assert.throws(() => config(env), /GITHUB_PRIVATE_KEY/);
  assert.throws(() => readGitHubPrivateKey({}), /GITHUB_PRIVATE_KEY/);
});

test('PEM variable signs verifiable JWTs with real or escaped line breaks and overrides a file path', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  for (const value of [pem, pem.replace(/\n/g, '\\n'), pem.replace(/\n/g, '\\r\\n')]) {
    let requests = 0;
    const c = config({ ...env, GITHUB_PRIVATE_KEY: value, GITHUB_PRIVATE_KEY_PATH: 'nonexistent.pem' });
    const auth = githubAuth(c, async (_url, init) => {
      requests++;
      const jwt = (init?.headers as Record<string, string>).Authorization!.slice('Bearer '.length);
      const [header, payload, signature] = jwt.split('.');
      assert.equal(createVerify('RSA-SHA256').update(header + '.' + payload).verify(publicKey, signature!, 'base64url'), true);
      return Response.json({ token: 'test-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
    });
    assert.equal(await auth(), 'test-token');
    assert.equal(await auth(), 'test-token');
    assert.equal(requests, 1);
  }
});

test('invalid PEM fails at startup with a helpful error that does not reveal the key', () => {
  const c = config({ ...env, GITHUB_PRIVATE_KEY: 'invalid-secret-value' });
  assert.throws(() => githubAuth(c), error => error instanceof Error && /could not be read or parsed/.test(error.message) && !error.message.includes('invalid-secret-value'));
});
