import type { MailMessage } from './connections.js';

export const intakeFieldNames = {
  company: '公司名称',
  contact: '联系人姓名',
  phone: '电话',
  region: '地区',
  job_title: '职位',
  email: '联系人邮箱',
  type: '客户类型',
  project_name: '项目名称',
  project_type: '项目类型',
  description: '项目需求',
} as const;
type Field = keyof typeof intakeFieldNames;
type Candidate = { value: string; source: string };
export interface MailIntakeSuggestions {
  values: Partial<Record<Field, string>>;
  sources: Partial<Record<Field, string>>;
  conflicts: Field[];
}
const labels: Record<Field, string[]> = {
  company: [
    '公司名称',
    '公司全称',
    '企业名称',
    '单位名称',
    '公司',
    '企业',
    '单位',
    'company name',
    'company',
    'organization',
  ],
  contact: ['联系人姓名', '联系人', '联系姓名', '姓名', 'contact name', 'contact person', 'name'],
  phone: [
    '联系电话',
    '联系手机',
    '手机号码',
    '手机号',
    '手机',
    '电话',
    '座机',
    'phone',
    'telephone',
    'mobile',
    'tel',
  ],
  region: ['所在城市', '所在地区', '所在城市 / 地区', '城市', '地区', 'city', 'region', 'location'],
  job_title: ['职位', '职务', '岗位', 'job title', 'title', 'position'],
  email: ['联系邮箱', '联系人邮箱', '电子邮箱', '邮箱', 'email', 'e-mail'],
  type: ['客户类型', '业务类型', 'customer type'],
  project_name: ['项目名称', '项目', 'project name', 'project'],
  project_type: ['项目类型', 'project type'],
  description: ['项目需求', '需求说明', 'project requirements', 'requirements'],
};
const limits: Record<Field, number> = {
  company: 120,
  contact: 200,
  phone: 60,
  region: 200,
  job_title: 200,
  email: 254,
  type: 40,
  project_name: 120,
  project_type: 40,
  description: 5000,
};
const mappings: Partial<Record<Field, Record<string, string>>> = {
  type: {
    团体定制: 'group',
    经销商: 'distributor',
    个人零售: 'retail',
    group: 'group',
    distributor: 'distributor',
    retail: 'retail',
  },
  project_type: {
    询盘: 'inquiry',
    样衣: 'sample',
    定制: 'custom',
    采购: 'purchase',
    inquiry: 'inquiry',
    sample: 'sample',
    custom: 'custom',
    purchase: 'purchase',
  },
};
// These are draft values only. No domain lookup, instructions, database writes or model calls.
export function extractMailIntake(
  mail: Pick<MailMessage, 'body' | 'sender' | 'recipients' | 'cc' | 'direction' | 'account_email'>,
): MailIntakeSuggestions {
  const candidates: Partial<Record<Field, Candidate[]>> = {};
  const add = (field: Field, value: string, source: string) => {
    value = value
      .trim()
      .replace(/[。；;]$/, '')
      .trim();
    if (
      !value ||
      value.length > limits[field] ||
      /^(?:未提供|未填写|暂无|待确认|待补充|无|不详|N\/A|unknown|本邮件的实际发件地址)$/i.test(
        value,
      )
    )
      return;
    if (mappings[field]) {
      value = mappings[field]![value.toLowerCase()] || '';
      if (!value) return;
    }
    if (field === 'phone' && !/^\+?[\d\s().-]+(?:\s*(?:转|ext\.?|x)\s*\d+)?$/i.test(value)) return;
    if (
      field === 'phone' &&
      (value.replace(/\D/g, '').length < 7 || value.replace(/\D/g, '').length > 20)
    )
      return;
    (candidates[field] ??= []).push({ value, source });
  };
  const lines: string[] = [];
  for (const raw of (mail.body || '').slice(0, 100000).split(/\r?\n/)) {
    const line = raw.trim();
    // Never fill current customer details from an old quoted/forwarded message.
    if (
      /^(?:[-_]{2,}\s*(?:原始邮件|原邮件|original message|forwarded message)|(?:原始邮件|转发邮件)\s*[:：]|On .{0,240}wrote:|在.{0,160}(?:写道|写信)\s*[:：])/i.test(
        line,
      )
    )
      break;
    if (line.startsWith('>')) continue;
    const clean = line.replace(/\*\*|__/g, '').replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/, '');
    lines.push(clean);
    const normalized = clean.replace(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/, '$1：$2');
    for (const part of normalized.split(/[；;]/)) {
      for (const field of Object.keys(labels) as Field[]) {
        const found = part
          .trim()
          .match(new RegExp(`^(?:${labels[field].join('|')})\\s*[:：]\\s*(.+)$`, 'i'));
        if (found) add(field, found[1], clean);
      }
    }
  }
  // Conservative fallbacks for a common self-introduction and explicitly named phone.
  const fallbackCompany = !candidates.company,
    fallbackContact = !candidates.contact;
  for (const line of lines) {
    const introduction = line.match(
      /^我是\s*(.{2,100}?(?:公司|工作室|中心|学校|舞团|学院))\s*的\s*([\p{Script=Han}·]{2,8})(?=[，,。\s]|$)/u,
    );
    if (introduction) {
      if (fallbackCompany) add('company', introduction[1], line);
      if (fallbackContact) add('contact', introduction[2], line);
    }
    const self = line.match(/^(?:我叫|我是)\s*([\p{Script=Han}·]{2,8})(?=[，,。\s]|$)/u);
    if (self && !introduction && fallbackContact) add('contact', self[1], line);
  }
  if (!candidates.phone)
    for (const line of lines) {
      // No arbitrary number scan: quantities, dates and order IDs are not telephone numbers.
      for (const m of line.matchAll(
        /(?:联系电话|手机号|手机|电话|phone|mobile|tel)\s*(?:是|为|[:：])?\s*(\+?[\d(][\d\s().-]{5,24}\d(?:\s*(?:转|ext\.?|x)\s*\d+)?)/gi,
      ))
        add('phone', m[1], line);
    }
  const external = [...mail.sender, ...mail.recipients, ...mail.cc].filter(
    (s) => s.address.toLowerCase() !== mail.account_email.toLowerCase(),
  );
  // An address in the body is usable only when it is an actual external mail participant.
  if (candidates.email)
    candidates.email = candidates.email.filter((c) =>
      external.some((s) => s.address.toLowerCase() === c.value.toLowerCase()),
    );
  const primary = (mail.direction === 'inbound' ? mail.sender : mail.recipients).filter(
    (s) => s.address.toLowerCase() !== mail.account_email.toLowerCase(),
  );
  if (!candidates.email?.length)
    for (const s of primary)
      add('email', s.address, mail.direction === 'inbound' ? '邮件发件人地址' : '邮件收件人地址');
  if (
    !candidates.contact &&
    primary.length === 1 &&
    /^(?:[\p{Script=Han}]{2,6}|[A-Za-z]+(?:[ '-][A-Za-z]+){1,3})$/u.test(primary[0].name.trim())
  )
    add('contact', primary[0].name, '邮件联系人显示名称');
  const result: MailIntakeSuggestions = { values: {}, sources: {}, conflicts: [] };
  for (const field of Object.keys(candidates) as Field[]) {
    const choices = new Map<string, Candidate>();
    for (const c of candidates[field]!)
      choices.set(
        field === 'phone'
          ? c.value.replace(/[\s().-]/g, '')
          : field === 'email'
            ? c.value.toLowerCase()
            : c.value,
        c,
      );
    if (choices.size === 1) {
      const c = [...choices.values()][0];
      result.values[field] = c.value;
      result.sources[field] = c.source;
    } else if (choices.size > 1) result.conflicts.push(field);
  }
  return result;
}
