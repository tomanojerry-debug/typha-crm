import fixtureData from './fixture.json';
import type { DemoFixture } from './types';
import { createDemoTransport, DEMO_UNAVAILABLE, type DemoRequestOptions } from './transport';
import { HttpError } from '../src/api';

export { HttpError, transientReadFailure } from '../src/api';
export const isDemoRuntime = () => true;
export const demoTransport = createDemoTransport(fixtureData as DemoFixture);
export const resetDemoData = () => demoTransport.reset();

export function api<T>(path: string, options: DemoRequestOptions = {}): Promise<T> {
  return demoTransport.request<T>(path, options);
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
