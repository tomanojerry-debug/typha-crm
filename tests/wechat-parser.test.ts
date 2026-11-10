import { expect, it } from 'vitest';
import { parseWeChatInstruction, wechatRange } from '../shared/wechat.js';
import { normalizeWeChatContacts, normalizeWeChatMessages } from '../server/wechat-transport.js';
it('requires a person and explicit date range, including relative Beijing days', () => {
  expect(parseWeChatInstruction('读取微信中与“林老师”的2026-10-20至2026-10-22聊天记录')).toEqual({
    identity: '林老师',
    start: '2026-10-20',
    end: '2026-10-22',
  });
  expect(
    parseWeChatInstruction(
      '总结微信中与“lin123”的最近3天聊天记录',
      new Date('2026-10-22T17:00:00Z'),
    ),
  ).toEqual({ identity: 'lin123', start: '2026-10-21', end: '2026-10-23' });
  expect(parseWeChatInstruction('读取微信的记录')).toHaveProperty('error');
  expect(parseWeChatInstruction("读取微信中与'林老师'的2026-10-20聊天记录")).toEqual({
    identity: '林老师',
    start: '2026-10-20',
    end: '2026-10-20',
  });
  expect(parseWeChatInstruction('读取微信中与“林老师”的2026-10-20至22日聊天记录')).toHaveProperty(
    'error',
  );
  expect(parseWeChatInstruction('查看客户档案')).toBeNull();
  expect(parseWeChatInstruction('不要读取微信中与“林老师”的2026-10-20聊天记录')).toHaveProperty(
    'error',
  );
  expect(
    parseWeChatInstruction(
      '总结微信中与“林老师”昨天到今天的聊天记录',
      new Date('2026-10-22T10:00:00Z'),
    ),
  ).toEqual({ identity: '林老师', start: '2026-10-21', end: '2026-10-22' });
  expect(() => wechatRange('2026-02-30', '2026-03-01')).toThrow();
  expect(() => wechatRange('2026-13-01', '2026-13-01')).toThrow();
  expect(() => wechatRange('2026-10-22', '2026-10-20')).toThrow();
});
it('normalizes local CLI JSON and keeps stable identities and message timestamps', () => {
  expect(
    normalizeWeChatContacts({
      data: {
        contacts: [
          { wxid: 'wxid_one', nickname: '林老师', remark: '采购林老师', alias: 'lin001' },
          { wxid: 'group@chatroom', nickname: '群' },
        ],
      },
    }),
  ).toEqual([{ id: 'wxid_one', name: '林老师', remark: '采购林老师', wechat_id: 'lin001' }]);
  expect(
    normalizeWeChatMessages({
      messages: [
        {
          local_id: 1,
          timestamp: 1792425600,
          sender: '林老师',
          text: '需要四件样衣',
          is_sender: 0,
        },
      ],
    }),
  ).toMatchObject([{ id: '1', text: '需要四件样衣', from_me: false }]);
  expect(
    normalizeWeChatMessages({ messages: [{ local_id: 2, text: '缺失时间，不得编造当前日期' }] }),
  ).toEqual([]);
  expect(
    normalizeWeChatMessages({
      messages: [{ local_id: 3, time: '2026-10-20 10:00:00', content: '样衣反馈' }],
    }),
  ).toMatchObject([{ at: '2026-10-20T02:00:00.000Z' }]);
});
it('rejects upstream formatted history and reported query failures instead of saving an empty preview', () => {
  expect(() =>
    normalizeWeChatMessages({
      messages: ['[2026-10-22 14:00] 林老师: 需要样衣'],
    }),
  ).toThrow('稳定消息 ID');
  expect(() =>
    normalizeWeChatMessages({ messages: [], failures: ['database unavailable'] }),
  ).toThrow('部分读取失败');
  expect(() =>
    normalizeWeChatMessages({ data: { messages: [], failures: ['unavailable'] } }),
  ).toThrow('部分读取失败');
  expect(normalizeWeChatMessages({ messages: [], failures: null })).toEqual([]);
});

it('does not silently truncate long source text before automatic archiving', () => {
  const text = '长文字'.repeat(2100) + '原文结尾';
  expect(
    normalizeWeChatMessages({
      messages: [{ local_id: 'long', time: '2026-10-20 10:00:00', text }],
    })[0].text,
  ).toBe(text);
});
