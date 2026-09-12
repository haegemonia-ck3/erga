import OpenAI from 'openai';
import { config, PublicError, safeError } from './config.js';
import { githubAuth } from './github-auth.js';
import { GitHub } from './github.js';

async function doctor() {
  if (!process.env.OPENAI_API_KEY) throw new PublicError('OPENAI_API_KEY is missing.');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 30_000 });
  let id: string | undefined;
  let completed = false;
  let finalText = '';
  let turnId: string | undefined;
  console.log('Checking Agents API access and a real hosted sandbox operation…');
  try {
    const stream = await client.beta.agents.sessions.create({
      agent: { model: process.env.OPENAI_MODEL || 'gpt-5.6-luna', reasoning: { effort: 'low', summary: null }, text: { verbosity: 'low' }, instructions: 'Run the exact requested sandbox command and report its actual stdout. Do not simulate execution.' },
      environment: { type: 'openai_hosted' }, input: 'Run Python in the sandbox to create /workspace/outputs/erga-check.txt containing exactly erga-ok (create the parent directory if needed). Read the file back and print its contents. Reply with the stdout.', stream: true,
      metadata: { application: 'erga-doctor' },
    }, { signal: AbortSignal.timeout(120_000) });
    try {
      for await (const e of stream) {
        if ('session' in e) id = e.session.id;
        if (e.type === 'agent.session.turn.item.done' && e.item.type === 'message') finalText += e.item.content.filter(p => p.type === 'output_text').map(p => p.text).join('');
        if (e.type === 'agent.session.turn.completed' && e.turn.subagent_id === null) { completed = true; turnId = e.turn.id; break; }
        if (e.type === 'error' || e.type === 'agent.session.failed' || e.type === 'agent.session.environment.failed' || e.type === 'agent.session.turn.failed') throw new PublicError('Hosted agent check failed. Verify Agents API and model access.');
      }
    } finally { stream.controller.abort(); }
    if (!completed || !finalText.includes('erga-ok')) throw new PublicError('Hosted agent did not return the expected check result.');
    if (!id) throw new PublicError('The check did not return a session ID.');
    let verified = false;
    for await (const artifact of client.beta.agents.sessions.artifacts.list(id)) {
      if (artifact.turn_id === turnId && artifact.path === '/workspace/outputs/erga-check.txt') {
        const content = await client.beta.agents.sessions.artifacts.content(artifact.id, { session_id: id });
        verified = (await content.text()) === 'erga-ok';
        break;
      }
    }
    if (!verified) throw new PublicError('The generated sandbox file could not be verified.');
    console.log('Hosted sandbox file downloaded and verified: erga-ok.');
  } finally {
    if (id) {
      try {
        if (!completed) await client.beta.agents.sessions.events.create(id, { events: [{ type: 'agent.session.input.cancel' }] });
        await client.beta.agents.sessions.delete(id);
        console.log('Temporary hosted session deleted.');
      } catch { console.error(`Temporary session needs cleanup: ${id}`); }
    }
  }
  if (process.argv.includes('--openai-only')) return;
  const c = config();
  const github = new GitHub(githubAuth(c), c.repositories);
  for (const repo of c.repositories) { await github.api(repo, ''); console.log(`GitHub access verified: ${repo}`); }
  const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${c.discordToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new PublicError(`Discord token check failed (HTTP ${response.status}).`);
  console.log('Discord bot authentication verified. No messages posted or GitHub changes made.');
}
doctor().catch(e => { console.error(safeError(e)); process.exit(1); });
