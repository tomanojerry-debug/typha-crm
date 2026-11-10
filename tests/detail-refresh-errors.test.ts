import { expect, it } from 'vitest';
import { HttpError, transientReadFailure } from '../src/api.js';

it('keeps an already loaded detail available through temporary network and service failures', () => {
  expect(transientReadFailure(new TypeError('network unavailable'))).toBe(true);
  for (const status of [408, 429, 500, 502, 503, 504])
    expect(transientReadFailure(new HttpError('temporary failure', status))).toBe(true);
});

it('clears stale detail after authentication, permission or scope failures', () => {
  for (const status of [400, 401, 403, 404, 409])
    expect(transientReadFailure(new HttpError('scope unavailable', status))).toBe(false);
  expect(transientReadFailure(new Error('unexpected failure'))).toBe(false);
});
