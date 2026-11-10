import { afterEach, expect, it, vi } from 'vitest';
import { callAgent, partialAnswer, type AgentModelInput } from '../server/agent-model.js';
import { SseFrames } from '../shared/sse.js';
import { streamApi } from '../src/api.js';

const input: AgentModelInput = {
  snapshot: { label: '合成', sources: [], warnings: [] },
  history: [],
  question: '合成流式问题',
};
function bytesResponse(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
afterEach(() => vi.unstubAllGlobals());

it('frames split SSE packets with CRLF, comments and multiline data', () => {
  const parser = new SseFrames();
  expect(parser.push(': keepalive\r\n\r\ndata: {"type":')).toEqual([]);
  expect(parser.push('"answer"}\r\n\r\ndata: first\ndata: second\n\n')).toEqual([
    '{"type":"answer"}',
    'first\nsecond',
  ]);
});
it('decodes only the partial answer and holds incomplete escapes and surrogate pairs', () => {
  expect(partialAnswer('{"answer":"第一段\\n第')).toBe('第一段\n第');
  expect(partialAnswer('{"answer":"\\u4f60\\u59')).toBe('你');
  expect(partialAnswer('{"answer":"\\uD83D')).toBe('');
  expect(partialAnswer('{"answer":"\\uD83D\\uDE00","source_ids":[]}')).toBe('😀');
  expect(partialAnswer('{"answer":"引号\\"正确')).toBe('引号"正确');
  expect(partialAnswer('{"reasoning_content":"SECRET_REASONING"}')).toBeUndefined();
  expect(partialAnswer('<think>SECRET_REASONING</think>{"answer":"内容"}')).toBeUndefined();
});
it('reads real provider-style deltas across UTF8 boundaries without forwarding reasoning or JSON syntax', async () => {
  const deltas =
    frame({
      choices: [{ delta: { reasoning_content: 'SECRET_REASONING' }, finish_reason: null }],
    }) +
    frame({ choices: [{ delta: { content: '{"answer":"你' }, finish_reason: null }] }) +
    frame({
      choices: [{ delta: { content: '好\\n第二段","source_ids":[]}' }, finish_reason: 'stop' }],
    }) +
    'data: [DONE]\n\n';
  const seen: string[] = [];
  let requestBody: Record<string, unknown> = {};
  const upstream = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return bytesResponse(deltas);
  }) as typeof fetch;
  const result = await callAgent(input, 'SECRET_KEY', 'cn', upstream, {
    signal: new AbortController().signal,
    onText: async (text) => {
      seen.push(text);
    },
  });
  expect(requestBody.stream).toBe(true);
  expect(result).toEqual({ answer: '你好\n第二段', source_ids: [] });
  expect(seen[0]).toBe('你');
  expect(seen.at(-1)).toBe('你好\n第二段');
  expect(seen.join('')).not.toMatch(/SECRET|source_ids|answer/);
});
it('rejects incomplete upstream streams and forwards caller cancellation without retry', async () => {
  let calls = 0;
  const incomplete = (async () => {
    calls++;
    return bytesResponse(
      frame({ choices: [{ delta: { content: '{"answer":"临时' }, finish_reason: null }] }),
    );
  }) as typeof fetch;
  await expect(
    callAgent(input, 'fixture', 'cn', incomplete, {
      signal: new AbortController().signal,
      onText: async () => {},
    }),
  ).rejects.toThrow('未完成');
  expect(calls).toBe(1);
  const controller = new AbortController();
  const hanging = (async (_url, init) =>
    new Response(
      new ReadableStream({
        start(stream) {
          init?.signal?.addEventListener(
            'abort',
            () => stream.error(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch;
  const pending = callAgent(input, 'fixture', 'cn', hanging, {
    signal: controller.signal,
    onText: async () => {},
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('browser stream client delivers incremental text and returns the verified completion', async () => {
  const done = { messages: [{ body: '你好' }] };
  const transport = vi.fn(async () =>
    bytesResponse(
      frame({ type: 'thinking' }) +
        frame({ type: 'answer', text: '你' }) +
        frame({ type: 'answer', text: '你好' }) +
        frame({ type: 'done', result: done }),
    ),
  );
  vi.stubGlobal('fetch', transport);
  const seen: string[] = [];
  const result = await streamApi('/chats/fixture/messages', {
    workspace: 'fixture',
    body: {},
    onText: (text) => seen.push(text),
  });
  expect(seen).toEqual(['你', '你好']);
  expect(result).toEqual(done);
  expect(transport).toHaveBeenCalledTimes(1);
});
it('browser stream client rejects server errors and dropped connections rather than accepting a partial answer', async () => {
  vi.stubGlobal('fetch', async () =>
    bytesResponse(
      frame({ type: 'answer', text: '临时正文' }) +
        frame({ type: 'error', status: 409, error: '资料已变化' }),
    ),
  );
  await expect(
    streamApi('/ask/query', { workspace: 'fixture', body: {}, onText: () => {} }),
  ).rejects.toMatchObject({ status: 409, message: '资料已变化' });
  vi.stubGlobal('fetch', async () => bytesResponse(frame({ type: 'answer', text: '尚未完成' })));
  await expect(
    streamApi('/ask/query', { workspace: 'fixture', body: {}, onText: () => {} }),
  ).rejects.toThrow('连接中断');
});
