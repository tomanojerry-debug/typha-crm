import { expect, it } from 'vitest';
import type { NoteContent, NoteDraft, SaveNoteDraft } from '../shared/notes.js';
import {
  editNoteBlock,
  NoteDraftWriter,
  noteCanPublish,
  safeNoteHref,
} from '../src/note-editor-state.js';

const initial: NoteContent = {
  title: '合成客户跟进',
  customer_id: 'company-a',
  project_id: null,
  person_ids: [],
  blocks: [{ id: 'block-a', type: 'paragraph', text: '原记录', origin: 'original', sources: [] }],
};
const response = (id: string, input: SaveNoteDraft): NoteDraft => ({
  ...input,
  id,
  version: input.version + 1,
  created_at: '',
  updated_at: '',
});
const changed = (text: string): NoteContent => ({
  ...initial,
  blocks: [{ ...initial.blocks[0], text }],
});

it('serializes changes made during a slow autosave without overwriting newer input', async () => {
  let release!: () => void;
  const calls: SaveNoteDraft[] = [];
  const writer = new NoteDraftWriter('draft-a', null, 0, 0, initial, async (id, input) => {
    calls.push(input);
    if (calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
    return response(id, input);
  });
  writer.update(changed('第一版输入'));
  const task = writer.flush();
  writer.update(changed('保存期间继续输入'));
  expect(writer.flush()).toBe(task);
  release();
  await task;
  expect(calls.map((c) => [c.version, c.blocks[0].text])).toEqual([
    [0, '第一版输入'],
    [1, '保存期间继续输入'],
  ]);
  expect(writer.version).toBe(2);
  expect(writer.dirty).toBe(false);
});

it('replays a lost response with the identical request before saving different new content', async () => {
  const calls: SaveNoteDraft[] = [];
  let fail = true;
  const writer = new NoteDraftWriter('draft-a', null, 0, 0, initial, async (id, input) => {
    calls.push(input);
    if (fail) {
      fail = false;
      throw new Error('network');
    }
    return response(id, input);
  });
  writer.update(changed('已可能保存但响应丢失'));
  await expect(writer.flush()).rejects.toThrow('network');
  writer.update(changed('继续输入的新内容'));
  await writer.flush();
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2].request_id).not.toBe(calls[0].request_id);
  expect(calls[2].version).toBe(1);
  expect(calls[2].blocks[0].text).toBe('继续输入的新内容');
});

it('does not accept a late autosave after the workspace or editor identity is cleared', async () => {
  let release!: () => void;
  const writer = new NoteDraftWriter('draft-a', null, 0, 0, initial, async (id, input) => {
    await new Promise<void>((resolve) => (release = resolve));
    return response(id, input);
  });
  writer.update(changed('旧范围输入'));
  const task = writer.flush();
  writer.dispose();
  release();
  await expect(task).rejects.toThrow('范围已变化');
  expect(writer.version).toBe(0);
});

it('keeps provenance when a user edits a derived block', () => {
  const source = { record_id: 'original-record', source_hash: 'v1', quote: '实际原话' };
  const edited = editNoteBlock(
    { ...initial.blocks[0], origin: 'derived', sources: [source] },
    '人工改过的摘要',
  );
  expect(edited.origin).toBe('derived');
  expect(edited.sources).toEqual([source]);
  expect(edited.sources[0]).not.toBe(source);
});

it('turns an edited quotation into a derived statement while retaining the source', () => {
  const source = { record_id: 'original-record', source_hash: 'v1', quote: '客户实际原话' };
  const quoted = {
    ...initial.blocks[0],
    origin: 'quote' as const,
    text: source.quote,
    sources: [source],
  };
  expect(editNoteBlock(quoted, '改写后的含义').origin).toBe('derived');
  expect(editNoteBlock(quoted, '改写后的含义').sources).toEqual([source]);
  expect(editNoteBlock(quoted, source.quote).origin).toBe('quote');
});

it('requires a customer, title and nonblank body before publication', () => {
  expect(noteCanPublish(initial)).toBe(true);
  expect(noteCanPublish({ ...initial, customer_id: null })).toBe(false);
  expect(noteCanPublish({ ...initial, title: ' ' })).toBe(false);
  expect(noteCanPublish({ ...initial, blocks: [] })).toBe(false);
  expect(noteCanPublish(changed('  '))).toBe(false);
});

it('only renders explicit safe link protocols', () => {
  expect(safeNoteHref('https://example.com/path')).toBe('https://example.com/path');
  expect(safeNoteHref('mailto:person@example.com')).toBe('mailto:person@example.com');
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,test',
    '//example.com',
    '/api/private',
  ])
    expect(safeNoteHref(value)).toBeNull();
});
