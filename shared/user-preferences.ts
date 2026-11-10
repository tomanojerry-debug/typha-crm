export type UserPreferenceKey =
  | 'response_length'
  | 'response_format'
  | 'response_language'
  | 'contact_columns'
  | 'contact_format'
  | 'email_tone'
  | 'email_tone_en'
  | 'email_tone_zh';

/** The complete whitelist shared by settings and server-side normalization. */
export const userPreferenceOptions: Record<
  UserPreferenceKey,
  { label: string; options: { value: string; label: string }[] }
> = {
  response_length: {
    label: '回答长短',
    options: [
      { value: 'concise', label: '回答简短直接。' },
      { value: 'detailed', label: '回答详细一些，解释必要的依据。' },
    ],
  },
  response_format: {
    label: '回答格式',
    options: [
      { value: 'table', label: '查询结果优先用表格展示。' },
      { value: 'list', label: '回答优先用列表展示。' },
      { value: 'paragraph', label: '回答优先用自然段展示。' },
    ],
  },
  response_language: {
    label: '回答语言',
    options: [
      { value: 'zh', label: '默认使用中文回答。' },
      { value: 'en', label: '默认使用英文回答。' },
    ],
  },
  contact_columns: {
    label: '联系人展示字段',
    options: [
      { value: 'name_company_email', label: '查询联系人时，用姓名、公司、邮箱三列表格展示。' },
    ],
  },
  contact_format: {
    label: '联系人展示格式',
    options: [{ value: 'table', label: '仅联系人查询结果优先用表格展示。' }],
  },
  email_tone: {
    label: '邮件文风',
    options: [
      { value: 'concise_direct', label: '邮件草稿使用简短直接的文风。' },
      { value: 'formal', label: '邮件草稿使用正式文风。' },
      { value: 'warm', label: '邮件草稿使用亲切文风。' },
    ],
  },
  email_tone_en: {
    label: '英文邮件文风',
    options: [
      { value: 'concise_direct', label: '仅英文邮件草稿使用简短直接的文风。' },
      { value: 'formal', label: '仅英文邮件草稿使用正式文风。' },
      { value: 'warm', label: '仅英文邮件草稿使用亲切文风。' },
    ],
  },
  email_tone_zh: {
    label: '中文邮件文风',
    options: [
      { value: 'concise_direct', label: '仅中文邮件草稿使用简短直接的文风。' },
      { value: 'formal', label: '仅中文邮件草稿使用正式文风。' },
      { value: 'warm', label: '仅中文邮件草稿使用亲切文风。' },
    ],
  },
};

/** Personal presentation preferences only; these are never business evidence. */
export interface UserPreference {
  id: string;
  category: UserPreferenceKey;
  value: string;
  content: string;
  source_chat_id: string;
  source_message_id: string;
  created_at: string;
  updated_at: string;
}

export interface UserPreferenceSetting extends UserPreference {
  /** Opaque database precision version; do not derive this from the displayed timestamp. */
  version: string;
  source_chat: { id: string; title: string } | null;
}

export interface PreferenceChange {
  status: 'saved' | 'removed' | 'unchanged' | 'previously_applied' | 'clarify' | 'none';
  instruction: string;
  preference?: UserPreference;
  removed?: number;
}
