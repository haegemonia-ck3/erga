import { chat, maxIterations, StreamProcessor, convertMessagesToModelMessages, type AnyTextAdapter, type ModelMessage, type Tool, type StreamChunk } from '@tanstack/ai';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createOpenaiChat } from '@tanstack/ai-openai';
import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { PublicError } from './config.js';

export type ModelRequest = { messages: ModelMessage[]; instructions: string; tools: Tool[]; controller: AbortController; progress: (text: string) => void };
export type ModelStep = (request: ModelRequest) => Promise<ModelMessage>;
export type ModelSettings = { provider: 'gemini' | 'openai' | 'anthropic'; model: string; apiKey: string };

// Each invocation is one model response. Erga owns execution, persistence and retries.
export function createModel(settings: ModelSettings): ModelStep {
  let adapter: AnyTextAdapter;
  let modelOptions: Record<string, unknown>;
  switch (settings.provider) {
    case 'gemini':
      adapter = createGeminiChat(settings.model as Parameters<typeof createGeminiChat>[0], settings.apiKey);
      modelOptions = { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: false }, maxOutputTokens: 8192 };
      break;
    case 'openai':
      adapter = createOpenaiChat(settings.model as Parameters<typeof createOpenaiChat>[0], settings.apiKey, { maxRetries: 0 });
      modelOptions = { max_output_tokens: 8192 };
      break;
    case 'anthropic':
      adapter = createAnthropicChat(settings.model as Parameters<typeof createAnthropicChat>[0], settings.apiKey, { maxRetries: 0 });
      modelOptions = { max_tokens: 8192 };
      break;
  }
  return request => collectModelResponse(chat({
    adapter, messages: request.messages, systemPrompts: [request.instructions],
    tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), modelOptions, abortController: request.controller,
    agentLoopStrategy: maxIterations(1),
  }), request);
}

export async function collectModelResponse(stream: AsyncIterable<StreamChunk>, request: ModelRequest): Promise<ModelMessage> {
  const processor = new StreamProcessor();
  let completed = false;
  const pendingCalls = new Set<string>();
  let finishReason: string | null | undefined;
  for await (const event of stream) {
    request.controller.signal.throwIfAborted();
    if (event.type === 'RUN_ERROR') {
      // Provider messages can contain request data. Expose only a bounded error code.
      const code = String(event.code ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      throw new PublicError(`The model request failed${code ? ` (${code})` : ''}. No automatic retry was made. Use /erga status before repeating changes.`);
    }
    if (event.type === 'TOOL_CALL_START') pendingCalls.add(event.toolCallId);
    if (event.type === 'TOOL_CALL_END') pendingCalls.delete(event.toolCallId);
    processor.processChunk(event);
    if (event.type === 'TOOL_CALL_START') request.progress(`Checking ${event.toolCallName.replaceAll('_', ' ')}…`);
    if (event.type === 'TEXT_MESSAGE_CONTENT') request.progress('Erga is preparing a reply…');
    if (event.type === 'RUN_FINISHED') {
      completed = true;
      finishReason = event.finishReason ?? event.metadata?.tanstack?.finishReason;
    }
  }
  request.controller.signal.throwIfAborted();
  if (pendingCalls.size || !completed || !['stop', 'tool_calls'].includes(finishReason ?? '')) throw new PublicError('The model response was interrupted or incomplete. No tools from that response were executed.');
  const messages = convertMessagesToModelMessages(processor.getMessages());
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') throw new PublicError('The model returned no usable answer.');
  // The processor preserves Gemini thought signatures and other opaque provider metadata.
  return last;
}
