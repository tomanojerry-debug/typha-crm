import { afterEach, expect, it, vi } from 'vitest';
import { minimaxChatEndpoint } from '../server/minimax-endpoint.js';

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, 'official'])(
  'uses the official China endpoint when configured as %s',
  (value) => {
    vi.stubEnv('MINIMAX_CN_ENDPOINT', value);
    expect(minimaxChatEndpoint('cn')).toBe('https://api.minimax.cn/v1/chat/completions');
  },
);

it('selects only the fixed China compatible endpoint when explicitly configured', () => {
  vi.stubEnv('MINIMAX_CN_ENDPOINT', 'compatible');
  expect(minimaxChatEndpoint('cn')).toBe('https://api.minimaxi.com/v1/chat/completions');
});

it.each([undefined, 'official', 'compatible', 'invalid'])(
  'keeps global accounts on the global endpoint with China setting %s',
  (value) => {
    vi.stubEnv('MINIMAX_CN_ENDPOINT', value);
    expect(minimaxChatEndpoint('global')).toBe('https://api.minimax.io/v1/chat/completions');
  },
);

it.each(['', 'invalid', 'https://example.invalid/v1/chat/completions'])(
  'rejects unsupported China endpoint configuration %s',
  (value) => {
    vi.stubEnv('MINIMAX_CN_ENDPOINT', value);
    expect(() => minimaxChatEndpoint('cn')).toThrow(
      'MINIMAX_CN_ENDPOINT must be official or compatible',
    );
  },
);
