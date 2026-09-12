import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Changes } from '../src/changes.js';
import { GitHub } from '../src/github.js';
import { toolHandler } from '../src/agent-tools.js';
import type { Config, Actor } from '../src/config.js';
const actor: Actor = { userId: 'user', guildId: 'guild', channelId: 'thread', parentId: 'parent', roleIds: ['writer'] };
const config = { guildId: 'guild', channelIds: ['parent'], readRoleIds: ['reader'], writeRoleIds: ['writer'], deleteRoleIds: ['deleter'] } as Config;
const batch = { repository: 'team/mod', updates: [1, 2, 3].map(number => ({ number, milestone: 4 })) };
function setup(request: typeof fetch, refreshActor = async () => actor) {
 const store = new Store(':memory:'); const github = new GitHub('test', ['team/mod'], request);
 const handle = toolHandler(github, new Changes(config, store, github), { actor, refreshActor, readMessages: async () => [] });
 return { store, handle };
}
test('bulk updates execute once per issue and return ordered outcomes in one call', async () => {
 const calls: string[] = []; let roles = 0;
 const f = setup(async (url, init) => { calls.push(String(url)); assert.deepEqual(JSON.parse(init?.body as string), { milestone: 4 }); return Response.json({ html_url: String(url) }); }, async () => { roles++; return actor; });
 try {
  const out = await f.handle('bulk_update_issues', batch, 'batch') as any;
  assert.equal(out.applied, 3); assert.equal(out.status, 'applied');
  assert.deepEqual(out.results.map((r: any) => r.number), [1, 2, 3]);
  assert.equal(roles, 3);
  assert.deepEqual(await f.handle('bulk_update_issues', batch, 'batch'), out);
  assert.equal(calls.length, 3);
 } finally { f.store.close(); }
});
test('bulk validates every entry before writing, including duplicate and empty updates', async () => {
 let writes = 0; const f = setup(async () => { writes++; return Response.json({}); });
 try {
  for (const updates of [[{ number: 1, milestone: 4 }, { number: 2, bad: true }], [{ number: 1, milestone: 4 }, { number: 1, milestone: 5 }], [{ number: 1 }], [], Array.from({length: 51}, (_,i) => ({number:i+1,state:'closed'}))]) {
   await assert.rejects(f.handle('bulk_update_issues', { repository: 'team/mod', updates }, 'invalid'));
  }
  assert.equal(writes, 0);
 } finally { f.store.close(); }
});
test('lost response stops bulk work, preserves earlier success and is not replayed', async () => {
 let writes = 0; const f = setup(async () => { if (++writes === 2) throw Error('lost response'); return Response.json({}); });
 try {
  const out = await f.handle('bulk_update_issues', batch, 'partial') as any;
  assert.deepEqual(out.results.map((r: any) => r.status), ['applied','unknown','skipped']);
  assert.equal(out.applied, 1);
  const again = await f.handle('bulk_update_issues', batch, 'partial') as any;
  assert.deepEqual(again.results.map((r: any) => r.status), ['applied','unknown','skipped']);
  assert.equal(writes, 2);
 } finally { f.store.close(); }
});
test('role revocation and stop prevent remaining bulk writes', async () => {
 for (const cancel of [true, false]) {
  const controller = new AbortController(); let writes = 0;
  const f = setup(async () => { writes++; if (cancel) controller.abort(); return Response.json({}); }, async () => writes ? {...actor,roleIds:['reader']} : actor);
  try {
   const out = await f.handle('bulk_update_issues', batch, 'stop', controller.signal) as any;
   assert.equal(writes, 1);
   assert.deepEqual(out.results.map((r: any) => r.status), cancel ? ['applied','skipped','skipped'] : ['applied','failed','skipped']);
  } finally { f.store.close(); }
 }
});
test('batched reads report per-query errors and reject out-of-scope repositories before reading', async () => {
 let reads = 0; const f = setup(async () => ++reads === 2 ? Response.json({}, {status:404}) : Response.json({number:1}));
 try {
  const queries = [1,2].map(number => ({repository:'team/mod',resource:'issue',number}));
  const out = await f.handle('github_query_batch', {queries}, 'read') as any;
  assert.deepEqual(out.results.map((r: any) => r.success), [true,false]);
  await assert.rejects(f.handle('github_query_batch',{queries:[queries[0],{...queries[1],repository:'other/mod'}]},'bad'), /outside/);
  assert.equal(reads, 2);
 } finally { f.store.close(); }
});
