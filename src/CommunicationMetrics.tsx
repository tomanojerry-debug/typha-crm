import {
  emailStrengthLabels,
  emailStrengthHelp,
  type EmailMetrics,
} from '../shared/communications';

export function EmailStrength({ value }: { value: EmailMetrics['email_strength'] | undefined }) {
  if (value === undefined) return <span className="missing">—</span>;
  return (
    <span className={`email-strength strength-${value}`} title={emailStrengthHelp}>
      <i aria-hidden="true" />
      {emailStrengthLabels[value]}
    </span>
  );
}
export function EmailTime({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="missing">无往来</span>;
  const date = new Date(value);
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  const exact = date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return (
    <time dateTime={value} title={`${exact}（北京时间）`}>
      {days === 0
        ? '24 小时内'
        : days < 30
          ? `${days} 天前`
          : days < 365
            ? `${Math.floor(days / 30)} 个月前`
            : `${Math.floor(days / 365)} 年前`}
    </time>
  );
}
export function CommunicationMetrics({
  record,
  onOpen,
}: {
  record: Partial<EmailMetrics>;
  onOpen: () => void;
}) {
  return (
    <section className="communication-metrics" aria-label="邮件互动属性">
      <div className="communication-metrics-heading">
        <h3>邮件互动</h3>
        <span>自动更新</span>
      </div>
      <dl className="contact-summary">
        <div>
          <dt>关系强度</dt>
          <dd>
            <EmailStrength value={record.email_strength} />
          </dd>
        </div>
        <div>
          <dt>最近互动</dt>
          <dd>
            <EmailTime value={record.last_email_at} />
          </dd>
        </div>
        <div>
          <dt>最近收到</dt>
          <dd>
            <EmailTime value={record.last_inbound_at} />
          </dd>
        </div>
        <div>
          <dt>最近发出</dt>
          <dd>
            <EmailTime value={record.last_outbound_at} />
          </dd>
        </div>
        <div>
          <dt>首次互动</dt>
          <dd>
            <EmailTime value={record.first_email_at} />
          </dd>
        </div>
        <div>
          <dt>往来邮件</dt>
          <dd>
            <button className="text-button" onClick={onOpen}>
              {record.email_count ?? 0} 封 · 查看
            </button>
          </dd>
        </div>
      </dl>
      <details className="communication-rules">
        <summary>强度如何计算</summary>
        <p>{emailStrengthHelp}</p>
        <p>统计已发生的邮件；待关联邮件不计入。日历互动尚未接入。</p>
      </details>
    </section>
  );
}
