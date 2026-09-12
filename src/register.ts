import { REST, Routes } from 'discord.js';
import { command } from './discord-ui.js';
import { PublicError, safeError } from './config.js';
async function register() {
  const { DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID || !DISCORD_GUILD_ID) throw new PublicError('Set DISCORD_TOKEN, DISCORD_APPLICATION_ID and DISCORD_GUILD_ID first.');
  // POST upserts only Erga's command; it preserves unrelated commands on this app.
  await new REST({ version: '10' }).setToken(DISCORD_TOKEN).post(Routes.applicationGuildCommands(DISCORD_APPLICATION_ID, DISCORD_GUILD_ID), { body: command.toJSON() });
  console.log('Registered /erga in the configured Discord server.');
}
register().catch(e => { console.error(safeError(e)); process.exit(1); });
