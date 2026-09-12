import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { toolDefinitions } from './agent-tools.js';
import { githubAuth } from './github-auth.js';
import { GitHub } from './github.js';
import { PublicError, safeError } from './config.js';

async function smoke() {
  const store = new Store(':memory:');
  const marker = randomUUID();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  const agent = new Agent(client, store, {
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    instructions: 'You are a test agent. When asked for a marker, use get_check_value and return the exact marker. Do not use any GitHub or Discord tools. On follow-up, return the remembered marker without calling any tools.',
    tools: [...toolDefinitions, { type: 'function', name: 'get_check_value', description: 'Get the test marker', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    timeoutSeconds: 180, maxActive: 1,
  });
  let calls = 0;
  try {
    const run = { key: 'erga:live-check', requestId: randomUUID(), input: 'Get the marker using get_check_value and reply with it.', handle: async (name: string) => { if (name !== 'get_check_value') throw new PublicError('Tool is disabled in this test.'); calls++; return { marker }; }, progress: async () => {} };
    const first = await agent.run(run);
    if (!first.includes(marker) || calls !== 1) throw new PublicError('Live function tool round-trip failed.');
    console.log('Live function tool round-trip passed with Erga’s tool schemas.');
    const second = await agent.run({ ...run, requestId: randomUUID(), input: 'What was the marker? Use conversation memory; do not call tools.' });
    if (!second.includes(marker) || calls !== 1) throw new PublicError('Persistent session follow-up failed.');
    console.log('Persistent session follow-up passed.');
  } finally {
    if (store.conversation('erga:live-check')) {
      try { await agent.cancel('erga:live-check'); await agent.reset('erga:live-check'); console.log('Live check session deleted.'); }
      catch { console.error(`Live check needs cleanup: ${store.conversation('erga:live-check')?.session_id}`); }
    }
    store.close();
  }
  const gh = new GitHub(githubAuth({ githubApp: { appId: process.env.GITHUB_APP_ID!, installationId: process.env.GITHUB_INSTALLATION_ID!, privateKey: process.env.GITHUB_PRIVATE_KEY, privateKeyPath: process.env.GITHUB_PRIVATE_KEY_PATH } }), process.env.GITHUB_REPOSITORIES!.split(','));
  const repo = gh.repositories[0]!;
  await gh.api(repo, '');
  await gh.query({ repository: repo, resource: 'issues' });
  console.log('GitHub App authenticated and read the repository and issues. No changes made.');
}
smoke().catch(e => { console.error(safeError(e)); process.exit(1); });
