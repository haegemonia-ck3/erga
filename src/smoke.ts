import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { createModel } from './model.js';
import { instructions, toolDefinitions } from './agent-tools.js';
import { githubAuth } from './github-auth.js';
import { GitHub } from './github.js';
import { config, PublicError, safeError } from './config.js';

async function smoke() {
  const c = config();
  const store = new Store(':memory:');
  const marker = randomUUID();
  const model = createModel(c);
  const agent = new Agent(model, store, {
    provider: c.provider, model: c.model,
    instructions: 'You are a test agent. Get the marker using get_check_value and return it exactly. On follow-up, return the remembered marker without calling tools. Other tools are disabled in this test.',
    tools: [...toolDefinitions, { name: 'get_check_value', description: 'Get the test marker', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    timeoutSeconds: 60, maxActive: 1,
  });
  let calls = 0;
  try {
    const run = { key: 'erga:live-check', requestId: randomUUID(), input: 'Get the marker using get_check_value and reply with it.', handle: async (name: string) => { if (name !== 'get_check_value') throw new PublicError('Tool is disabled in this test.'); calls++; return { marker }; }, progress: async () => {} };
    const first = await agent.run(run);
    if (!first.includes(marker) || calls !== 1) throw new PublicError('Live function tool round-trip failed.');
    console.log('Live function tool round-trip passed with all Erga tool schemas.');
    const second = await agent.run({ ...run, requestId: randomUUID(), input: 'What was the marker? Use conversation memory; do not call tools.' });
    if (!second.includes(marker) || calls !== 1) throw new PublicError('Persistent follow-up failed.');
    console.log('Local conversation memory follow-up passed.');
    const gh = new GitHub(githubAuth(c), c.repositories);
    const repo = c.repositories[0]!;
    const expected = await gh.query({ repository: repo, resource: 'issues', state: 'open' }) as { data: { number: number; title: string; pull_request?: unknown }[]; possibly_more: boolean };
    const reader = new Agent(model, store, { provider: c.provider, model: c.model, instructions: instructions(c.repositories), tools: toolDefinitions, timeoutSeconds: 120, maxActive: 1 });
    let reads = 0;
    const text = await reader.run({ key: 'erga:github-check', requestId: randomUUID(), input: 'List all current open issues grouped by Priority. Include every issue number and title. Use GitHub tools to verify them.', handle: async (name, args) => {
      reads++;
      if (name === 'github_query') return gh.query(args);
      if (name === 'github_query_batch') { const batch = args as { queries: unknown[] }; return { results: await Promise.all(batch.queries.map(async query => ({ query, success: true, result: await gh.query(query) }))) }; }
      throw new PublicError('Only GitHub reads are enabled in this check.');
    }, progress: async () => {} });
    if (!reads || (!expected.possibly_more && expected.data.filter(i => !i.pull_request).some(i => !text.includes(`#${i.number}]`)))) throw new PublicError('The issue-list check omitted an expected issue.');
    console.log(`Real GitHub issue-list check passed (${reads} read tool calls).`);
    console.log(`Verified provider/model: ${c.provider}/${c.model}. No GitHub changes or Discord messages sent.`);
  } finally { await agent.shutdown(); store.close(); }
}
smoke().catch(e => { console.error(safeError(e)); process.exitCode = 1; });
