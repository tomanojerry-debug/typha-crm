export const emailStrengthLabels = {
  0: '无往来',
  1: '很弱',
  2: '较弱',
  3: '一般',
  4: '较强',
  5: '很强',
} as const;
export type EmailStrength = keyof typeof emailStrengthLabels;
export const emailStrengthRules = {
  recentDays: 30,
  weakDays: 90,
  veryWeakDays: 180,
  strongCount: 3,
  veryStrongCount: 10,
} as const;
export const emailStrengthHelp =
  '仅依据已归属的邮件：无邮件为无往来；超过 180 天为很弱，91–180 天为较弱，31–90 天为一般。近 30 天有收有发且累计至少 3 封为较强，至少 10 封为很强，其余为一般。相同邮件副本去重，随时间重新计算。';
export const communicationColumns = {
  email_strength: '关系强度（邮件）',
  last_email_at: '最近邮件互动',
  first_email_at: '首次邮件互动',
  last_inbound_at: '最近收到邮件',
  last_outbound_at: '最近发出邮件',
  email_count: '往来邮件数',
};
export interface EmailMetrics {
  first_email_at: string | null;
  last_email_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  email_count: number;
  email_count_30d: number;
  email_strength: EmailStrength;
}
