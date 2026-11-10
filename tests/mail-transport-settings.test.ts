import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ sourceUids: [] as number[], closed: false }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidValidity: 1 };
    on() {}
    async connect() {}
    async list() {
      return [];
    }
    async getMailboxLock() {
      return { release() {} };
    }
    async search() {
      return [1, 2];
    }
    async fetchOne(uid: number, query: { source?: boolean }) {
      if (query.source) {
        state.sourceUids.push(uid);
        return {
          source: Buffer.from(
            'From: safe@example.com\r\nTo: fixture@163.com\r\nSubject: Allowed\r\n\r\nSynthetic body',
          ),
        };
      }
      return {
        uid,
        size: 100,
        internalDate: new Date('2026-01-01'),
        envelope: {
          from: [{ address: uid === 1 ? 'private@example.com' : 'safe@example.com' }],
          to: [{ address: 'fixture@163.com' }],
        },
      };
    }
    close() {
      state.closed = true;
    }
  },
}));
import { imapTransport } from '../server/mail-transport.js';
it('checks envelope participants before downloading the body and commits skipped cursors', async () => {
  const saved: { uid: number; skipped: boolean }[] = [];
  await imapTransport.run(
    { email: 'fixture@163.com', password: 'synthetic', cursors: {} },
    async (_folder, cursor, message) => {
      saved.push({ uid: cursor.uid, skipped: message === null });
    },
    async () => {},
    async (participants) => !participants.includes('private@example.com'),
  );
  expect(state.sourceUids).toEqual([2]);
  expect(saved).toEqual([
    { uid: 1, skipped: true },
    { uid: 2, skipped: false },
  ]);
  expect(state.closed).toBe(true);
});
