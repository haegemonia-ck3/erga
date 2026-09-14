import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { isConfiguredChannel, isConversationChannel, requiredChannelPermissions } from '../src/discord-access.js';
import { allowedChannel, type Actor } from '../src/config.js';

const channel = (type: ChannelType) => ({ type, isThread: () => [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(type) }) as any;

test('forum parents pass startup validation while only their posts are conversation channels', () => {
  const forum = channel(ChannelType.GuildForum);
  const post = channel(ChannelType.PublicThread);
  assert.equal(isConfiguredChannel(forum), true);
  assert.equal(isConversationChannel(forum), false);
  assert.equal(isConfiguredChannel(post), true);
  assert.equal(isConversationChannel(post), true);
  const policy = { guildId: 'guild', channelIds: ['forum'] };
  const actor = { guildId: 'guild', channelId: 'post', parentId: 'forum' } as Actor;
  assert.equal(allowedChannel(policy, actor), true);
  assert.equal(allowedChannel(policy, { ...actor, parentId: 'other-forum' }), false);
  assert.equal(allowedChannel(policy, { ...actor, guildId: 'other-guild' }), false);
});

test('startup preserves text/thread support and rejects unrelated channel types', () => {
  for (const type of [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]) {
    assert.equal(isConfiguredChannel(channel(type)), true);
    assert.equal(isConversationChannel(channel(type)), true);
  }
  for (const value of [null, undefined, {}, channel(ChannelType.GuildCategory), channel(ChannelType.GuildVoice), channel(ChannelType.DM)]) {
    assert.equal(isConfiguredChannel(value), false);
    assert.equal(isConversationChannel(value), false);
  }
});

test('forum startup does not require the ignored CreatePublicThreads permission', () => {
  const required = requiredChannelPermissions(channel(ChannelType.GuildForum));
  const granted = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]);
  assert.equal('CreatePublicThreads' in required, false);
  assert.deepEqual(Object.entries(required).filter(([, flag]) => !granted.has(flag)), []);
  granted.remove(PermissionFlagsBits.SendMessagesInThreads);
  assert.deepEqual(Object.entries(required).filter(([, flag]) => !granted.has(flag)).map(([name]) => name), ['SendMessagesInThreads']);
  assert.ok(requiredChannelPermissions(channel(ChannelType.GuildText)).CreatePublicThreads);
  const thread = requiredChannelPermissions(channel(ChannelType.PublicThread));
  assert.equal('CreatePublicThreads' in thread, false);
  assert.equal('SendMessages' in thread, false);
  assert.ok(thread.SendMessagesInThreads);
});
