import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Agent } from '../src/agent.js';
import { collectModelResponse, type ModelStep, type ModelRequest } from '../src/model.js';
import type { ModelMessage, StreamChunk } from '@tanstack/ai';
import { modelConfig, PublicError } from '../src/config.js';

const answer: ModelMessage = { role: 'assistant', content: 'Issue #1 is open.' };
const call = (id: string, name = 'github_query', args: unknown = {}) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) }, metadata: { thoughtSignature: 'opaque-signature' } });
const response = (...calls: ReturnType<typeof call>[]): ModelMessage => ({ role: 'assistant', content: '', toolCalls: calls });
const run = { key: 'g:c', requestId: 'r1', input: 'What is issue 1?', handle: async () => ({ number: 1 }), progress: async () => {} };
function fixture(model: ModelStep, options = {}, store = new Store(':memory:')) {
  return { store, agent: new Agent(model, store, { provider: 'test', model: 'test-model', instructions: 'test', tools: ['github_query', 'execute_github_change'].map(name => ({ name, description: name })), timeoutSeconds: 10, maxActive: 3, ...options }) };
}
function sequence(responses: ModelMessage[], seen: ModelRequest[] = []): ModelStep {
  return async request => { seen.push(request); const next = responses.shift(); if (!next) throw new Error('Unexpected model step'); return next; };
}

test('completed requests persist locally and duplicate Discord deliveries do not rerun', async () => {
  const f = fixture(sequence([answer]));
  assert.equal(await f.agent.run(run), answer.content);
  assert.equal(f.store.recentRuns(run.key)[0]?.status, 'completed');
  await assert.rejects(f.agent.run(run), /already received/);
  assert.equal(await f.agent.cancel(run.key), false);
  f.store.close();
});

test('tool rounds preserve Gemini metadata and persist results before the next model step', async () => {
  const seen: ModelRequest[] = [];
  const f = fixture(sequence([response(call('a')), answer], seen));
  await f.agent.run(run);
  assert.equal(seen[1]?.messages[1]?.toolCalls?.[0]?.metadata && (seen[1]!.messages[1]!.toolCalls![0]!.metadata as any).thoughtSignature, 'opaque-signature');
  assert.equal(seen[1]?.messages[2]?.role, 'tool');
  assert.match(f.store.recentRuns(run.key)[0]!.messages[2]!.content as string, /success/);
  f.store.close();
});

test('repeated mutations with different call IDs and reordered arguments execute once', async () => {
  const f = fixture(sequence([response(call('a', 'execute_github_change', { a: 1, b: 2 })), response(call('b', 'execute_github_change', { b: 2, a: 1 })), answer]));
  let writes = 0;
  await f.agent.run({ ...run, handle: async () => { writes++; return { status: 'applied' }; } });
  assert.equal(writes, 1);
  assert.equal(f.store.recentRuns(run.key)[0]?.messages.filter(m => m.role === 'tool').length, 2);
  f.store.close();
});

test('failed mutations are also cached and never blindly repeated', async () => {
  const f = fixture(sequence([response(call('a', 'execute_github_change')), response(call('b', 'execute_github_change')), answer]));
  let writes = 0;
  await f.agent.run({ ...run, handle: async () => { writes++; throw new PublicError('Unknown write outcome'); } });
  assert.equal(writes, 1);
  f.store.close();
});

test('tools execute sequentially and cancellation prevents later writes', async () => {
  const f = fixture(sequence([response(call('a', 'execute_github_change', { n: 1 }), call('b', 'execute_github_change', { n: 2 }))]));
  let writes = 0;
  await assert.rejects(f.agent.run({ ...run, handle: async () => { writes++; await f.agent.cancel(run.key); return { status: 'applied' }; } }), /stopped/);
  assert.equal(writes, 1);
  assert.equal(f.store.recentRuns(run.key)[0]?.status, 'cancelled');
  assert.equal(f.store.recentRuns(run.key)[0]?.messages.at(-1)?.role, 'tool');
  f.store.close();
});

test('model failure after an applied write retains evidence and does not retry', async () => {
  let steps = 0;
  const f = fixture(async () => { if (++steps === 1) return response(call('a', 'execute_github_change')); throw new Error('secret provider detail'); });
  let writes = 0;
  await assert.rejects(f.agent.run({ ...run, handle: async () => { writes++; return { status: 'applied', id: 'change1' }; } }), /unexpected service error/);
  assert.equal(steps, 2); assert.equal(writes, 1);
  assert.equal(f.store.recentRuns(run.key)[0]?.status, 'failed');
  assert.match(f.store.recentRuns(run.key)[0]?.messages.at(-1)?.content as string, /applied/);
  assert.doesNotMatch(await f.agent.status(run.key), /secret provider detail/);
  const seen: ModelRequest[] = [];
  const next = fixture(sequence([answer], seen), {}, f.store);
  await next.agent.run({ ...run, requestId: 'r2', contextProvided: true });
  assert.match(seen[0]!.instructions, /change1/);
  f.store.close();
});

test('full Discord snapshots are not duplicated; standalone follow-ups retain memory', async () => {
  const seen: ModelRequest[] = [];
  const f = fixture(sequence([answer, answer, answer], seen));
  await f.agent.run({ ...run, input: 'Unique previous request' });
  await f.agent.run({ ...run, requestId: 'r2', input: 'New full snapshot', contextProvided: true });
  assert.doesNotMatch(seen[1]!.instructions, /Unique previous request/);
  assert.equal(seen[1]!.messages.length, 1);
  await f.agent.run({ ...run, requestId: 'r3' });
  assert.match(seen[2]!.instructions, /Unique previous request/);
  await f.agent.reset(run.key);
  assert.equal(f.store.recentRuns(run.key).length, 0);
  f.store.close();
});

test('slow or failed progress updates cannot block model or tools', { timeout: 1000 }, async () => {
  for (const progress of [async () => new Promise<void>(() => {}), async () => { throw new Error('Discord failed'); }]) {
    let step = 0;
    const f = fixture(async request => { request.progress('Checking'); return ++step === 1 ? response(call('a')) : answer; });
    assert.equal(await f.agent.run({ ...run, progress }), answer.content);
    f.store.close();
  }
});

test('budget exhaustion and timeout fail explicitly instead of returning partial text', async () => {
  const f = fixture(sequence([response(call('a'))]), { maxSteps: 1 });
  await assert.rejects(f.agent.run(run), /step limit/); f.store.close();
  const t = fixture(async ({ controller }) => new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })), { timeoutSeconds: 0.01 });
  await assert.rejects(t.agent.run(run), /timed out/);
  assert.equal(t.store.recentRuns(run.key)[0]?.status, 'timed_out'); t.store.close();
});

test('invalid tool batches execute nothing', async () => {
  for (const message of [response(call('a'), call('a')), response(call('a'), call('b', 'unknown')), response({ ...call('a'), function: { name: 'github_query', arguments: '{bad' } })]) {
    const f = fixture(sequence([message])); let calls = 0;
    await assert.rejects(f.agent.run({ ...run, handle: async () => { calls++; } }));
    assert.equal(calls, 0); f.store.close();
  }
});

test('restart marks active runs interrupted without replaying tools or losing the legacy ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erga-run-'));
  try {
    let s = new Store(join(dir, 'state.sqlite'));
    s.saveConversation('g:c', 'old-managed-session');
    s.saveRun({ id: 'r', key: 'g:c', provider: 'gemini', model: 'gemini-3.8-flash', status: 'running', messages: [response(call('a'))], error: null, created: Date.now(), updated: Date.now() });
    s.saveCall('r:a', { success: false, error: 'unknown' }); s.close();
    s = new Store(join(dir, 'state.sqlite'));
    assert.equal(s.recentRuns('g:c')[0]?.status, 'interrupted');
    assert.equal(s.conversation('g:c')?.session_id, 'old-managed-session');
    assert.equal(s.call('r:a')?.error, 'unknown'); s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an incomplete or errored stream cannot be treated as a completed response', async () => {
  const request: ModelRequest = { messages: [], instructions: '', tools: [], controller: new AbortController(), progress: () => {} };
  for (const events of [[], [{ type: 'RUN_ERROR', code: '429', message: 'private detail' }], [{ type: 'RUN_FINISHED', finishReason: 'length' }]]) {
    await assert.rejects(collectModelResponse((async function* () { yield* events as StreamChunk[]; })(), request));
  }
});

test('provider configuration requires only the selected credential and preserves exact model IDs', () => {
  assert.equal(modelConfig({ GEMINI_API_KEY: 'test' }).model, 'gemini-3.8-flash');
  assert.equal(modelConfig({ AI_PROVIDER: 'anthropic', AI_MODEL: 'chosen-model', ANTHROPIC_API_KEY: 'test' }).model, 'chosen-model');
  assert.throws(() => modelConfig({ AI_PROVIDER: 'openai', AI_MODEL: 'chosen-model', GEMINI_API_KEY: 'test' }), /OPENAI_API_KEY/);
  assert.throws(() => modelConfig({ AI_PROVIDER: 'unsupported' }));
});


test('a reused read-call ID with new arguments fetches fresh data', async () => {
  const f = fixture(sequence([response(call('same', 'github_query', { page: 1 })), response(call('same', 'github_query', { page: 2 })), answer]));
  const pages: unknown[] = [];
  await f.agent.run({ ...run, handle: async (_, args) => { pages.push(args); return {}; } });
  assert.deepEqual(pages, [{ page: 1 }, { page: 2 }]); f.store.close();
});

test('stream reconstruction preserves tool metadata and requires completed arguments', async () => {
  const request: ModelRequest = { messages: [], instructions: '', tools: [], controller: new AbortController(), progress: () => {} };
  const events = [
    { type: 'RUN_STARTED', runId: 'r', threadId: 't' },
    { type: 'TOOL_CALL_START', toolCallId: 'c', toolCallName: 'github_query', parentMessageId: 'm', metadata: { thoughtSignature: 'opaque' } },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'c', delta: '{"page":1}' },
    { type: 'TOOL_CALL_END', toolCallId: 'c' },
    { type: 'RUN_FINISHED', runId: 'r', threadId: 't', finishReason: 'tool_calls' },
  ] as StreamChunk[];
  const result = await collectModelResponse((async function* () { yield* events; })(), request);
  assert.equal((result.toolCalls?.[0]?.metadata as any).thoughtSignature, 'opaque');
  assert.equal(result.toolCalls?.[0]?.function.arguments, '{"page":1}');
  await assert.rejects(collectModelResponse((async function* () { yield* events.filter(e => e.type !== 'TOOL_CALL_END'); })(), request), /incomplete/);
});

test('busy threads reject concurrent work and shutdown waits for the active handler', async () => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(sequence([response(call('a', 'execute_github_change'))]));
  const pending = f.agent.run({ ...run, handle: async () => { entered(); await gate; return { status: 'applied' }; } });
  const rejection = assert.rejects(pending, /stopped/);
  await ready;
  await assert.rejects(f.agent.run({ ...run, requestId: 'r2' }), /already working/);
  await assert.rejects(f.agent.reset(run.key), /current request/);
  let shutdownFinished = false;
  const shutdown = f.agent.shutdown().then(() => { shutdownFinished = true; });
  await Promise.resolve(); assert.equal(shutdownFinished, false);
  finish(); await shutdown; await rejection;
  assert.equal(f.store.recentRuns(run.key)[0]?.messages.at(-1)?.role, 'tool'); f.store.close();
});
