import {
  mailVariableText,
  type MailInlineNode,
  type MailVariableDocument,
  type MailVariableNode,
} from './mail-variables.js';

export interface MailTemplate {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  subject: string;
  body: string;
  /** Unbound references only; templates never persist customer field values. */
  variable_document?: MailVariableDocument;
}

// Only these explicit legacy starter slots can be upgraded. Business placeholders
// such as style, order number and sample version remain manual, not guessed fields.
const starterSlots: Record<string, Omit<MailVariableNode, 'type' | 'id'>> = {
  客户称呼: {
    root: 'recipient',
    field: 'people:name',
    label: '收件人 › 姓名',
    fallback: '',
  },
  'Customer name': {
    root: 'recipient',
    field: 'people:name',
    label: '收件人 › 姓名',
    fallback: 'there',
  },
  'Contact name': {
    root: 'recipient',
    field: 'people:name',
    label: '收件人 › 姓名',
    fallback: 'there',
  },
  团队或项目名称: {
    root: 'recipient_company',
    field: 'customers:name',
    label: '收件人 › 所属公司 › 公司名称',
    fallback: '贵团队',
  },
  'Team or project name': {
    root: 'recipient_company',
    field: 'customers:name',
    label: '收件人 › 所属公司 › 公司名称',
    fallback: 'your team',
  },
  'Company name': {
    root: 'recipient_company',
    field: 'customers:name',
    label: '收件人 › 所属公司 › 公司名称',
    fallback: 'your company',
  },
  发件人署名: {
    root: 'sender',
    field: 'mail_accounts:email',
    label: '发件账号 › 发件邮箱',
  },
  'Sender name': {
    root: 'sender',
    field: 'mail_accounts:email',
    label: '发件账号 › 发件邮箱',
  },
  'Sender name and company': {
    root: 'sender',
    field: 'mail_accounts:email',
    label: '发件账号 › 发件邮箱',
  },
};

/** Upgrade known starter placeholders only; preserve existing variable documents. */
export function addStarterTemplateVariables<
  T extends { subject: string; body: string; variable_document?: MailVariableDocument },
>(template: T): T {
  if (template.variable_document) return template;
  let count = 0;
  const nodes = (part: 'subject' | 'body'): MailInlineNode[] => {
    const text = template[part];
    const result: MailInlineNode[] = [];
    let cursor = 0;
    for (const match of text.matchAll(/【待填写：([^】]+)】/gu)) {
      const slot = Object.hasOwn(starterSlots, match[1]) ? starterSlots[match[1]] : undefined;
      if (!slot) continue;
      if (match.index > cursor)
        result.push({ type: 'text', text: text.slice(cursor, match.index) });
      result.push({ type: 'variable', id: `starter-${part}-${++count}`, ...slot });
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) result.push({ type: 'text', text: text.slice(cursor) });
    return result;
  };
  const document: MailVariableDocument = {
    version: 1,
    subject: nodes('subject'),
    body: nodes('body'),
  };
  if (!count) return template;
  return {
    ...template,
    subject: mailVariableText(document.subject),
    body: mailVariableText(document.body),
    variable_document: document,
  };
}

// General starting copy only: references are unbound and contain no customer
// values or approved commercial terms. Preview resolves the selected recipient.
const starterCopy: MailTemplate[] = [
  {
    id: 'product-size-inquiry',
    name: '商品与尺码咨询',
    description: '回复款式、颜色和尺码问题，补齐量体信息。',
    keywords: [
      '商品',
      '款式',
      '尺码',
      '尺寸',
      '量体',
      '练功服',
      '芭蕾',
      'product',
      'size',
      'sizing',
      'fit',
    ],
    subject: '关于【待填写：款式名称】的商品与尺码咨询',
    body: `【待填写：客户称呼】您好，

感谢您咨询【待填写：款式名称或商品链接】。为了更准确地核对您的需要，请补充：

1. 希望的颜色、尺码及数量；
2. 穿着用途，以及偏贴身或宽松的喜好；
3. 如需协助选码，请提供身高、胸围、腰围、臀围，以及从肩部经裆部绕回肩部的围长，注明厘米或英寸。

尺码建议需结合该款尺码表和实际试穿情况核对。价格、库存及可发货时间仍待核实。

谢谢！
【待填写：发件人署名】`,
  },
  {
    id: 'group-custom-requirements',
    name: '团体定制需求收集',
    description: '向舞校或团队收集款式、人数、尺寸和使用日期。',
    keywords: [
      '团体',
      '定制',
      '舞校',
      '团队',
      '校服',
      '数量',
      '尺码',
      'group',
      'custom',
      'teamwear',
      'uniform',
    ],
    subject: '请补充【待填写：团队或项目名称】的团体定制需求',
    body: `【待填写：客户称呼】您好，

感谢您咨询团体舞服。为便于核对需求，请提供：

1. 团队名称、使用场景及期望使用日期；
2. 参考款式或设计说明、希望的颜色和面料；
3. 预计总数量、尺码分布或量体数据；
4. 是否有标志、印字或其他细节要求；
5. 收货国家或地区，以及预算范围（如已确定）。

如以上信息尚未确定，也可以先说明已知部分。是否可定制、样衣安排、报价和交期都需结合具体需求另行核实确认。

谢谢！
【待填写：发件人署名】`,
  },
  {
    id: 'sample-feedback-receipt',
    name: '样衣反馈确认',
    description: '核对样衣款式、版本与具体意见，供后续评估。',
    keywords: ['样衣', '反馈', '试穿', '版本', '修改', 'sample', 'feedback', 'fitting', 'revision'],
    subject: '核对【待填写：款式及版本】的样衣反馈',
    body: `【待填写：客户称呼】您好，

感谢您提供样衣试穿反馈。为避免遗漏或混淆，想与您核对以下内容：

款式及版本：【待填写：款式编号或名称、样衣版本】
您的反馈：【待填写：客户原话或经核对的意见摘要】

如方便，请补充对应尺码、问题位置、实际尺寸，以及您期望的效果；有图片或标注说明也可以随信提供。

本邮件仅核对反馈。是否调整、调整方案及时间，仍需评估并另行确认。

谢谢！
【待填写：发件人署名】`,
  },
  {
    id: 'order-shipping-inquiry',
    name: '订单与物流查询',
    description: '补齐订单标识和查询问题，核对物流信息。',
    keywords: [
      '订单',
      '物流',
      '快递',
      '运单',
      '发货',
      '到货',
      'order',
      'shipping',
      'tracking',
      'delivery',
    ],
    subject: '关于【待填写：订单编号】的订单或物流查询',
    body: `【待填写：客户称呼】您好，

感谢您联系我们。为准确定位您要查询的订单，请提供订单编号、下单邮箱，以及需要核对的具体问题。

如您已收到物流通知，也请提供承运商、运单号或查询链接；如订单分批发出，请注明对应的商品或包裹。

当前订单及物流状态仍待核实。发货或到达时间需以核实后的订单信息和承运商更新为准。

谢谢！
【待填写：发件人署名】`,
  },
  {
    id: 'product-size-inquiry-en',
    name: '商品与尺码咨询（英文）',
    description: 'Product and sizing inquiry · 对应中文商品与尺码咨询。',
    keywords: [
      '商品',
      '款式',
      '尺码',
      '尺寸',
      '量体',
      '英文',
      '英语',
      'product',
      'size',
      'sizing',
      'fit',
      'english',
    ],
    subject: 'Product and sizing inquiry — 【待填写：Style name】',
    body: `Hi 【待填写：Customer name】,

Thank you for your interest in 【待填写：Style name or product link】. To help us check your needs, could you share:

1. Your preferred colour, size and quantity;
2. How the garment will be used and whether you prefer a closer or more relaxed fit;
3. If you would like sizing guidance, your height, bust, waist, hips and torso girth (from one shoulder through the crotch and back to the same shoulder), with measurements in centimetres or inches.

Any size suggestion will need to be checked against the size chart for this specific style and the actual fit. Pricing, stock and dispatch timing still need to be verified.

Thank you,
【待填写：Sender name】`,
  },
  {
    id: 'group-custom-requirements-en',
    name: '团体定制需求收集（英文）',
    description: 'Group dancewear inquiry · 对应中文团体定制需求收集。',
    keywords: [
      '团体',
      '定制',
      '舞校',
      '团队',
      '校服',
      '数量',
      '尺码',
      '英文',
      '英语',
      'group',
      'custom',
      'teamwear',
      'uniform',
      'english',
    ],
    subject: 'Group dancewear requirements — 【待填写：Team or project name】',
    body: `Hi 【待填写：Customer name】,

Thank you for your group dancewear inquiry. To help us understand your requirements, please share:

1. Your team or school name, intended use and preferred date of use;
2. Reference styles or design notes, preferred colours and fabrics;
3. Estimated total quantity and the size breakdown or measurements;
4. Any logo, lettering or other detail requests;
5. The destination country or region and your budget range, if already decided.

If some details are still open, please send what you know so far. Customisation feasibility, samples, pricing and lead times will need to be reviewed and confirmed separately.

Thank you,
【待填写：Sender name】`,
  },
  {
    id: 'overseas-wholesale-inquiry',
    name: '海外经销合作（英文）',
    description: '回复海外批发或经销意向，收集公司与目标市场信息。',
    keywords: [
      '海外',
      '经销',
      '合作',
      '批发',
      '外贸',
      '英文',
      'B2B',
      'wholesale',
      'distributor',
      'reseller',
      'stockist',
    ],
    subject: 'Dancewear partnership inquiry — 【待填写：Company name】',
    body: `Hi 【待填写：Contact name】,

Thank you for your interest in a potential dancewear partnership.

Could you share your company name, country or region, website or store details, and the markets you serve? Please also let us know the products you are interested in, estimated quantities, size ranges, and your preferred delivery period.

If you have specific questions or requirements, please include them so we can understand your needs.

Pricing, minimum quantities, availability, payment terms, shipping, and any reseller arrangement remain subject to separate review and written confirmation.

Best regards,
【待填写：Sender name and company】`,
  },
];

export const mailTemplates: MailTemplate[] = starterCopy.map(addStarterTemplateVariables);

function normalize(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function fieldScore(token: string, field: string, weight: number) {
  if (field === token) return weight + 20;
  if (field.startsWith(token)) return weight + 10;
  return field.includes(token) ? weight : 0;
}

// English abbreviations may omit letters within one keyword (trk → tracking).
// Keep the first letter and require at least three letters to avoid noisy hits.
function abbreviationScore(token: string, keyword: string) {
  if (!/^[a-z][a-z0-9]{2,}$/.test(token)) return 0;
  const words = keyword.split(' ');
  for (const word of words) {
    if (word[0] !== token[0] || word.length > token.length * 3) continue;
    let position = 0;
    for (const letter of word) {
      if (letter === token[position]) position += 1;
      if (position === token.length) return 20 + token.length / word.length;
    }
  }
  return 0;
}

/** Search only the supplied visible catalogue; no business-record retrieval. */
export function searchMailTemplates(
  query: string,
  catalog: readonly MailTemplate[] = mailTemplates,
): MailTemplate[] {
  const tokens = [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
  if (!tokens.length) return [...catalog];
  return catalog
    .map((template, index) => {
      const name = normalize(template.name),
        keywords = template.keywords.map(normalize),
        description = normalize(template.description),
        subject = normalize(template.subject),
        body = normalize(template.body);
      const scores = tokens.map((token) =>
        Math.max(
          fieldScore(token, name, 100),
          ...keywords.map((keyword) => fieldScore(token, keyword, 80)),
          fieldScore(token, description, 50),
          fieldScore(token, subject, 40),
          fieldScore(token, body, 10),
          ...keywords.map((keyword) => abbreviationScore(token, keyword)),
        ),
      );
      return {
        template,
        index,
        score: scores.every((score) => score > 0) ? scores.reduce((a, b) => a + b, 0) : 0,
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ template }) => template);
}
