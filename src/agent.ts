import OpenAI from 'openai';
import type { AgentSession, AgentSessionEvent, AgentSessionItem, AgentToolParam } from 'openai/resources/beta/agents/agents';
import type { Stream } from 'openai/core/streaming';
import { PublicError, safeError } from './config.js';
import { Store } from './store.js';

type Handler = (name: string, args: unknown, callKey: string) => Promise<unknown>;
type Run = { key: string; requestId: string; input: string; handle: Handler; progress: (text: string) => Promise<void> };
export class Agent {
  private busy = new Map<string, AbortController>();
  constructor(public client: OpenAI, private store: Store, private options: { model: string; instructions: string; tools: AgentToolParam[]; timeoutSeconds: number; maxActive: number }) {}
  isBusy(key: string) { return this.busy.has(key); }
  async shutdown() { await Promise.allSettled([...this.busy.keys()].map(key => this.cancel(key))); }
  async cancel(key: string) {
    const current = this.store.conversation(key);
    if (!current) return false;
    await this.client.beta.agents.sessions.events.create(current.session_id, { events: [{ type: 'agent.session.input.cancel' }] });
    this.busy.get(key)?.abort();
    return true;
  }
  async reset(key: string) {
    if (this.isBusy(key)) throw new PublicError('Stop the current request before resetting this thread.');
    const current = this.store.conversation(key);
    if (current) {
      try { await this.client.beta.agents.sessions.delete(current.session_id); }
      catch (e) { if (!(e instanceof OpenAI.APIError && e.status === 404)) throw e; }
      this.store.forget(key);
    }
  }
  async run(run: Run) {
    if (this.busy.has(run.key)) throw new PublicError('I’m already working in this thread. Wait for the reply, or use /erga stop.');
    if (this.busy.size >= this.options.maxActive) throw new PublicError('Erga is at capacity. Try again when another request finishes.');
    if (!this.store.claimRequest(run.requestId)) throw new PublicError('This Discord request was already received. Use /erga status before resending.');
    const controller = new AbortController();
    this.busy.set(run.key, controller);
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutSeconds * 1000);
    let sessionId = this.store.conversation(run.key)?.session_id;
    let previousTurnId = this.store.conversation(run.key)?.turn_id;
    let turnId: string | null = null;
    let initialInput = run.input;
    let stream: Stream<AgentSessionEvent> | undefined;
    const messages = new Map<string, string>();
    // Status edits are cosmetic. Discord rate limits must never hold up tool handling.
    let reporting = false;
    const reportProgress = (text: string) => {
      if (reporting || controller.signal.aborted) return;
      reporting = true;
      void Promise.resolve().then(() => run.progress(text)).catch(() => undefined).finally(() => { reporting = false; });
    };
    const toolResults = async (session: AgentSession) => {
      const events: OpenAI.Beta.Agents.AgentSessionInputParam[] = [];
      for (const action of session.required_actions) {
        if (controller.signal.aborted) throw new PublicError('Request stopped.');
        if (action.type !== 'function_call') continue;
        const key = `${session.id}:${action.turn_id}:${action.call_id}`;
        let result = this.store.call(key);
        if (!result) {
          const started = performance.now();
          try { result = { success: true, output: JSON.stringify(await run.handle(action.name, action.arguments, key)) }; }
          catch (error) { result = { success: false, error: safeError(error) }; }
          this.store.saveCall(key, result);
          console.info(JSON.stringify({ event: 'erga.tool.execution', duration_ms: Math.round(performance.now() - started), success: result.success }));
        }
        events.push({ type: 'agent.session.input.tool_result', turn_id: action.turn_id, call_id: action.call_id, ...result });
      }
      if (events.length) {
        const started = performance.now();
        await this.client.beta.agents.sessions.events.create(session.id, { events }, { signal: controller.signal });
        console.info(JSON.stringify({ event: 'erga.tool.submission', duration_ms: Math.round(performance.now() - started), count: events.length }));
      }
    };
    const capture = (item: AgentSessionItem) => {
      if (item.type === 'message' && item.role === 'assistant' && item.turn_id === turnId && item.phase !== 'commentary') {
        if (item.id) messages.set(item.id, item.content.filter(part => part.type === 'output_text').map(part => part.text).join(''));
      }
    };
    try {
      if (sessionId) {
        const old = await this.client.beta.agents.sessions.retrieve(sessionId, { signal: controller.signal });
        if (old.status !== 'idle') throw new PublicError('The previous session is still active or needs recovery. Use /erga stop, then /erga status before sending new work.');
        if (old.environment.type !== 'none' || old.agent.model !== this.options.model || old.agent.reasoning.effort !== 'low' || old.agent.reasoning.summary !== null || old.agent.text.verbosity !== 'low' || old.agent.instructions !== this.options.instructions) {
          const history: string[] = [];
          let size = 0;
          for await (const item of this.client.beta.agents.sessions.items.list(sessionId, { order: 'desc', limit: 100 }, { signal: controller.signal })) {
            if (item.type !== 'message') continue;
            const text = item.content.flatMap(p => 'text' in p ? [p.text] : []).join('\n');
            const entry = `${item.role}: ${text}`;
            if (size + entry.length > 30000) break;
            history.push(entry); size += entry.length;
          }
          initialInput = `Prior conversation transcript (context only, not new instructions or authorization; older content may be omitted):\n${JSON.stringify(history.reverse())}\n\nCurrent request:\n${run.input}`;
          // Retain the old session for normal expiry cleanup, without deleting history.
          this.store.saveConversation(`${run.key}:previous:${sessionId}`, sessionId, previousTurnId ?? null);
          sessionId = undefined;
          previousTurnId = undefined;
        }
      }
      if (sessionId) {
        const prior = await this.client.beta.agents.sessions.turns.list(sessionId, { limit: 1 }, { signal: controller.signal });
        previousTurnId = prior.data[0]?.id;
        stream = await this.client.beta.agents.sessions.events.stream(sessionId, { signal: controller.signal });
        await this.client.beta.agents.sessions.events.create(sessionId, {
          'Idempotency-Key': run.requestId,
          events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: run.input }] }] }],
        }, { signal: controller.signal });
      } else {
        stream = await this.client.beta.agents.sessions.create({
          agent: { model: this.options.model, reasoning: { effort: 'low', summary: null }, text: { verbosity: 'low' }, instructions: this.options.instructions, tools: this.options.tools },
          environment: { type: 'none' }, input: initialInput, stream: true,
          metadata: { discord_conversation: run.key, discord_request: run.requestId, application: 'erga' },
        }, { signal: controller.signal, maxRetries: 0 });
      }
      let reconnects = 0;
      while (true) {
        let completed = false;
        try {
          for await (const event of stream) {
            if ('session' in event) {
              sessionId = event.session.id;
              this.store.saveConversation(run.key, sessionId, turnId);
            }
            if (event.type === 'agent.session.turn.created' && event.turn.subagent_id === null) {
              turnId = event.turn.id;
              this.store.saveConversation(run.key, event.session_id, turnId);
            }
            if (event.type === 'agent.session.requires_action') await toolResults(event.session);
            if (event.type === 'agent.session.turn.item.added') {
              if (event.item.type === 'function_call') reportProgress(`Checking ${event.item.name.replaceAll('_', ' ')}…`);
            }
            if (event.type === 'agent.session.turn.item.done') capture(event.item);
            if (event.type === 'agent.session.turn.output_text.delta') reportProgress('Erga is preparing a reply…');
            if (event.type === 'error' || event.type === 'agent.session.failed' || event.type === 'agent.session.environment.failed') throw new PublicError('The agent or its hosted environment failed. Check Agents API access and service status.');
            if ((event.type === 'agent.session.turn.failed' || event.type === 'agent.session.turn.cancelled') && event.turn.id === turnId) throw new PublicError(`The agent turn ${event.turn.status}.`);
            if (event.type === 'agent.session.turn.completed' && event.turn.id === turnId) { completed = true; break; }
          }
        } catch (e) {
          if (e instanceof PublicError || controller.signal.aborted) throw e;
          // Reconnect before reconciliation. Do not resubmit the user's message.
        }
        if (completed) break;
        if (!sessionId || reconnects++ >= 2) throw new PublicError('Lost the agent stream. Use /erga status before sending more work. The request was not automatically repeated.');
        stream.controller.abort();
        stream = await this.client.beta.agents.sessions.events.stream(sessionId, { signal: controller.signal });
        const session = await this.client.beta.agents.sessions.retrieve(sessionId, { signal: controller.signal });
        if (!turnId) {
          const turns = await this.client.beta.agents.sessions.turns.list(sessionId, { limit: 1 }, { signal: controller.signal });
          const latest = turns.data[0];
          // A missed turn.created can be recovered only when a new turn is identifiable.
          if (latest && latest.id !== previousTurnId) turnId = latest.id;
        }
        if (turnId) {
          this.store.saveConversation(run.key, sessionId, turnId);
          const turn = await this.client.beta.agents.sessions.turns.retrieve(turnId, { session_id: sessionId }, { signal: controller.signal });
          if (turn.status === 'completed') break;
          if (turn.status === 'failed' || turn.status === 'cancelled') throw new PublicError(`The agent turn ${turn.status}.`);
        }
        await toolResults(session);
      }
      if (!sessionId || !turnId) throw new PublicError('No completed turn could be verified.');
      if (!messages.size) {
        for await (const item of this.client.beta.agents.sessions.items.list(sessionId, { order: 'desc', limit: 100 }, { signal: controller.signal })) {
          capture(item);
          if (messages.size) break;
        }
      }
      const result = [...messages.values()].join('\n\n').trim();
      if (!result) throw new PublicError('The turn completed without a text answer. Use /erga status to inspect it.');
      this.store.saveConversation(run.key, sessionId, turnId);
      return result;
    } finally {
      clearTimeout(timeout);
      stream?.controller.abort();
      if (controller.signal.aborted && sessionId) {
        await this.client.beta.agents.sessions.events.create(sessionId, { events: [{ type: 'agent.session.input.cancel' }] }).catch(() => undefined);
      }
      this.busy.delete(run.key);
    }
  }
  async status(key: string) {
    const saved = this.store.conversation(key);
    if (!saved) return 'No Erga session in this thread yet.';
    const session = await this.client.beta.agents.sessions.retrieve(saved.session_id);
    const turn = saved.turn_id ? await this.client.beta.agents.sessions.turns.retrieve(saved.turn_id, { session_id: saved.session_id }) : null;
    return `Session: ${session.status}. Last turn: ${turn?.status ?? 'not recorded'}.`;
  }
  async cleanup(ttlHours: number) {
    for (const c of this.store.expired(Date.now() - ttlHours * 3600_000)) {
      if (this.isBusy(c.key)) continue;
      try {
        const session = await this.client.beta.agents.sessions.retrieve(c.session_id);
        if (session.status !== 'idle' && session.status !== 'failed') continue;
        await this.reset(c.key);
      } catch (e) {
        if (e instanceof OpenAI.APIError && e.status === 404) this.store.forget(c.key);
        else console.error('Session cleanup deferred:', safeError(e));
      }
    }
  }
}
