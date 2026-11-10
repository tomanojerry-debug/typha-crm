import type { CustomAttributeKind, CustomValue } from '../../shared/custom-objects.js';

/** Entirely invented examples. These are not anonymized production conversations. */
export interface SchemaCaseField {
  key: string;
  name: string;
  kind: CustomAttributeKind;
  options?: string[];
  currency?: 'CNY';
  initial: CustomValue;
}
export interface SchemaCaseMessage {
  id: string;
  at: string;
  speaker: string;
  from_me: boolean;
  subject?: string;
  text: string;
}
export interface GraphitiSchemaCase {
  id: 'email' | 'wechat';
  title: string;
  company: string;
  contact: string;
  project: string;
  object: { name: string; singular_name: string; slug: string };
  record: string;
  fields: SchemaCaseField[];
  messages: SchemaCaseMessage[];
  question: string;
  answer_terms: string[];
  excluded_company: string;
  expected: {
    historical: string;
    revised: string;
    correction: string;
    pending: string;
    unconfigured_field: string;
  };
}

export const graphitiSchemaCases: GraphitiSchemaCase[] = [
  {
    id: 'email',
    title: '邮件：采购数量修改与转述纠正',
    company: '星澜舞蹈学校（虚构）',
    contact: '周岚老师（虚构）',
    project: '星澜秋季团服采购（虚构）',
    object: { name: '采购需求', singular_name: '采购需求', slug: 'purchase_requirements' },
    record: '星澜秋季团服采购需求',
    fields: [
      { key: 'style', name: '款式版本', kind: 'text', initial: 'B101 V2' },
      { key: 'quantity', name: '需求数量', kind: 'number', initial: 100 },
      { key: 'budget', name: '单件预算上限', kind: 'currency', currency: 'CNY', initial: 150 },
      { key: 'due', name: '期望交付日期', kind: 'date', initial: '2026-11-15' },
      { key: 'confirmed', name: '客户确认下单', kind: 'checkbox', initial: false },
      { key: 'priority', name: '客户自评优先级', kind: 'rating', initial: 3 },
      {
        key: 'stage',
        name: '需求状态',
        kind: 'select',
        options: ['询价中', '待核对'],
        initial: '询价中',
      },
      {
        key: 'tags',
        name: '需求标签',
        kind: 'multi_select',
        options: ['蓝色', '团体', '加急'],
        initial: ['蓝色', '团体'],
      },
      {
        key: 'reply',
        name: '客户期望回复时间',
        kind: 'timestamp',
        initial: '2026-10-24T02:00:00Z',
      },
    ],
    messages: [
      {
        id: 'fiction-email-100',
        at: '2026-10-20T02:00:00Z',
        speaker: '周岚老师（虚构）',
        from_me: false,
        subject: '星澜秋季团服：先按100件询价',
        text: '您好，我是星澜舞蹈学校的周岚。接着聊星澜秋季团服采购需求：B101 V2蓝色款，我们团体先按100件问价，人数只是预估。每件预算不超过人民币150元，希望2026年11月15日能拿到。这事紧急程度我打3分，满分5分。我们还在询价，没有确定下单，麻烦北京时间10月24日上午10点前回复一下。价格、库存和产能请帮忙查查，知道你们还没有接受订单，也不是已承诺交期。对了，抗起球测试次数有结果了吗？',
      },
      {
        id: 'fiction-email-reported-120',
        at: '2026-10-21T01:00:00Z',
        speaker: '周岚老师（虚构）',
        from_me: false,
        subject: '转述人数：可能调整到120件，请先别下单',
        text: '跟进星澜秋季团服采购需求，我刚听助教说校长想把100件加到120件，不过这是助教转述，我还没和校长核实。先别当成确认数量，不要下单，也不要承诺生产。款式还是B101 V2。',
      },
      {
        id: 'fiction-email-correct-80',
        at: '2026-10-22T02:00:00Z',
        speaker: '周岚老师（虚构）',
        from_me: false,
        subject: '纠正转述：最终询价按80件，仍未下单',
        text: '我本人刚和校长核对了，纠正一下上一封“120件”的转述，那个不准确。星澜秋季团服采购需求现在按80件询价，以这次80件为准，最早的100件是旧预估。我们也想把希望拿到衣服的日子改到2026年11月18日，你们能不能做到还要核对，别当成公司承诺。现在先等双方核对，还没下单；每件预算仍是人民币150元以内。报价、库存、产能都没答复前，我们不会确认订单。',
      },
    ],
    question:
      '请查星澜舞蹈学校（虚构）已保存的邮件和采购需求：最初100件、后来120件转述与现在80件分别是什么性质，最新询价数量和期望日期是多少？现在已下单或公司已承诺了吗？请区分正式采购需求表中仍保留的值与沟通候选，用Record来源说明，并列待核对项。',
    answer_terms: ['100', '120', '80', '待', '11'],
    excluded_company: '澄羽芭蕾社（虚构）',
    expected: {
      historical: '100',
      revised: '80',
      correction: '120',
      pending: '未确认订单、价格库存产能及交期待核对',
      unconfigured_field: '抗起球测试次数',
    },
  },
  {
    id: 'wechat',
    title: '微信：样衣修改建议、误传纠正与不承诺',
    company: '澄羽芭蕾社（虚构）',
    contact: '林悦老师（虚构）',
    project: '澄羽春季样衣评估（虚构）',
    object: { name: '样衣反馈', singular_name: '样衣反馈', slug: 'sample_feedback' },
    record: '澄羽B205样衣反馈',
    fields: [
      { key: 'style', name: '样衣版本', kind: 'text', initial: 'B205 V2' },
      { key: 'length', name: '建议加长厘米', kind: 'number', initial: 0 },
      { key: 'budget', name: '可接受增价上限', kind: 'currency', currency: 'CNY', initial: 0 },
      { key: 'due', name: '期望试样日期', kind: 'date', initial: '2026-11-02' },
      { key: 'approved', name: '公司已批准修改', kind: 'checkbox', initial: false },
      { key: 'rating', name: '客户试穿评分', kind: 'rating', initial: 3 },
      {
        key: 'stage',
        name: '反馈状态',
        kind: 'select',
        options: ['待设计评估', '待客户补充'],
        initial: '待客户补充',
      },
      {
        key: 'tags',
        name: '反馈标签',
        kind: 'multi_select',
        options: ['裙摆', '面料', '尺码'],
        initial: ['裙摆'],
      },
      { key: 'reply', name: '期望反馈时间', kind: 'timestamp', initial: '2026-10-24T07:00:00Z' },
    ],
    messages: [
      {
        id: 'fiction-wx-report',
        at: '2026-10-22T01:00:00Z',
        speaker: '林悦老师（虚构）',
        from_me: false,
        text: '你好，我是澄羽芭蕾社林悦，继续聊“澄羽B205样衣反馈”。助教刚转我一句“林老师已经确认B205 V2裙摆加长4厘米”，我先把这个转述给你，但我还没看样衣。',
      },
      {
        id: 'fiction-wx-ask',
        at: '2026-10-22T01:02:00Z',
        speaker: '我方客服',
        from_me: true,
        text: '收到，先记为待核对的转述。我们没有批准改版，请你试穿后确认具体建议，不能把转述当成已确认修改。',
      },
      {
        id: 'fiction-wx-correction',
        at: '2026-10-22T01:10:00Z',
        speaker: '林悦老师（虚构）',
        from_me: false,
        text: '我本人纠正一下刚才的转述，“已经确认加长4厘米”不对。我试的是B205 V2，裙摆建议加长2厘米，想看看后续V3能不能试样评估，不是说你们已经改好，也没批准量产。澄羽B205样衣反馈说的就是这件V2，主要是裙摆和尺码问题，试穿我给4分，满分5分。',
      },
      {
        id: 'fiction-wx-budget',
        at: '2026-10-22T01:12:00Z',
        speaker: '林悦老师（虚构）',
        from_me: false,
        text: '再补充一下，若加长的话，每件增价人民币8元以内我们能接受。希望2026年11月5日试样，能否在北京时间10月24日15点前给个反馈？知道现在还要等设计评估，你们也还没批准修改，交期和增价都没确定。对了，耐洗测试结果有了吗？我这边还不知道。',
      },
      {
        id: 'fiction-wx-no-promise',
        at: '2026-10-22T01:14:00Z',
        speaker: '我方客服',
        from_me: true,
        text: 'B205 V2试穿反馈和加长2厘米建议已经登记，转给设计评估了。公司还没批准改版，增价、产能以及11月5日能不能试样都未确认。现在不承诺按建议修改，也不会安排生产。',
      },
      {
        id: 'fiction-wx-scope',
        at: '2026-10-22T01:18:00Z',
        speaker: '林悦老师（虚构）',
        from_me: false,
        text: '好的。前面说的4厘米请保留为助教误传历史，以我本人2厘米的建议为准。B205 V3是希望评估的下一版，不能写成已存在的正式版本。我们还没有采购数量或订单，别替我们下单。',
      },
    ],
    question:
      '请查澄羽芭蕾社（虚构）已经保存的微信及样衣反馈，不读取本机微信。林悦老师最初转述4厘米，后来本人纠正后建议多少厘米、针对哪个版本？公司答应改了吗，V3已经存在吗？区分正式反馈表原值和微信候选，说明试样日期、预算和待确认事项并引用Record。',
    answer_terms: ['4', '2', 'V2', '评估'],
    excluded_company: '星澜舞蹈学校（虚构）',
    expected: {
      historical: '4',
      revised: '2',
      correction: '4',
      pending: '修改、增价、产能和试样日期待设计评估；V3只是希望',
      unconfigured_field: '耐洗测试结果',
    },
  },
];
