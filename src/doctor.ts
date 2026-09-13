import { config, safeError, PublicError } from './config.js';
import { createModel } from './model.js';
import { githubAuth } from './github-auth.js';
import { GitHub } from './github.js';

async function doctor() {
  const c = config();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await createModel(c)({ messages: [{ role: 'user', content: 'Reply with exactly erga-ok.' }], instructions: 'Follow the request exactly.', tools: [], controller, progress: () => {} });
    if (typeof response.content !== 'string' || !response.content.includes('erga-ok')) throw new PublicError('Model check did not return the expected answer.');
    console.log(`Model access verified: ${c.provider}/${c.model}.`);
  } finally { clearTimeout(timeout); }
  const gh = new GitHub(githubAuth(c), c.repositories);
  for (const repository of c.repositories) { await gh.query({ repository, resource: 'issues' }); console.log(`GitHub read verified: ${repository}.`); }
  const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${c.discordToken}` }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new PublicError(`Discord token check failed (HTTP ${response.status}).`);
  console.log('Discord authentication verified. No messages posted or GitHub changes made.');
}
doctor().catch(e => { console.error(safeError(e)); process.exitCode = 1; });
