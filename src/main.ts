import OpenAI from 'openai';
import { Client, Events, GatewayIntentBits, MessageFlags, ChannelType, PermissionFlagsBits, type Guild, type TextChannel, type ThreadChannel } from 'discord.js';
import { config, mayRead, mayWrite, safeError, PublicError, type Actor } from './config.js';
import { Store } from './store.js';
import { GitHub } from './github.js';
import { githubAuth } from './github-auth.js';
import { Changes } from './changes.js';
import { Agent } from './agent.js';
import { instructions, toolDefinitions, toolHandler } from './agent-tools.js';
import { answerMessages, help, noMentions } from './discord-ui.js';
import { isTriggerCandidate, shouldTrigger, serializeMessage, readFullThread, requestWithContext } from './thread-context.js';

async function main() {
  const c = config();
  const store = new Store(c.databasePath);
  const github = new GitHub(githubAuth(c), c.repositories);
  const changes = new Changes(c, store, github);
  const agent = new Agent(new OpenAI({ apiKey: c.openaiKey, maxRetries: 0, timeout: 30_000 }), store, {
    model: c.model, instructions: instructions(c.repositories), tools: toolDefinitions,
    timeoutSeconds: c.turnTimeoutSeconds, maxActive: c.maxActiveTurns,
  });
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], allowedMentions: noMentions });
  let ready = false;
  const actorFor = async (guild: Guild, channel: TextChannel | ThreadChannel, userId: string): Promise<Actor> => {
    // Fetch fresh roles for every request and immediately before each mutation.
    const member = await guild.members.fetch({ user: userId, force: true });
    return { userId, guildId: guild.id, channelId: channel.id, parentId: channel.isThread() ? channel.parentId : null, roleIds: [...member.roles.cache.keys()] };
  };
  const keyFor = (a: Actor) => `${a.guildId}:${a.channelId}`;
  const inFlight = new Set<string>();
  async function ask(channel: ThreadChannel, actor: Actor, requestId: string, input: string) {
    if (inFlight.has(channel.id)) {
      await channel.send({ content: 'I’m already working in this thread. Wait for the reply, or use /erga stop.', allowedMentions: noMentions });
      return;
    }
    inFlight.add(channel.id);
    let progress: Awaited<ReturnType<ThreadChannel['send']>> | undefined;
    let lastUpdate = 0;
    let lastText = '';
    try {
      progress = await channel.send({ content: 'Erga is reading the thread…', allowedMentions: noMentions });
      const history = await readFullThread({
        page: async before => [...(await channel.messages.fetch({ limit: 100, before, cache: false })).values()].map(serializeMessage),
        starter: async () => {
          try {
            const starter = await channel.fetchStarterMessage({ force: true });
            return starter ? serializeMessage(starter) : null;
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 10008) return null;
            throw error;
          }
        },
      }, requestId);
      const text = await agent.run({ key: keyFor(actor), requestId,
        input: requestWithContext(actor.userId, input, requestId, history),
        handle: toolHandler(github, changes, {
          actor,
          readMessages: async () => history,
          refreshActor: () => actorFor(channel.guild, channel, actor.userId),
        }),
        progress: async text => {
          if (Date.now() - lastUpdate < 2500 || text === lastText) return;
          lastUpdate = Date.now(); lastText = text;
          // A failed Discord edit must not stop the application's tool responder.
          await progress?.edit({ content: text, allowedMentions: noMentions }).catch(() => undefined);
        },
      });
      for (const message of answerMessages(text)) await channel.send(message);
      await progress?.delete().catch(() => undefined);
    } catch (error) {
      const message = safeError(error);
      console.error('Erga request:', message);
      await progress?.edit({ content: message, allowedMentions: noMentions }).catch(() => undefined);
    } finally { inFlight.delete(channel.id); }
  }
  const usable = (channel: unknown): channel is TextChannel | ThreadChannel => !!channel && typeof channel === 'object' && 'type' in channel && [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel.type as number);
  client.on(Events.MessageCreate, message => {
    void (async () => {
      if (!ready || !message.guild || message.author.bot || message.webhookId || !usable(message.channel)) return;
      const channel = message.channel;
      if (!isTriggerCandidate(message, client.user!.id)) return;
      let actor = await actorFor(message.guild, channel, message.author.id);
      if (!mayRead(c, actor)) return;
      if (!await shouldTrigger(message, client.user!.id)) return;
      const input = message.content.replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '').trim();
      if (!input) { await message.reply({ content: help, allowedMentions: noMentions }); return; }
      const thread = channel.isThread() ? channel : await message.startThread({ name: `Erga · ${input.replace(/\s+/g, ' ').slice(0, 85)}`, autoArchiveDuration: 1440 });
      actor = { ...actor, channelId: thread.id, parentId: thread.parentId };
      await ask(thread, actor, message.id, input);
    })().catch(error => console.error('Discord message:', safeError(error)));
  });
  client.on(Events.InteractionCreate, interaction => {
    void (async () => {
      if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
      if (interaction.isChatInputCommand() && interaction.commandName !== 'erga') return;
      if (interaction.isButton() && !interaction.customId.startsWith('erga:')) return;
      // Acknowledge immediately, before member fetch or any network work.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (!ready) throw new PublicError('Erga is still checking its Discord setup. Try again shortly.');
        if (!interaction.guild || !usable(interaction.channel)) throw new PublicError('Use Erga in a configured server text channel or thread.');
        const channel = interaction.channel;
        const actor = await actorFor(interaction.guild, channel, interaction.user.id);
        if (!mayRead(c, actor)) throw new PublicError('Your roles or this channel do not have Erga access.');
        if (interaction.isButton()) {
          const [, action, id] = interaction.customId.split(':');
          if (!id || !['apply', 'cancel'].includes(action ?? '')) throw new PublicError('Invalid change button.');
          const result = changes.retireLegacy(id, actor);
          await interaction.message.edit({ components: [] }).catch(() => undefined);
          await interaction.editReply(result);
          return;
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'help') { await interaction.editReply(help); return; }
        if (subcommand === 'status') { await interaction.editReply(await agent.status(keyFor(actor))); return; }
        if (subcommand === 'stop' || subcommand === 'reset') {
          if (!mayWrite(c, actor)) throw new PublicError('A write role is required to stop or reset shared conversations.');
          if (subcommand === 'stop') await interaction.editReply(await agent.cancel(keyFor(actor)) ? 'Stop requested. Already applied GitHub changes are retained.' : 'No active session here.');
          else { await agent.reset(keyFor(actor)); await interaction.editReply('Conversation context cleared.'); }
          return;
        }
        const input = interaction.options.getString('message', true);
        const thread = channel.isThread() ? channel : await channel.threads.create({ name: `Erga · ${input.replace(/\s+/g, ' ').slice(0, 85)}`, type: ChannelType.PublicThread, autoArchiveDuration: 1440 });
        await interaction.editReply(`Working in <#${thread.id}>.`);
        for (const message of answerMessages(`**Request from ${interaction.user.username.replace(/[@`*_~]/g, '')}:**\n${input}`)) await thread.send(message);
        await ask(thread, { ...actor, channelId: thread.id, parentId: thread.parentId }, interaction.id, input);
      } catch (error) { await interaction.editReply(safeError(error)); }
    })().catch(error => console.error('Discord interaction:', safeError(error)));
  });
  client.on(Events.Error, error => console.error('Discord connection:', safeError(error)));
  client.once(Events.ClientReady, () => {
    void (async () => {
      const guild = await client.guilds.fetch(c.guildId);
      const bot = await guild.members.fetchMe();
      const roles = await guild.roles.fetch();
      for (const id of [...c.readRoleIds, ...c.writeRoleIds, ...c.deleteRoleIds]) {
        if (id !== 'everyone' && !roles.has(id)) throw new PublicError(`Configured role ${id} does not exist in this Discord server.`);
      }
      const requirements = { ViewChannel: PermissionFlagsBits.ViewChannel, SendMessages: PermissionFlagsBits.SendMessages, ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory, CreatePublicThreads: PermissionFlagsBits.CreatePublicThreads, SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads, AttachFiles: PermissionFlagsBits.AttachFiles, EmbedLinks: PermissionFlagsBits.EmbedLinks };
      for (const id of c.channelIds) {
        const channel = await guild.channels.fetch(id);
        if (!channel || !usable(channel)) throw new PublicError(`Configured channel ${id} must be a server text channel or thread.`);
        const permissions = channel.permissionsFor(bot);
        const missing = Object.entries(requirements).filter(([name, flag]) => !(channel.isThread() && name === 'CreatePublicThreads') && !permissions?.has(flag)).map(([name]) => name);
        if (missing.length) throw new PublicError(`Erga needs ${missing.join(', ')} in channel ${id}.`);
      }
      ready = true;
      console.log(`Erga is online. Discord access and role IDs verified. Repository: ${c.repositories.join(', ')}`);
    })().catch(error => { console.error(safeError(error)); client.destroy(); process.exit(1); });
  });
  const cleanup = setInterval(() => { void agent.cleanup(c.sessionTtlHours).catch(e => console.error('Cleanup:', safeError(e))); }, 3600_000);
  cleanup.unref();
  const shutdown = () => {
    ready = false; clearInterval(cleanup); client.destroy();
    void agent.shutdown().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  await client.login(c.discordToken);
}
main().catch(error => { console.error(safeError(error)); process.exit(1); });
