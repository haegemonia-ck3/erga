import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Store } from '../src/store.js';
import { Changes } from '../src/changes.js';
import { GitHub, changeSchema } from '../src/github.js';
import { githubAuth } from '../src/github-auth.js';
import { config, mayRead, mayWrite, mayDelete, safeError, type Config, type Actor } from '../src/config.js';
import { answerMessages } from '../src/discord-ui.js';

const repository = 'team/mod';
const policy = { guildId: 'guild', channelIds: ['parent'], readRoleIds: ['reader'], writeRoleIds: ['writer'], deleteRoleIds: ['deleter'] } as Config;
const actor = (role: string): Actor => ({ userId: 'user', guildId: 'guild', channelId: 'thread', parentId: 'parent', roleIds: [role] });
const issue = { operation: 'create_issue', repository, title: 'Localization bug', body: 'Steps to reproduce' } as const;
const fixture = (request: typeof fetch) => { const store = new Store(':memory:'); return { store, changes: new Changes(policy, store, new GitHub('test', [repository], request)) }; };

test('roles inherit lower tiers, stay scoped to guild and channels, and empty policy denies access', () => {
  assert.equal(mayRead(policy, actor('reader')), true);
  assert.equal(mayWrite(policy, actor('reader')), false);
  assert.equal(mayRead(policy, actor('writer')), true);
  assert.equal(mayDelete(policy, actor('writer')), false);
  assert.equal(mayWrite(policy, actor('deleter')), true);
  assert.equal(mayDelete(policy, actor('deleter')), true);
  assert.equal(mayRead(policy, { ...actor('reader'), guildId: 'other' }), false);
  assert.equal(mayRead(policy, { ...actor('reader'), parentId: 'other' }), false);
  assert.equal(mayRead({ ...policy, readRoleIds: [], writeRoleIds: [], deleteRoleIds: [] }, actor('reader')), false);
});
test('configuration fails closed and supports GitHub App without PAT', () => {
  const env = { OPENAI_API_KEY: 'test', DISCORD_TOKEN: 'test', DISCORD_APPLICATION_ID: '1547654227881365524', DISCORD_GUILD_ID: '841238630743146496', DISCORD_CHANNEL_IDS: '844652195252273192', GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_PRIVATE_KEY_PATH: 'test.pem', GITHUB_REPOSITORIES: repository };
  const c = config(env);
  assert.deepEqual(c.writeRoleIds, []);
  assert.equal(c.githubToken, undefined);
  assert.throws(() => config({ ...env, DISCORD_CHANNEL_IDS: '' }));
});
test('repository allowlist rejects traversal and alternate repositories before any request', async () => {
  let count = 0;
  const gh = new GitHub('test', [repository], async () => { count++; return Response.json({}); });
  for (const repo of ['evil/mod', 'team/mod/../../evil', 'https://evil.example']) {
    await assert.rejects(gh.query({ repository: repo, resource: 'issues' }), /outside/);
    await assert.rejects(gh.change({ ...issue, repository: repo }), /outside/);
  }
  assert.equal(count, 0);
});
test('reads preserve pagination and safely encode issue filters', async () => {
  let observed = '';
  const gh = new GitHub('test', [repository], async url => { observed = String(url); return Response.json(Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: 'Bug' }))); });
  const result = await gh.query({ repository, resource: 'issues', labels: 'bug,ui&state=closed', page: 2, milestone: 3 }) as any;
  const url = new URL(observed);
  assert.equal(url.searchParams.get('labels'), 'bug,ui&state=closed');
  assert.equal(url.searchParams.get('state'), 'open');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(result.possibly_more, true);
});
test('changes send only intended fields and pin merge to reviewed SHA', async () => {
  const requests: any[] = [];
  const gh = new GitHub('test', [repository], async (url, options) => { requests.push({ url, ...options }); return Response.json({ merged: true }); });
  await gh.change({ operation: 'update_issue', repository, number: 8, milestone: null });
  assert.deepEqual(JSON.parse(requests[0].body), { milestone: null });
  await gh.change({ operation: 'merge_pull_request', repository, number: 3, sha: 'a'.repeat(40), merge_method: 'squash' });
  assert.equal(JSON.parse(requests[1].body).sha, 'a'.repeat(40));
  assert.equal(requests[1].method, 'PUT');
  assert.equal(changeSchema.safeParse({ ...issue, token: 'unexpected' }).success, false);
});
test('search prevents qualifier injection and drops unexpected cross-repository results', async () => {
  let calls = 0;
  const gh = new GitHub('test', [repository], async url => {
    calls++;
    assert.ok(new URL(String(url)).searchParams.get('q')?.startsWith('repo:team/mod '));
    return Response.json({ total_count: 2, incomplete_results: false, items: [{ number: 1, repository_url: 'https://api.github.com/repos/team/mod' }, { number: 2, repository_url: 'https://api.github.com/repos/other/private' }] });
  });
  await assert.rejects(gh.query({ repository, resource: 'search', text: 'repo:other/private' }), /plain words/);
  const result = await gh.query({ repository, resource: 'search', text: 'localization bug' }) as any;
  assert.equal(calls, 1);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].number, 1);
});
test('authorized changes execute directly; repeated and concurrent calls never duplicate writes', async () => {
  let calls = 0;
  const { store, changes } = fixture(async () => { calls++; return Response.json({ html_url: 'https://github.com/team/mod/issues/1' }); });
  await assert.rejects(changes.execute(issue, actor('reader'), 'call-1'), /roles/);
  const results = await Promise.allSettled([changes.execute(issue, actor('writer'), 'call-1'), changes.execute(issue, actor('writer'), 'call-1')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const result = await changes.execute(issue, actor('writer'), 'call-1');
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.result, { html_url: 'https://github.com/team/mod/issues/1' });
  assert.equal(calls, 1);
  assert.equal(store.proposal(result.id)?.status, 'applied');
  assert.throws(() => changes.get(result.id, { ...actor('writer'), channelId: 'other' }), /conversation/);
  await assert.rejects(changes.execute({ ...issue, title: 'Different' }, actor('writer'), 'call-1'), /different request/);
  store.close();
});
test('permanent deletion executes only for the delete role', async () => {
  const { store, changes } = fixture(async () => new Response(null, { status: 204 }));
  const deletion = { operation: 'delete_milestone', repository, number: 3 };
  await assert.rejects(changes.execute(deletion, actor('writer'), 'delete'), /roles/);
  const result = await changes.execute(deletion, actor('deleter'), 'delete');
  assert.equal(result.status, 'applied');
  store.close();
});
test('legacy approval buttons retire pending work and do not replay applied work', () => {
  const { store, changes } = fixture(async () => { throw new Error('must not execute'); });
  const pending = store.propose('thread', 'guild', 'user', issue);
  assert.match(changes.retireLegacy(pending.id, actor('writer')), /no longer active/);
  assert.equal(store.proposal(pending.id)?.status, 'cancelled');
  const applied = store.propose('thread', 'guild', 'user', issue);
  store.finishProposal(applied.id, 'applied', '{}');
  assert.match(changes.retireLegacy(applied.id, actor('writer')), /already applied/);
  assert.equal(store.proposal(applied.id)?.status, 'applied');
  store.close();
});
test('lost GitHub response is recorded as unknown and never retried', async () => {
  let calls = 0;
  const { store, changes } = fixture(async () => { calls++; throw new Error('network lost'); });
  await assert.rejects(changes.execute(issue, actor('writer'), 'uncertain'), /inconclusive/);
  await assert.rejects(changes.execute(issue, actor('writer'), 'uncertain'), /unknown/);
  assert.equal(calls, 1);
  store.close();
});
test('HTTP rejection is marked failed, and secrets in errors are suppressed', async () => {
  let calls = 0;
  const { store, changes } = fixture(async () => { calls++; return Response.json({ message: 'private upstream details' }, { status: 403 }); });
  await assert.rejects(changes.execute(issue, actor('writer'), 'forbidden'), /403/);
  await assert.rejects(changes.execute(issue, actor('writer'), 'forbidden'), /failed/);
  assert.equal(calls, 1);
  assert.ok(!safeError(new Error('secret-value')).includes('secret-value'));
  store.close();
});
test('SQLite persists conversation and recovers crash during a mutation as unknown', () => {
  const directory = mkdtempSync(join(tmpdir(), 'erga-test-'));
  try {
    let s = new Store(join(directory, 'state.sqlite'));
    s.saveConversation('guild:thread', 'session', 'turn');
    const p = s.propose('thread', 'guild', 'user', issue);
    assert.equal(s.claimProposal(p.id), true);
    assert.equal(s.claimRequest('message'), true);
    s.close();
    s = new Store(join(directory, 'state.sqlite'));
    assert.equal(s.conversation('guild:thread')?.turn_id, 'turn');
    assert.equal(s.proposal(p.id)?.status, 'unknown');
    assert.equal(s.claimRequest('message'), false);
    s.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('GitHub App signs JWT and shares a refreshed token across concurrent calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'erga-auth-'));
  try {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const path = join(directory, 'test.pem');
    writeFileSync(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    let count = 0;
    const auth = githubAuth({ githubApp: { appId: '1', installationId: '2', privateKeyPath: path } }, async (url, init) => {
      count++;
      assert.equal(String(url), 'https://api.github.com/app/installations/2/access_tokens');
      const header = (init?.headers as Record<string, string>).Authorization!;
      const payload = JSON.parse(Buffer.from(header.split('.')[1]!, 'base64url').toString());
      assert.equal(payload.iss, '1');
      return Response.json({ token: 'installation-test', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    });
    assert.deepEqual(await Promise.all([auth(), auth(), auth()]), Array(3).fill('installation-test'));
    assert.equal(count, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('Discord answers respect limits and suppress mentions without attachments', () => {
  const text = 'long answer '.repeat(1000);
  const answers = answerMessages(text);
  assert.equal(answers.map(a => a.content).join(''), text);
  for (const answer of answers) {
    assert.ok(answer.content!.length <= 2000);
    assert.equal(answer.files, undefined);
    assert.deepEqual(answer.allowedMentions?.parse, []);
  }

});
test('answers up to exactly 2000 characters stay in one message', () => {
  for (const length of [1, 1751, 1999, 2000]) {
    const text = 'x'.repeat(length);
    assert.deepEqual(answerMessages(text).map(a => a.content), [text]);
  }
});
test('long issue lists retain every complete link and priority heading', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `- [#${i + 1}](https://github.com/haegemonia-ck3/Haegemonia_An_Ancient_Odyssey/issues/${i + 1}) Issue title ${i + 1}`);
  const text = '### High priority\n' + lines.slice(0, 15).join('\n') + '\n\n### Unprioritized\n' + lines.slice(15).join('\n');
  const parts = answerMessages(text).map(a => a.content!);
  assert.equal(parts.join(''), text);
  for (const line of lines) assert.ok(parts.some(p => p.includes(line)));
  assert.ok(parts.every(p => p.length <= 2000 && !/### [^\n]+\s*$/.test(p)));
});
test('oversized single lines preserve Unicode and long fenced blocks remain fenced', () => {
  const text = '😀'.repeat(2100);
  const parts = answerMessages(text).map(a => a.content!);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => p.length <= 2000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p)));
  const code = '```ts\n' + 'const value = 1;\n'.repeat(250) + '```';
  const blocks = answerMessages(code).map(a => a.content!);
  assert.ok(blocks.every(p => p.length <= 2000 && p.startsWith('```ts\n') && p.endsWith('```')));
});
