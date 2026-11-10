import type { NoteBlock, NoteContent, NoteDraft, SaveNoteDraft } from '../shared/notes';

export const noteContentOf = (content: NoteContent): NoteContent => ({
  title: content.title,
  customer_id: content.customer_id,
  project_id: content.project_id,
  person_ids: [...content.person_ids],
  blocks: content.blocks.map((block) => ({
    ...block,
    sources: block.sources.map((source) => ({ ...source })),
  })),
});
export const noteSignature = (content: NoteContent) => JSON.stringify(noteContentOf(content));
export const noteHasText = (content: NoteContent) => content.blocks.some((b) => b.text.trim());
export const noteCanPublish = (content: NoteContent) =>
  Boolean(content.customer_id && content.title.trim() && noteHasText(content));
export const editNoteBlock = (block: NoteBlock, text: string): NoteBlock => ({
  ...block,
  text,
  origin: block.origin === 'quote' && text !== block.text ? 'derived' : block.origin,
  // Editing a summary never removes its original provenance.
  sources: block.sources.map((source) => ({ ...source })),
});
export function safeNoteHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Serializes private autosaves and preserves a failed request for exact replay. */
export class NoteDraftWriter {
  version: number;
  private latest: NoteContent;
  private saved: string;
  private pending: SaveNoteDraft | null = null;
  private running: Promise<NoteDraft | null> | null = null;
  private last: NoteDraft | null = null;
  private disposed = false;
  constructor(
    private readonly draftId: string,
    private readonly noteId: string | null,
    private readonly baseRevision: number,
    version: number,
    initial: NoteContent,
    private readonly persist: (id: string, body: SaveNoteDraft) => Promise<NoteDraft>,
    private readonly requestId: () => string = () => crypto.randomUUID(),
  ) {
    this.version = version;
    this.latest = noteContentOf(initial);
    this.saved = noteSignature(initial);
  }
  update(content: NoteContent) {
    this.latest = noteContentOf(content);
  }
  get dirty() {
    return noteSignature(this.latest) !== this.saved;
  }
  dispose() {
    this.disposed = true;
  }
  flush(force = false): Promise<NoteDraft | null> {
    if (this.disposed) return Promise.reject(new Error('笔记编辑范围已变化'));
    if (this.running) return this.running;
    const work = async () => {
      while (!this.disposed && (this.pending || this.dirty || (force && !this.version))) {
        this.pending ||= {
          ...noteContentOf(this.latest),
          request_id: this.requestId(),
          version: this.version,
          note_id: this.noteId,
          base_revision: this.baseRevision,
        };
        const request = this.pending;
        const response = await this.persist(this.draftId, request);
        if (this.disposed) throw new Error('笔记编辑范围已变化');
        if (
          response.id !== this.draftId ||
          response.note_id !== this.noteId ||
          response.base_revision !== this.baseRevision ||
          response.version <= this.version
        )
          throw new Error('草稿响应已失效，请重新打开笔记');
        this.version = response.version;
        this.saved = noteSignature(request);
        this.pending = null;
        this.last = response;
        force = false;
      }
      return this.last;
    };
    this.running = work().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
