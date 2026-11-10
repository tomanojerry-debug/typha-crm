export interface WeChatRequest {
  identity: string;
  start: string;
  end: string;
  talker?: string;
  request_id: string;
  conversation_id?: string;
}
export interface WeChatContact {
  id: string;
  name: string;
  remark: string;
  wechat_id: string;
}
export interface WeChatMessage {
  id: string;
  at: string;
  speaker: string;
  from_me: boolean;
  text: string;
}
export interface WeChatStatus {
  platform?: 'macos' | 'windows';
  state: 'ready' | 'missing' | 'needs_setup' | 'unsupported' | 'unavailable';
  message: string;
  checks?: {
    id: string;
    label: string;
    value: string;
    state: 'ok' | 'action' | 'unknown';
  }[];
}
export interface WeChatEntity {
  id: string;
  kind: 'person' | 'company' | 'project' | 'point';
  name: string;
  attributes: { label: string; value: string }[];
  evidence: { message_id: string; quote: string; speaker: string; at: string }[];
}
export interface WeChatRelation {
  id: string;
  from: string;
  to: string;
  label: string;
  evidence: string[];
}
export interface WeChatPreview {
  id: string;
  identity: WeChatContact;
  start: string;
  end: string;
  message_count: number;
  entities: WeChatEntity[];
  relations: WeChatRelation[];
  messages: WeChatMessage[];
  warnings: string[];
  method: 'local_extractive';
  state: 'pending' | 'associated';
  selected: string[];
  record_count?: number;
  archive_automatic?: boolean;
  archive_new_records?: number;
  customer_id: string | null;
  person_id: string | null;
  project_id: string | null;
  record_id: string | null;
  created_at: string;
}
export interface WeChatConversation {
  id: string;
  identity: WeChatContact;
  query_count: number;
  latest: {
    id: string;
    start: string;
    end: string;
    message_count: number;
    state: WeChatPreview['state'];
    created_at: string;
  };
}
export type WeChatQueryResult =
  | { preview: WeChatPreview; candidates?: never }
  | { preview?: never; candidates: WeChatContact[]; request: WeChatRequest };
export const wechatEntityNames = {
  person: '联系人',
  company: '公司',
  project: '项目',
  point: '沟通事项',
};
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function wechatRange(start: string, end: string) {
  const lower = Date.parse(`${start}T00:00:00+08:00`),
    upper = Date.parse(`${end}T00:00:00+08:00`) + 86400000;
  if (
    ![start, end].every(
      (s) =>
        datePattern.test(s) &&
        Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
        new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s,
    ) ||
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    upper <= lower ||
    upper - lower > 31 * 86400000
  )
    throw new Error('请指定有效的起止日期，单次最多读取 31 天（北京时间）。');
  return { lower, upper };
}
export function parseWeChatInstruction(
  text: string,
  now = new Date(),
): { identity: string; start: string; end: string } | { error: string } | null {
  if (!/微信|wechat/i.test(text) || !/读取|查询|查看|总结|整理/.test(text)) return null;
  if (
    /(?:不要|不用|无需|别|停止|不再|不需要|暂不|禁止)[^。！!?\n]{0,16}(?:读取|查询|查看|总结|整理)|不(?:读取|查询|查看)/.test(
      text,
    )
  )
    return { error: '本次未读取微信。需要读取时，请明确指定联系人和日期范围。' };
  const identity =
    text.match(/[“"‘「']([^”"’」']{1,120})[”"’」']/)?.[1]?.trim() ||
    text.match(/(?:微信号|微信名|昵称|备注)\s*[:：]\s*([^\s，,。]{1,120})/)?.[1] ||
    text.match(/(?:和|与)\s*([^\s，,。的]{1,80})(?:的|在|从)/)?.[1];
  const dates = [...text.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g)].map(
    (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`,
  );
  let start = dates[0],
    end = dates[1] || dates[0];
  if (!start) {
    const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const shift = (n: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
    const recent = text.match(/(?:最近|近)\s*(\d{1,2})\s*天/);
    if (recent && +recent[1] > 0) {
      end = today;
      start = shift(+recent[1] - 1);
    } else {
      const days = [...text.matchAll(/前天|昨天|今天/g)].map((m) =>
        shift(m[0] === '前天' ? 2 : m[0] === '昨天' ? 1 : 0),
      );
      if (days.length <= 2) {
        start = days[0];
        end = days[1] || days[0];
      }
    }
  }
  const partialRange =
    dates.length === 1 &&
    /(?:至|到|[~～])\s*(?:\d{1,2}月)?\d{1,2}(?:日|号)?/.test(
      text.replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/, ''),
    );
  if (!identity || !start || !end || dates.length > 2 || partialRange)
    return {
      error:
        '请说明微信号、昵称或备注，以及日期范围。例如：读取微信中与“林老师”的 2026-10-20 至 2026-10-22 聊天记录并整理实体、属性和关联。也支持“昨天”或“最近 3 天”。',
    };
  try {
    wechatRange(start, end);
  } catch (e) {
    return { error: (e as Error).message };
  }
  return { identity, start, end };
}
