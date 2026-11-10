import { extractMailIntake } from '../shared/mail-intake.js';
import type { MailCustomerRecognition, MailMessage } from '../shared/connections.js';
import type { Context } from './security.js';

type Message = Pick<
  MailMessage,
  | 'customer_id'
  | 'customer_name'
  | 'body'
  | 'sender'
  | 'recipients'
  | 'cc'
  | 'direction'
  | 'account_email'
>;
const normalizeName = (value = '') => value.toLowerCase().replace(/\s/g, '');
const normalizePhone = (value = '') => value.replace(/\D/g, '');

// Suggestions never assign a customer or broaden access. RLS applies to all evidence queries.
export async function recognizeMailCustomers(
  ctx: Context,
  messages: Message[],
): Promise<MailCustomerRecognition[]> {
  if (messages.every((m) => m.customer_id)) return messages.map(known);
  const accounts = (
    await ctx.tx.query<{ email: string; aliases: string[] }>(
      'SELECT email,aliases FROM mail_accounts WHERE workspace_id=$1',
      [ctx.workspaceId],
    )
  ).rows;
  const internal = new Set(
    accounts.flatMap((a) => [a.email, ...a.aliases]).map((a) => a.toLowerCase()),
  );
  const evidence = messages.map((m) => {
    const extracted = extractMailIntake(m);
    return {
      addresses: [...m.sender, ...m.recipients, ...m.cc]
        .map((a) => a.address.toLowerCase())
        .filter((a) => !internal.has(a)),
      company: normalizeName(extracted.values.company),
      phone: normalizePhone(extracted.values.phone),
      conflict: extracted.conflicts.some((field) =>
        ['company', 'contact', 'phone'].includes(field),
      ),
    };
  });
  const rows = (
    await ctx.tx.query<{
      id: string;
      name: string;
      archived: boolean;
      email: string;
      company: string;
      phone: string;
    }>(
      `WITH identities AS (
    SELECT c.id,c.name,c.archived_at IS NOT NULL AS archived,lower(trim(c.email)) AS email,
      lower(regexp_replace(c.name,'[[:space:]]','','g')) AS company,regexp_replace(c.phone,'[^0-9]','','g') AS phone
    FROM customers c WHERE c.workspace_id=$1
    UNION ALL
    SELECT c.id,c.name,(c.archived_at IS NOT NULL),lower(trim(p.email)),
      lower(regexp_replace(c.name,'[[:space:]]','','g')),regexp_replace(p.phone,'[^0-9]','','g')
    FROM people p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id WHERE p.workspace_id=$1
  ) SELECT * FROM identities WHERE email=ANY($2::text[]) OR company=ANY($3::text[]) OR phone=ANY($4::text[])`,
      [
        ctx.workspaceId,
        [...new Set(evidence.flatMap((e) => e.addresses))],
        [...new Set(evidence.map((e) => e.company).filter(Boolean))],
        [...new Set(evidence.map((e) => e.phone).filter((p) => p.length >= 7))],
      ],
    )
  ).rows;
  return messages.map((m, index) => {
    if (m.customer_id) return known(m);
    const e = evidence[index];
    const matches = rows.filter(
      (r) =>
        e.addresses.includes(r.email) ||
        (e.company && e.company === r.company) ||
        (e.phone.length >= 7 && e.phone === r.phone),
    );
    const candidates = [
      ...new Map(
        matches.map((r) => [r.id, { id: r.id, name: r.name, archived: r.archived }]),
      ).values(),
    ];
    const signals = [
      matches.some((r) => e.addresses.includes(r.email)) && '邮件地址',
      matches.some((r) => e.company && e.company === r.company) && '正文公司名称',
      matches.some((r) => e.phone.length >= 7 && e.phone === r.phone) && '正文电话',
    ]
      .filter(Boolean)
      .join('、');
    if (e.conflict || candidates.length > 1)
      return {
        kind: 'ambiguous',
        candidates: candidates.slice(0, 5),
        reason: e.conflict
          ? '邮件中的客户资料有冲突，请核对后关联。'
          : `${signals}匹配到多个客户，请核对后关联。`,
      };
    if (candidates.length)
      return {
        kind: 'possible',
        candidates,
        reason: `${signals}匹配到已有档案${matches.some((r) => r.archived) ? '（含已归档资料）' : ''}，请核对后关联。`,
      };
    return {
      kind: 'new',
      candidates: [],
      reason: '未匹配到已有客户，请核对资料后录入或查找已有公司。',
    };
  });
}
function known(m: Message): MailCustomerRecognition {
  return { kind: 'known', candidates: [], reason: `已归入 ${m.customer_name || '客户档案'}` };
}
