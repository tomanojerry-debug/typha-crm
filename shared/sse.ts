/** Incremental SSE framing shared by the server adapter and browser client. */
export class SseFrames {
  private buffer = '';
  push(text: string): string[] {
    this.buffer += text;
    const output: string[] = [];
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'));
      if (data.length) output.push(data.map((line) => line.slice(5).replace(/^ /, '')).join('\n'));
    }
    if (this.buffer.length > 1_000_000) throw new Error('SSE frame too large');
    return output;
  }
}
