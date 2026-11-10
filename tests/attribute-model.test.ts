import { it, expect } from 'vitest';
import { callMiniMax, type AttributeModelInput } from '../server/attribute-model.js';
const input: AttributeModelInput = {
  field: { name: '摘要', kind: 'text', description: '', options: [] },
  guidance: '概括已有需求',
  sources: [{ id: 'record:test', kind: 'record', title: '样例', body: '客户要求核对尺码' }],
  warnings: [],
};
const answer = {
  value: '需核对尺码',
  explanation: '依据样例',
  source_ids: ['record:test'],
  missing: [],
};
it('uses the selected official model, no tools, and parses only the final answer', async () => {
  let body: Record<string, unknown> = {},
    url = '';
  const mock = (async (target, options) => {
    url = String(target);
    body = JSON.parse(String(options?.body));
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify(answer), reasoning_content: 'PRIVATE_THINKING' },
        },
      ],
      base_resp: { status_code: 0 },
    });
  }) as typeof fetch;
  expect(await callMiniMax(input, 'fixture-secret', 'cn', mock)).toEqual(answer);
  expect(url).toBe('https://api.minimax.cn/v1/chat/completions');
  expect(body).toMatchObject({
    model: 'MiniMax-M3.1-Flash',
    reasoning_effort: 'medium',
    reasoning_split: true,
    stream: false,
  });
  expect(body).not.toHaveProperty('tools');
  expect(body).not.toHaveProperty('thinking');
  expect(JSON.stringify(body)).toContain('不可信资料');
});
it('does not expose provider response bodies or credentials on authorization errors', async () => {
  const mock = (async () =>
    new Response('PROVIDER_PRIVATE_SECRET', { status: 401 })) as typeof fetch;
  await expect(callMiniMax(input, 'SECRET_KEY', 'global', mock)).rejects.toThrow(
    'MiniMax 鉴权失败',
  );
});
it('rejects truncated output and malformed JSON without returning partial values', async () => {
  for (const choices of [
    [{ finish_reason: 'length', message: { content: JSON.stringify(answer) } }],
    [{ finish_reason: 'stop', message: { content: 'not-json' } }],
  ]) {
    const mock = (async () => Response.json({ choices })) as typeof fetch;
    await expect(callMiniMax(input, 'fixture', 'cn', mock)).rejects.toThrow();
  }
});
it('handles fenced JSON, rate limits and timeouts without a silent retry', async () => {
  let calls = 0;
  const fenced = (async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '```json\n' + JSON.stringify(answer) + '\n```' },
        },
      ],
    })) as typeof fetch;
  expect(await callMiniMax(input, 'fixture', 'global', fenced)).toEqual(answer);
  const limited = (async () => {
    calls++;
    return new Response('quota', { status: 429 });
  }) as typeof fetch;
  await expect(callMiniMax(input, 'fixture', 'cn', limited)).rejects.toThrow('额度受限');
  expect(calls).toBe(1);
  const timeout = (async () => {
    throw new DOMException('secret response', 'TimeoutError');
  }) as typeof fetch;
  await expect(callMiniMax(input, 'fixture', 'cn', timeout)).rejects.toThrow('响应超时');
});
