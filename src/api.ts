import { SseFrames } from '../shared/sse';

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const transientReadFailure = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof HttpError &&
    ([408, 429].includes(error.status) || (error.status >= 500 && error.status <= 599)));

// A subscription owns only this HTTP connection. Aborting it never cancels a job.
export async function watchApi<T>(
  path: string,
  options: { workspace: string; signal: AbortSignal; onEvent(event: T): boolean | void },
): Promise<void> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { Accept: 'text/event-stream', 'x-workspace-id': options.workspace },
    signal: options.signal,
  });
  if (!response.ok) {
    const result = await response.json();
    throw new HttpError(result.error || '无法恢复回复', response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError('回复连接暂时不可用', 502);
  const frames = new SseFrames();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) {
        if (options.onEvent(JSON.parse(frame) as T) === false) return;
      }
    }
    throw new HttpError('回复连接已断开，正在恢复', 502);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function streamApi<T>(
  path: string,
  options: { workspace: string; body: unknown; signal?: AbortSignal; onText(text: string): void },
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-workspace-id': options.workspace,
    },
    body: JSON.stringify(options.body),
    signal: options.signal,
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const result = await response.json();
    if (!response.ok) throw new HttpError(result.error || '请求失败', response.status);
    return result as T;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError('未能读取回复，请重试', 502);
  const frames = new SseFrames(),
    decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) {
        const event = JSON.parse(frame);
        if (event.type === 'answer' && typeof event.text === 'string') options.onText(event.text);
        if (event.type === 'error')
          throw new HttpError(event.error || '回复中断，请重试', event.status || 502);
        if (event.type === 'done') return event.result as T;
      }
    }
    throw new HttpError('回复连接中断，本次结果尚未确认，请重试', 502);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function api<T>(
  path: string,
  options: {
    workspace?: string;
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const requestBody = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const keepalive = Boolean(
    options.keepalive &&
    (!requestBody || new TextEncoder().encode(requestBody).byteLength <= 65536),
  );
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.workspace ? { 'x-workspace-id': options.workspace } : {}),
    },
    ...(options.body !== undefined ? { body: requestBody } : {}),
    signal: options.signal,
    ...(keepalive ? { keepalive: true } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const details = result.details
      ?.map((d: { field: string; message: string }) => `${d.field}: ${d.message}`)
      .join('；');
    throw new HttpError(
      details ? `${result.error}：${details}` : (result.error ?? '请求失败'),
      response.status,
    );
  }
  return result as T;
}
