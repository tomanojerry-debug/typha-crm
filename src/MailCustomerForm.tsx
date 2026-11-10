import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { api } from './api';
import { extractMailIntake, intakeFieldNames } from '../shared/mail-intake';
import { customerTypes, projectTypes } from '../shared/domain';
import type { MailMessage } from '../shared/connections';

export function MailCustomerForm({
  mail,
  workspace,
  onAssigned,
}: {
  mail: MailMessage;
  workspace: string;
  onAssigned: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [withProject, setWithProject] = useState(false);
  const [suggestions] = useState(() =>
    mail.intake_mode === 'manual'
      ? ({ values: {}, sources: {}, conflicts: [] } as ReturnType<typeof extractMailIntake>)
      : (mail.intake_suggestions ?? extractMailIntake(mail)),
  );
  const prefill = suggestions.values;
  const detected = Object.keys(prefill).filter((k) => k !== 'email').length;
  return (
    <form
      className="connection-form mail-assignment"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError('');
        try {
          await api(`/mail/messages/${mail.id}/create-customer`, {
            workspace,
            method: 'POST',
            body: {
              job_title: f.get('job_title'),
              customer: {
                name: f.get('company'),
                type: f.get('type'),
                region: f.get('region'),
                contact_name: f.get('contact'),
                email: f.get('email'),
                phone: f.get('phone'),
              },
              project: withProject
                ? {
                    name: f.get('project_name'),
                    type: f.get('project_type'),
                    description: f.get('description'),
                  }
                : null,
              reviewed: f.get('reviewed') === 'on',
            },
          });
          onAssigned();
        } catch (e) {
          setError(e instanceof Error ? e.message : '录入失败');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>
        <Building2 size={15} />
        录入新公司
      </h3>
      <p className="muted">
        {mail.intake_mode === 'manual'
          ? '这封邮件按手动录入设置接收，请核对原文填写。'
          : detected
            ? `已从邮件识别 ${detected} 项信息，请核对或修改后保存。`
            : '尚未识别到明确的公司资料，请核对邮件后补充。'}
        保存后，邮件会同时出现在公司和联系人的活动、邮件中。
      </p>
      {suggestions.conflicts.length > 0 && (
        <p className="mail-extraction-note">
          {suggestions.conflicts.map((k) => intakeFieldNames[k]).join('、')}
          出现多个不同值，已留空，请核对后填写。
        </p>
      )}
      {detected > 0 && (
        <details className="mail-extraction-sources">
          <summary>查看识别来源</summary>
          <dl>
            {Object.entries(suggestions.sources)
              .filter(([k]) => k !== 'email')
              .map(([k, source]) => (
                <div key={k}>
                  <dt>{intakeFieldNames[k as keyof typeof intakeFieldNames]}</dt>
                  <dd>{source}</dd>
                </div>
              ))}
          </dl>
        </details>
      )}
      <fieldset disabled={busy} className="mail-intake-fields">
        <legend>1 · 公司信息</legend>
        <label>
          公司名称
          <input
            name="company"
            required
            maxLength={120}
            placeholder="填写邮件中的公司名称"
            defaultValue={prefill.company}
          />
        </label>
        <div className="mail-form-grid">
          <label>
            客户类型
            <select name="type" required defaultValue={prefill.type || ''}>
              <option value="">请选择客户类型</option>
              {Object.entries(customerTypes).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            所在城市 / 地区
            <input
              name="region"
              maxLength={200}
              placeholder="例如：杭州"
              defaultValue={prefill.region}
            />
          </label>
        </div>
      </fieldset>
      <fieldset disabled={busy} className="mail-intake-fields">
        <legend>2 · 联系人</legend>
        <div className="mail-form-grid">
          <label>
            联系人姓名
            <input
              name="contact"
              required
              maxLength={200}
              placeholder="核对邮件署名后填写"
              defaultValue={prefill.contact}
            />
          </label>
          <label>
            联系电话（可选）
            <input
              name="phone"
              type="tel"
              maxLength={60}
              defaultValue={prefill.phone}
              placeholder="邮件未提供时可留空"
            />
          </label>
        </div>
        <label>
          职位（可选）
          <input name="job_title" maxLength={200} defaultValue={prefill.job_title} />
        </label>
        <label>
          联系人邮箱
          <input name="email" type="email" required maxLength={254} defaultValue={prefill.email} />
        </label>
        <small>
          {mail.intake_mode === 'manual'
            ? '请填写这封邮件中的外部联系人邮箱。'
            : '邮箱来自邮件地址，请核对它属于这位联系人。'}
        </small>
      </fieldset>
      <fieldset disabled={busy} className="mail-intake-fields">
        <legend>3 · 相关项目（可选）</legend>
        <label className="mail-review">
          <input
            type="checkbox"
            checked={withProject}
            onChange={(e) => setWithProject(e.target.checked)}
          />
          同时新建项目并关联这封邮件
        </label>
        {prefill.project_name && !withProject && (
          <p className="mail-detected-project">
            识别到项目：{prefill.project_name}。勾选后可核对并创建。
          </p>
        )}
        {withProject && (
          <>
            <label>
              项目名称
              <input
                name="project_name"
                required
                maxLength={120}
                defaultValue={prefill.project_name}
              />
            </label>
            <label>
              项目类型
              <select name="project_type" defaultValue={prefill.project_type || 'inquiry'}>
                {Object.entries(projectTypes).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              需求说明（可选）
              <textarea
                name="description"
                maxLength={5000}
                rows={3}
                defaultValue={prefill.description}
              />
            </label>
          </>
        )}
        <small>暂不指定项目时，邮件只归入公司和联系人，之后可在公司中继续管理项目。</small>
      </fieldset>
      <label className="mail-review">
        <input type="checkbox" name="reviewed" required disabled={busy} />
        我已核对公司、联系人和邮件内容，确认整封邮件可由该客户的授权成员查看。
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? '正在保存…' : '保存档案并关联邮件'}
      </button>
    </form>
  );
}
