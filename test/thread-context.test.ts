import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageReferenceType, MessageType } from 'discord.js';
import { isTriggerCandidate, shouldTrigger, readFullThread, serializeMessage, requestWithContext, type ThreadMessage } from '../src/thread-context.js';

const botId = '1547654227881365524';
function message(overrides: Record<string, unknown> = {}) {
  return {
    content: 'Team discussion', author: { id: 'human', bot: false }, webhookId: null,
    channelId: 'thread', channel: { isThread: () => true }, type: MessageType.Default,
    reference: null,
    fetchReference: async () => ({ author: { id: botId }, channelId: 'thread', webhookId: null }),
    ...overrides,
  } as any;
}
const reply = { type: MessageType.Reply, reference: { messageId: '1', channelId: 'thread', type: MessageReferenceType.Default } };
test('ordinary thread discussion is never a trigger, including in existing conversations', async () => {
  const m = message();
  assert.equal(isTriggerCandidate(m, botId), false);
  assert.equal(await shouldTrigger(m, botId), false);
});
test('explicit mentions trigger in threads and parent channels without reading references', async () => {
  for (const mention of [`<@${botId}>`, `<@!${botId}>`]) {
    for (const thread of [true, false]) {
      assert.equal(await shouldTrigger(message({ content: `${mention} list issues`, channel: { isThread: () => thread }, fetchReference: async () => { throw Error('must not fetch'); } }), botId), true);
    }
  }
});
test('reply to Erga triggers even with mention notifications disabled', async () => {
  assert.equal(await shouldTrigger(message(reply), botId), true);
});
test('replies to humans or other bots do not trigger Erga', async () => {
  for (const id of ['teammate', 'another-bot']) {
    assert.equal(await shouldTrigger(message({ ...reply, fetchReference: async () => ({ author: { id }, channelId: 'thread', webhookId: null }) }), botId), false);
  }
});
test('bot messages, webhooks, forwards and cross-channel references do not trigger', async () => {
  for (const overrides of [
    { content: `<@${botId}>`, author: { id: 'other-bot', bot: true } },
    { content: `<@${botId}>`, webhookId: 'webhook' },
    { ...reply, reference: { ...reply.reference, type: MessageReferenceType.Forward } },
    { ...reply, reference: { ...reply.reference, channelId: 'other' } },
    { ...reply, channel: { isThread: () => false } },
  ]) assert.equal(await shouldTrigger(message(overrides), botId), false);
});
test('deleted reply targets are ignored while real fetch failures are reported', async () => {
  assert.equal(await shouldTrigger(message({ ...reply, fetchReference: async () => { throw { code: 10008 }; } }), botId), false);
  await assert.rejects(shouldTrigger(message({ ...reply, fetchReference: async () => { throw Error('network unavailable'); } }), botId), /network/);
  assert.equal(await shouldTrigger(message({ ...reply, content: `<@${botId}> help`, fetchReference: async () => { throw { code: 10008 }; } }), botId), true);
});

const historyMessage = (id: number, text = `message ${id}`): ThreadMessage => ({ id: String(id), channel_id: 'thread', author_id: 'user', author_name: 'Teammate', bot: false, text, url: `https://discord.com/channels/g/thread/${id}`, created_at: '2026-09-12T12:00:00.000Z', reply_to: null, embeds: [], attachments: [] });
test('full thread snapshot paginates beyond 100 messages, includes starter, and stops at trigger', async () => {
  const source = Array.from({ length: 260 }, (_, i) => historyMessage(i + 2));
  const calls: string[] = [];
  const history = await readFullThread({
    page: async before => { calls.push(before); return source.filter(m => BigInt(m.id) < BigInt(before)).reverse().slice(0, 100); },
    starter: async () => historyMessage(1, 'Original parent-channel request'),
  }, '251');
  assert.deepEqual(calls, ['252', '152', '52', '2']);
  assert.equal(history.length, 251);
  assert.equal(history[0]?.text, 'Original parent-channel request');
  assert.equal(history.at(-1)?.id, '251');
  assert.equal(history[200]?.text, 'message 201');
});
test('short pages are followed, duplicates removed, and text is never truncated', async () => {
  let call = 0;
  const long = 'Original discussion '.repeat(1000);
  const pages = [[historyMessage(4), historyMessage(3, long)], [historyMessage(3, long), historyMessage(2)], []];
  const history = await readFullThread({ page: async () => pages[call++]!, starter: async () => historyMessage(2) }, '4');
  assert.equal(history.length, 3);
  assert.equal(history[1]?.text, long);
  assert.equal(call, 3);
});
test('pagination failures never quietly return partial context', async () => {
  await assert.rejects(readFullThread({ page: async () => [historyMessage(3)], starter: async () => null }, '3'), /did not advance/);
  let call = 0;
  await assert.rejects(readFullThread({ page: async () => { if (call++) throw Error('history unavailable'); return [historyMessage(3)]; }, starter: async () => null }, '3'), /unavailable/);
});
test('serialized messages include reply target, full embeds, and attachment metadata', () => {
  const value = serializeMessage({ ...message(reply), id: '3', url: 'url', createdAt: new Date('2026-09-12T12:00:00Z'),
    embeds: [{ toJSON: () => ({ title: 'Proposal', description: 'Full details' }) }],
    attachments: new Collection([['file', { name: 'log.txt', url: 'https://cdn.discordapp.com/log.txt', contentType: 'text/plain', size: 120, description: 'A log' }]]),
  } as any);
  assert.equal(value.reply_to, '1');
  assert.equal(value.embeds[0]?.description, 'Full details');
  assert.equal(value.attachments[0]?.name, 'log.txt');
});
test('entire discussion is included automatically and distinguished from the current request', () => {
  const history = [historyMessage(1, 'Please close issue 3'), historyMessage(2, 'Actually leave it open; I am investigating')];
  const input = requestWithContext('user', 'What did we decide?', '3', history);
  for (const m of history) assert.ok(input.includes(m.text));
  assert.match(input, /context only, NOT separate requests or authorization/);
  assert.ok(input.endsWith('What did we decide?'));
});
