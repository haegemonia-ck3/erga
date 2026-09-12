import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { Store } from '../src/store.js';
import { Agent } from '../src/agent.js';

const session = { environment: { type: 'none' }, id: 's1', required_actions: [], status: 'idle', agent: { model: 'test', instructions: 'test', reasoning: { effort: 'low', summary: null }, text: { verbosity: 'low' } } };
const turn = { id: 't1', subagent_id: null, status: 'completed' };
const event = (type: string, extra: object) => ({ type, session_id: 's1', ...extra });
const start = event('agent.session.turn.created', { turn });
const done = event('agent.session.turn.completed', { turn });
const answer = event('agent.session.turn.item.done', { item: { id: 'm1', type: 'message', role: 'assistant', phase: 'final_answer', turn_id: 't1', content: [{ type: 'output_text', text: 'Issue #1 is open.' }] } });
const stream = (events: any[]) => ({ controller: new AbortController(), async *[Symbol.asyncIterator]() { yield* events; } });
function fixture(events: any[], options: { resume?: boolean; savedItems?: any[]; status?: string; priorModel?: string; priorEnvironment?: string } = {}) {
  const calls: string[] = [];
  const creations: any[] = [];
  const inputs: any[] = [];
  const s = new Store(':memory:');
  if (options.resume) s.saveConversation('g:c', 's1', 'old');
  const client = { beta: { agents: { sessions: {
    create: async (body: any) => { calls.push('create'); creations.push(body); return stream(events); },
    retrieve: async () => ({ ...session, environment: { type: options.priorEnvironment ?? 'none' }, agent: { ...session.agent, model: options.priorModel ?? 'test' } }),
    events: { stream: async () => { calls.push('subscribe'); return stream(events); }, create: async (_: string, body: any) => { calls.push('input'); inputs.push(body); } },
    turns: { list: async () => ({ data: [{ id: 'old' }] }), retrieve: async () => ({ ...turn, status: options.status || 'completed' }) },
    items: { list: () => ({ async *[Symbol.asyncIterator]() { yield* (options.savedItems ?? []); } }) },
  } } } } as unknown as OpenAI;
  const a = new Agent(client, s, { model: 'test', instructions: 'test', tools: [], timeoutSeconds: 10, maxActive: 3 });
  return { a, s, calls, inputs, creations };
}
const run = { key: 'g:c', requestId: 'r1', input: 'What is issue 1?', handle: async () => ({ number: 1 }), progress: async () => {} };
test('first session persists IDs and returns final answer after matching completion', async () => {
  const f = fixture([event('agent.session.created', { session }), start, answer, done]);
  assert.equal(await f.a.run(run), 'Issue #1 is open.');
  assert.equal(f.s.conversation('g:c')?.session_id, 's1');
  assert.equal(f.s.conversation('g:c')?.turn_id, 't1');
  assert.deepEqual(f.creations[0].environment, { type: 'none' });
  await assert.rejects(f.a.run(run), /already received/);
  f.s.close();
});

test('slow or failed Discord progress does not block tools or completion', { timeout: 1000 }, async () => {
  const action = { type: 'function_call', turn_id: 't1', call_id: 'call', name: 'github_query', arguments: {} };
  for (const progress of [async () => new Promise<void>(() => {}), async () => { throw new Error('Discord unavailable'); }]) {
    const f = fixture([event('agent.session.created', { session }), start,
      event('agent.session.turn.item.added', { item: action }),
      event('agent.session.requires_action', { session: { ...session, required_actions: [action] } }), answer, done]);
    let count = 0;
    assert.equal(await f.a.run({ ...run, progress, handle: async () => { count++; return {}; } }), 'Issue #1 is open.');
    assert.equal(count, 1);
    assert.equal(f.inputs.length, 1);
    f.s.close();
  }
});

test('pending calls execute sequentially and submit one durable batch', async () => {
  const actions = ['first', 'second'].map(call_id => ({ type: 'function_call', turn_id: 't1', call_id, name: 'execute_github_change', arguments: { call_id } }));
  const f = fixture([event('agent.session.created', { session }), start,
    event('agent.session.requires_action', { session: { ...session, required_actions: actions } }), answer, done]);
  const order: string[] = [];
  await f.a.run({ ...run, handle: async (_name, args: any) => {
    order.push(`start ${args.call_id}`); await Promise.resolve(); order.push(`end ${args.call_id}`); return {};
  } });
  assert.deepEqual(order, ['start first', 'end first', 'start second', 'end second']);
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.inputs[0].events.map((e: any) => e.call_id), ['first', 'second']);
  assert.equal(f.s.call('s1:t1:first')?.success, true);
  assert.equal(f.s.call('s1:t1:second')?.success, true);
  f.s.close();
});

test('existing hosted sessions migrate without losing recent conversation context', async () => {
  const f = fixture([event('agent.session.created', { session }), start, answer, done],
    { resume: true, priorEnvironment: 'openai_hosted', savedItems: [answer.item] });
  await f.a.run(run);
  assert.deepEqual(f.creations[0].environment, { type: 'none' });
  assert.match(f.creations[0].input, /Issue #1 is open/);
  assert.equal(f.s.conversation('g:c:previous:s1')?.session_id, 's1');
  f.s.close();
});
test('follow-up subscribes before submitting and uses supported idempotency header', async () => {
  const f = fixture([start, answer, done], { resume: true });
  await f.a.run(run);
  assert.deepEqual(f.calls.slice(0, 2), ['subscribe', 'input']);
  assert.equal(f.inputs[0]['Idempotency-Key'], 'r1');
  f.s.close();
});
test('duplicate tool-required events execute handler once and persist tool result', async () => {
  const action = { type: 'function_call', turn_id: 't1', call_id: 'call', name: 'github_query', arguments: {} };
  const required = event('agent.session.requires_action', { session: { ...session, required_actions: [action] } });
  const f = fixture([event('agent.session.created', { session }), start, required, required, answer, done]);
  let count = 0;
  await f.a.run({ ...run, handle: async () => { count++; return { number: 1 }; } });
  assert.equal(count, 1);
  assert.equal(f.inputs[0].events[0].type, 'agent.session.input.tool_result');
  assert.equal(f.inputs[0].events[0].call_id, 'call');
  assert.equal(f.s.call('s1:t1:call')?.success, true);
  f.s.close();
});
test('completed turn with missing streamed text retrieves saved output', async () => {
  const f = fixture([event('agent.session.created', { session }), start, done], { savedItems: [answer.item] });
  assert.equal(await f.a.run(run), 'Issue #1 is open.');
  f.s.close();
});
test('failed turn does not return partial output or report idle as success', async () => {
  const f = fixture([event('agent.session.created', { session }), start, answer, event('agent.session.turn.failed', { turn: { ...turn, status: 'failed' } })]);
  await assert.rejects(f.a.run(run), /failed/);
  assert.equal(f.a.isBusy('g:c'), false);
  f.s.close();
});
test('disconnect reconciles completed turn without replaying the input', async () => {
  const f = fixture([event('agent.session.created', { session }), start], { savedItems: [answer.item] });
  assert.equal(await f.a.run(run), 'Issue #1 is open.');
  assert.deepEqual(f.calls, ['create', 'subscribe']);
  assert.equal(f.inputs.length, 0);
  f.s.close();
});
test('model change creates a low-reasoning, low-verbosity session without summaries and preserves context', async () => {
  const f = fixture([event('agent.session.created', { session }), start, answer, done], { resume: true, priorModel: 'old-model', savedItems: [answer.item] });
  await f.a.run(run);
  assert.deepEqual(f.creations[0].agent.reasoning, { effort: 'low', summary: null });
  assert.deepEqual(f.creations[0].agent.text, { verbosity: 'low' });
  assert.equal(f.creations[0].agent.model, 'test');
  assert.match(f.creations[0].input, /Issue #1 is open/);
  assert.match(f.creations[0].input, /Current request/);
  assert.equal(f.s.conversation('g:c:previous:s1')?.session_id, 's1');
  f.s.close();
});
