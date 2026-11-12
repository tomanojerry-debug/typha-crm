import fixtureData from './fixture.json';
import type { DemoFixture } from './types';
import { DEMO_UNAVAILABLE, type DemoRequestOptions } from './transport';
import { createDemoRuntime } from './runtime';
import { HttpError } from '../src/api';

export { HttpError, transientReadFailure } from '../src/api';
export const isDemoRuntime = () => true;
export function bindApiActor(_actorId: string) {
  // The browser-only runtime binds each request to its selected role.
}
export const demoRuntime = createDemoRuntime(fixtureData as DemoFixture);
let logoutListener: (() => void) | undefined;
export function onDemoLogout(listener: () => void) {
  logoutListener = listener;
  return () => {
    if (logoutListener === listener) logoutListener = undefined;
  };
}

export async function api<T>(path: string, options: DemoRequestOptions = {}): Promise<T> {
  const result = await demoRuntime.request<T>(path, options);
  if (path === '/auth/logout' && options.method === 'POST') logoutListener?.();
  return result;
}

/** Live generation and subscriptions are intentionally absent from this static experience. */
export async function streamApi<T>(
  _path: string,
  options: { workspace: string; body: unknown; signal?: AbortSignal; onText(text: string): void },
): Promise<T> {
  if (options.signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
  throw new HttpError(DEMO_UNAVAILABLE, 403);
}

export async function watchApi<T>(
  _path: string,
  options: { workspace: string; signal: AbortSignal; onEvent(event: T): boolean | void },
): Promise<void> {
  if (options.signal.aborted) throw new DOMException('操作已取消', 'AbortError');
  throw new HttpError(DEMO_UNAVAILABLE, 403);
}
