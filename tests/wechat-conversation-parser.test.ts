import { expect, it } from 'vitest';
import { parseWeChatConversationInput as parse } from '../shared/wechat-conversation.js';
const now = new Date('2026-10-22T17:00:00Z');
it('asks for dates after a bare identity and preserves aliases and remarks', () => {
  expect(parse('采购林老师', '', now)).toEqual({ kind: 'person', identity: '采购林老师' });
  expect(parse('微信号：lin-001', '', now)).toEqual({ kind: 'person', identity: 'lin-001' });
  expect(parse('查看与“林老师”的聊天记录', '', now)).toEqual({
    kind: 'person',
    identity: '林老师',
  });
  expect(parse('“今天舞蹈工作室”', '', now)).toEqual({
    kind: 'person',
    identity: '今天舞蹈工作室',
  });
});
it('uses dates only when stated by the user and resolves relative dates in Beijing', () => {
  expect(parse('昨天', '采购林老师', now)).toEqual({
    kind: 'query',
    identity: '采购林老师',
    start: '2026-10-22',
    end: '2026-10-22',
  });
  expect(parse('林老师 最近7天', '', now)).toEqual({
    kind: 'query',
    identity: '林老师',
    start: '2026-10-17',
    end: '2026-10-23',
  });
  expect(parse('查看与“林老师”的2026-10-20至2026-10-22聊天记录', '', now)).toEqual({
    kind: 'query',
    identity: '林老师',
    start: '2026-10-20',
    end: '2026-10-22',
  });
  expect(parse('今天', '', now).kind).toBe('error');
  expect(parse('2026-10-20至22日', '林老师', now).kind).toBe('error');
  expect(parse('最近32天', '林老师', now).kind).toBe('error');
  expect(parse('2026-02-30', '林老师', now).kind).toBe('error');
});
it('cancels without reading and rejects multi-line or group requests', () => {
  expect(parse('取消', '林老师', now)).toEqual({ kind: 'cancel' });
  expect(parse('不要读取', '林老师', now)).toEqual({ kind: 'cancel' });
  expect(parse('林老师\n另一个人', '', now).kind).toBe('error');
  expect(parse('group@chatroom', '', now).kind).toBe('error');
});
