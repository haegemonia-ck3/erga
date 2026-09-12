import test from 'node:test';
import assert from 'node:assert/strict';
import { toolHandler } from '../src/agent-tools.js';
import { Changes } from '../src/changes.js';
import { Store } from '../src/store.js';
import { GitHub } from '../src/github.js';
import type { Actor, Config } from '../src/config.js';

const actor: Actor = { userId: 'user', guildId: 'guild', channelId: 'thread', parentId: 'parent', roleIds: ['writer'] };
const config = { guildId: 'guild', channelIds: ['parent'], readRoleIds: ['reader'], writeRoleIds: ['writer'], deleteRoleIds: ['deleter'] } as Config;
const change = { operation: 'update_issue', repository: 'team/mod', number: 78, assignees: ['abiathar-ops'] };

test('mutation tool refreshes roles and returns applied status only after the write finishes', async () => {
  const store = new Store(':memory:');
  try {
    const events: string[] = [];
    const github = new GitHub('test', ['team/mod'], async (_url, init) => {
      events.push('write');
      assert.equal(init?.method, 'PATCH');
      assert.deepEqual(JSON.parse(init?.body as string), { assignees: ['abiathar-ops'] });
      return Response.json({ number: 78, html_url: 'https://github.com/team/mod/issues/78' });
    });
    const handle = toolHandler(github, new Changes(config, store, github), {
      actor, refreshActor: async () => { events.push('roles'); return actor; }, readMessages: async () => [],
    });
    const result = await handle('execute_github_change', { change }, 'call');
    events.push('result');
    assert.deepEqual(events, ['roles', 'write', 'result']);
    assert.equal((result as { status: string }).status, 'applied');
    assert.deepEqual(await handle('execute_github_change', { change }, 'call'), result);
    assert.equal(events.filter(e => e === 'write').length, 1);
    await assert.rejects(handle('propose_github_change', { change }, 'legacy'), /Unknown tool/);
  } finally { store.close(); }
});

test('revoked roles or a changed requester prevent the tool from writing', async () => {
  const store = new Store(':memory:');
  try {
    let writes = 0;
    const github = new GitHub('test', ['team/mod'], async () => { writes++; return Response.json({}); });
    for (const fresh of [{ ...actor, roleIds: ['reader'] }, { ...actor, userId: 'other' }]) {
      const handle = toolHandler(github, new Changes(config, store, github), {
        actor, refreshActor: async () => fresh, readMessages: async () => [],
      });
      await assert.rejects(handle('execute_github_change', { change }, 'call'), /roles|identity/);
    }
    assert.equal(writes, 0);
  } finally { store.close(); }
});
