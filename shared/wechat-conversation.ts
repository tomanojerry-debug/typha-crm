import { parseWeChatInstruction } from './wechat.js';

export type WeChatConversationInput =
  | { kind: 'person'; identity: string }
  | { kind: 'query'; identity: string; start: string; end: string }
  | { kind: 'cancel' }
  | { kind: 'error'; message: string };

// Local parsing only. A bare identity never authorizes a date range or a read.
export function parseWeChatConversationInput(
  input: string,
  pendingIdentity = '',
  now = new Date(),
): WeChatConversationInput {
  const text = input.trim();
  if (/^(?:取消|算了|不读了|停止读取|不要读取|不要查看)[。！!\s]*$/.test(text))
    return { kind: 'cancel' };
  if (!text || text.length > 300 || /[\r\n\0]/.test(text))
    return { kind: 'error', message: '请输入一个微信号、微信名或备注。' };
  const quoted = text.match(/[“"‘「']([^”"’」']{1,120})[”"’」']/);
  const dateText = quoted ? text.replace(quoted[0], '') : text;
  const hasDates =
    /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|(?:最近|近)\s*\d{1,2}\s*天|前天|昨天|今天/.test(dateText);
  const dates = hasDates
    ? parseWeChatInstruction(`读取微信中与“日期解析”的${dateText}`, now)
    : null;
  if (dates && 'error' in dates) return { kind: 'error', message: dates.error };
  const remainder = dateText
    .replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, ' ')
    .replace(/(?:最近|近)\s*\d{1,2}\s*天|前天|昨天|今天/g, ' ')
    .replace(/^(?:读取|查询|查看|看看|查一下|看一下)\s*/, '')
    .replace(/^微信(?!号|名)(?:中)?\s*(?:和|与)?\s*/, '')
    .replace(/^(?:和|与)\s*/, '')
    .replace(/^(?:微信号|微信名|昵称|备注)\s*[:：]\s*/, '')
    .replace(/的?(?:聊天记录|聊天|对话)(?:吧|[。！!])?$/, '')
    .replace(/^[\s，,:：的至到~～]+|[\s，,。的至到~～]+$/g, '');
  const identity = quoted?.[1]?.trim() || remainder || (dates ? pendingIdentity : '');
  if (!identity || identity.length > 120 || identity.startsWith('-'))
    return { kind: 'error', message: '先告诉我想查看谁的聊天，微信号、微信名或备注都可以。' };
  if (identity.includes('@chatroom'))
    return { kind: 'error', message: '目前支持个人单聊，请输入一位联系人的微信号、微信名或备注。' };
  return dates && !('error' in dates)
    ? { kind: 'query', identity, start: dates.start, end: dates.end }
    : { kind: 'person', identity };
}
