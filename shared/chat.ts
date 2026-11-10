import type { WeChatPreview, WeChatQueryResult } from './wechat.js';
import type { RecordObject } from './views.js';
import type { AskScope, AskSource } from './ask.js';
import type { ChatClassification, ChatRetrieval } from './chat-intent.js';
import type { AgentRun } from './agent-runs.js';

export interface ChatOrigin {
  kind: 'ask';
  label: string;
  scope: AskScope;
}
export interface Chat {
  id: string;
  title: string;
  customer_id: string | null;
  customer_name: string | null;
  updated_at: string;
  origin?: ChatOrigin | null;
  run_status?: AgentRun['status'] | null;
}
export interface ChatPage {
  items: Chat[];
  next_cursor: string | null;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  action?: 'message' | 'overview' | 'activity' | 'web_research' | null;
  body: string;
  material: { name: string; content: string } | null;
  created_at: string;
  model?: string | null;
  classification?: ChatClassification | null;
  retrieval?: ChatRetrieval | null;
  sources?: AskSource[];
  lookup?: {
    query: string;
    total: number;
    exact: boolean;
    kind?: 'email' | 'name';
    refreshed?: boolean;
  };
}
export interface ImportPlan {
  id: string;
  object: RecordObject;
  list_name: string | null;
  columns: string[];
  rows: { values: Record<string, unknown>; error: string | null }[];
  result: { count: number; list_id: string | null } | null;
  created_at: string;
}
export interface ChatDetail {
  run?: AgentRun | null;
  chat: Chat;
  messages: ChatMessage[];
  imports: ImportPlan[];
  wechat_previews?: WeChatPreview[];
  wechat_request?: Extract<WeChatQueryResult, { candidates: unknown }>;
}
export const importFields: Record<RecordObject, Record<string, string>> = {
  customers: {
    name: '公司名称',
    region: '地区',
    contact_name: '主要联系人',
    email: '邮箱',
    phone: '电话',
  },
  people: {
    name: '联系人姓名',
    job_title: '职位',
    email: '邮箱',
    phone: '电话',
    description: '备注',
  },
  projects: { name: '项目名称', description: '项目说明', due_date: '截止日期' },
};

// Deliberately limited to explicit, structured text. No heuristic document extraction.
export function parseTable(input: string): { headers: string[]; rows: string[][] } {
  const raw = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (new TextEncoder().encode(raw).length > 40000) throw new Error('表格最多 40 KB');
  const delimiter = raw.split('\n')[0].includes('\t') ? '\t' : ',';
  const data: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  for (let i = 0; i <= raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === undefined) throw new Error('引号未闭合，请检查表格');
      if (c === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === delimiter || c === '\n' || c === undefined) {
      row.push(cell.trim());
      cell = '';
      closed = false;
      if (c !== delimiter) {
        if (row.some(Boolean)) data.push(row);
        row = [];
      }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error('引号格式不正确，请使用标准 CSV 或制表符表格');
      cell += c;
    }
  }
  const [headers, ...rows] = data;
  if (!headers?.length || !rows.length) throw new Error('请提供一行表头和至少一行数据');
  if (headers.length > 20 || rows.length > 100) throw new Error('一次最多导入 100 行、20 列');
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length)
    throw new Error('表头不能为空或重复');
  if (rows.some((r) => r.length !== headers.length)) throw new Error('各行列数必须与表头一致');
  return { headers, rows };
}
