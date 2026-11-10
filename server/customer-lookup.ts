import type { Context } from './security.js';
import type { AskSource } from '../shared/ask.js';
import { customerTypes, customerStatuses } from '../shared/domain.js';

const polite = '(?:(?:请|麻烦|帮我|给我|帮忙|再|那|请问|能否|可以)\\s*)*';
const readVerb =
  '(?:查一下|查找|查询|查查|查|搜索|搜一下|搜|找一下|找|检索|看一下|看看|看下|看|了解一下|介绍一下)';
const informationVerb =
  '(?:提供(?:一下)?|展示(?:一下)?|显示(?:一下)?|告诉我|我想了解|我想知道|我想要)';
const information = '(?:的(?:基本)?(?:信息|资料|档案|情况))';
const entity = '(?:(?:这家|这个|这位)?(?:客户|公司|联系人))';
const nameFrames = [
  new RegExp(
    `^${polite}${readVerb}\\s*(?:客户|公司|联系人)?\\s*(.+?)(?:${information}|${entity}(?:${information})?)?$`,
  ),
  new RegExp(
    `^${polite}(?:有没有|是否有|有)\\s*(.+?)(?:${information}|${entity}(?:${information})?)(?:吗|嘛|么|呢)?$`,
  ),
  new RegExp(
    `^${polite}(.+?)(?:${information}|${entity}(?:${information})?)?(?:没有(?:吗|嘛|么)|有没有|有吗|有嘛|有么|呢)$`,
  ),
  // A named information request does not need a search verb: "给我…的信息"
  // and "…的资料" must use the same authorized directory as "查一下…".
  // Require the information suffix so other requests remain ordinary messages.
  new RegExp(`^${polite}(?:${informationVerb}\\s*)?(?:客户|公司|联系人)?\\s*(.+?)${information}$`),
];
function questionText(question: string) {
  return question
    .trim()
    .replace(/[。？！?!]+$/g, '')
    .trim();
}
// Match the whole request, not words inside arbitrary instructions or pasted text.
export function customerLookupQuery(
  question: string,
): { kind: 'email' | 'name'; query: string } | undefined {
  const email = emailLookupQuery(question);
  if (email) return { kind: 'email', query: email };
  const text = questionText(question);
  if (text.length > 200 || /[\n\r@]|邮箱|邮件地址|微信/.test(text)) return;
  const match = nameFrames.map((frame) => frame.exec(text)).find(Boolean);
  const query = match?.[1]
    .trim()
    .replace(/^[“「‘"']|[”」’"']$/g, '')
    .trim();
  if (
    !query ||
    query.length < 2 ||
    query.length > 80 ||
    /[，,；;。？！?：:]/.test(query) ||
    /^(?:全部|所有)/.test(query) ||
    /^(?:当前|这个|这家|这位|那个|目前|现在|我们|你们)(?:的)?(?:客户|公司|联系人)$/.test(query) ||
    /^(客户|公司|联系人|信息|资料|情况|档案|一下|这个|这家|那个|目前|现在|当前|系统|你|我|我们|你们|交期|需求|项目|报价|价格|记录|邮件|反馈|面料|尺码|样衣|库存|合同|时间|合作|结果|来源)$/.test(
      query,
    ) ||
    /(?:分析|总结|概括|生成|写封|发邮件|发送|回复|修改|删除|更新|导入|怎么|如何|为什么|什么|是否)/.test(
      query,
    )
  )
    return;
  return { kind: 'name', query: query.toLowerCase() };
}

// Explicit email fragments can be asked about conversationally without saying
// "customer". The surrounding frame still has to be a directory lookup.
export function emailLookupQuery(question: string): string | undefined {
  const text = questionText(question);
  if (text.length > 400 || /[\n\r]/.test(text)) return;
  const addresses = text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi);
  if (addresses && addresses.length !== 1) return;
  if (!addresses && !/(?:邮箱|邮件地址)/.test(text)) return;
  const tokens = addresses || text.match(/[a-z0-9][a-z0-9._+-]{2,253}/gi);
  if (tokens?.length !== 1 || tokens[0].length > 254) return;
  const token = tokens[0];
  const frame = text.replace(token, '§').replace(/[\s“”「」‘’"']/g, '');
  const mailbox = '(?:邮箱(?:地址|前缀)?|邮件地址)';
  const emailFrame = new RegExp(
    `^${polite}(?:${readVerb}|${informationVerb}|有没有|是否有|有)?(?:${mailbox}|(?:客户|公司|联系人)(?:的${mailbox})?)?§(?:这(?:个|家|位))?(?:${mailbox})?(?:对应的?|关联的?)?(?:的?(?:客户|公司|联系人))?(?:的?(?:基本)?(?:信息|资料|档案|情况))?(?:没有(?:吗|嘛|么)|有没有|有吗|有嘛|有么|呢|吗|嘛|么)?$`,
  );
  if (!emailFrame.test(frame)) return;
  return token.toLowerCase();
}

export async function customerLookup(
  ctx: Context,
  query: string,
  customer: string | null,
  kind: 'email' | 'name' = 'email',
) {
  let exact = kind === 'email' && query.includes('@');
  const match = (column: string) =>
    exact ? `lower(trim(${column}))=$2` : `position($2 in lower(${column}))>0`;
  const companyColumn = kind === 'email' ? 'c.email' : 'c.name';
  const personColumn = kind === 'email' ? 'p.email' : 'p.name';
  const result = await ctx.tx.query<{
    id: string;
    name: string;
    total: number;
    type: keyof typeof customerTypes;
    status: keyof typeof customerStatuses;
    region: string;
    contact_name: string;
    email: string;
  }>(
    `SELECT c.id,c.name,c.type,c.status,c.region,c.contact_name,c.email,count(*) OVER()::int AS total FROM customers c
     WHERE c.workspace_id=$1 AND c.archived_at IS NULL
       AND ($3::uuid IS NULL OR c.id=$3)
       AND (${match(companyColumn)} OR EXISTS (
         SELECT 1 FROM people p WHERE p.workspace_id=c.workspace_id AND p.customer_id=c.id
           AND p.archived_at IS NULL AND ${match(personColumn)}
       )) ORDER BY c.name,c.id LIMIT 10`,
    [ctx.workspaceId, query, customer],
  );
  const total = result.rows[0]?.total || 0;
  if (kind === 'name' && total === 1) exact = result.rows[0].name.trim().toLowerCase() === query;
  const label =
    kind === 'name'
      ? exact
        ? '名称精确匹配'
        : '名称片段匹配'
      : exact
        ? '邮箱精确匹配'
        : '邮箱片段匹配';
  const basicInfo =
    total === 1
      ? `\n\n名称：${result.rows[0].name}\n类型：${customerTypes[result.rows[0].type]}\n合作状态：${customerStatuses[result.rows[0].status]}\n地区：${result.rows[0].region || '未填写'}\n主要联系人：${result.rows[0].contact_name || '未填写'}\n公司邮箱：${result.rows[0].email || '未填写'}`
      : '';
  const sources: AskSource[] = result.rows.map((c) => ({
    kind: 'entity',
    object: 'customers',
    id: c.id,
    customer_id: c.id,
    title: c.name,
    description: `${label} · ${query}`,
  }));
  return {
    body:
      kind === 'name'
        ? total
          ? `按名称「${query}」在${customer ? '当前客户' : '当前可访问客户目录'}中找到 ${total} 家匹配公司。${total > 10 ? '下方显示前 10 家，请补全名称缩小范围。' : ''}${total === 1 ? basicInfo : '\n\n存在多个匹配，请根据卡片选择具体客户。'}\n\n以上来自现有基础档案。可打开档案，或点击“就此客户提问”继续了解该客户。`
          : `在${customer ? '当前客户' : '当前可访问客户目录'}的公司及未归档联系人名称中，没有找到与「${query}」匹配的结果。请核对或补全名称。`
        : total
          ? `按${exact ? '完整邮箱' : '邮箱片段'}「${query}」在${customer ? '当前客户' : '当前可访问客户目录'}中找到 ${total} 家匹配公司。${total > 10 ? '下方显示前 10 家，请补全邮箱缩小范围。' : ''}${basicInfo}\n\n点击卡片可打开档案；继续分析时请选择具体客户。\n\n匹配范围为公司邮箱及未归档联系人的邮箱，本次没有调用模型或读取邮件正文。`
          : `在${customer ? '当前客户' : '当前可访问客户目录'}的公司及未归档联系人邮箱中，没有找到与「${query}」${exact ? '完全一致' : '匹配'}的结果。请核对或补全邮箱；未关联来信不在此目录检索范围内。`,
    sources,
    lookup: { query, total, exact, kind },
  };
}
