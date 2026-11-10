import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from './security.js';
import type { AgentStream } from './agent-model.js';

export async function agentResponse<T>(
  req: Request,
  res: Response,
  run: (stream?: AgentStream) => Promise<T>,
) {
  if (!req.get('accept')?.includes('text/event-stream')) {
    res.json(await run());
    return;
  }
  const controller = new AbortController();
  const write = (event: unknown) => {
    if (controller.signal.aborted) throw new DOMException('Disconnected', 'AbortError');
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const disconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', disconnect);
  const heartbeat = setInterval(() => {
    if (!controller.signal.aborted) res.write(': keepalive\n\n');
  }, 15000);
  heartbeat.unref();
  try {
    write({ type: 'thinking' });
    const result = await run({
      signal: controller.signal,
      onText: async (text) => write({ type: 'answer', text }),
    });
    write({ type: 'done', result });
  } catch (error) {
    if (!controller.signal.aborted) {
      const status =
        error instanceof ApiError ? error.status : error instanceof ZodError ? 400 : 500;
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof ZodError
            ? '输入格式不正确'
            : '服务暂时不可用，请稍后重试';
      write({ type: 'error', status, error: message });
    }
  } finally {
    clearInterval(heartbeat);
    res.off('close', disconnect);
    res.end();
  }
}
