import { useEffect, useState } from 'react';
import { ChevronDown, ShieldOff } from 'lucide-react';
import { api } from './api';
import { Dialog } from './WorkspaceUI';
import { mailChanged } from './mail-events';
import type {
  ExclusionImpact,
  MailAccount,
  MailExclusions,
  MailProcessingSettings,
} from '../shared/connections';
import './mail-settings.css';

type DirtyNotice = (id: string, dirty: boolean) => void;
const splitEntries = (value: string) => value.split(/[\s,，;；]+/).filter(Boolean);
const stamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '默认设置';
function useDraftNotice(id: string, dirty: boolean, onDirty: DirtyNotice) {
  useEffect(() => {
    onDirty(id, dirty);
  }, [id, dirty, onDirty]);
  useEffect(() => () => onDirty(id, false), [id, onDirty]);
}
function DiscardDialog({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <Dialog title="收信设置尚未保存" onClose={onKeep}>
      <p className="dialog-copy">关闭后会放弃本次修改，已保存的设置继续生效。</p>
      <footer className="form-footer">
        <button onClick={onKeep}>继续编辑</button>
        <button onClick={onDiscard}>放弃修改</button>
      </footer>
    </Dialog>
  );
}
const selectSettings = (a: MailProcessingSettings): MailProcessingSettings => ({
  intake_mode: a.intake_mode,
  notify_unknown: a.notify_unknown,
  notify_known: a.notify_known,
  muted_senders: a.muted_senders,
  settings_version: a.settings_version,
  settings_updated_at: a.settings_updated_at,
});
export function MailReceivingSettings({
  account,
  workspace,
  onDirty,
  onSaved,
}: {
  account: MailAccount;
  workspace: string;
  onDirty: DirtyNotice;
  onSaved: (settings: MailProcessingSettings) => void;
}) {
  const [baseline, setBaseline] = useState(() => selectSettings(account));
  const [draft, setDraft] = useState(baseline),
    [muted, setMuted] = useState(baseline.muted_senders.join('\n'));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(baseline) ||
    muted !== baseline.muted_senders.join('\n');
  useDraftNotice(account.id, dirty, onDirty);
  function reset() {
    setDraft(baseline);
    setMuted(baseline.muted_senders.join('\n'));
    setError('');
    setSaved(false);
  }
  return (
    <section className="mail-receiving-settings">
      <form
        id={`receiving-${account.id}`}
        className="mail-settings-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          setSaved(false);
          try {
            const next = await api<MailProcessingSettings>(
              `/mail/accounts/${account.id}/processing`,
              {
                workspace,
                method: 'PATCH',
                body: {
                  intake_mode: draft.intake_mode,
                  muted_senders: splitEntries(muted),
                  settings_version: baseline.settings_version,
                },
              },
            );
            setBaseline(next);
            setDraft(next);
            setMuted(next.muted_senders.join('\n'));
            setSaved(true);
            onSaved(next);
            mailChanged();
          } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <legend>客户录入</legend>
          <div className="mail-intake-options">
            {(
              [
                [
                  'review',
                  '自动识别，确认后录入',
                  '从邮件提取公司、姓名、电话和需求，核对后保存为档案。',
                ],
                ['manual', '仅手动录入', '保留来信和待关联入口，录入时由你填写资料。'],
              ] as const
            ).map(([value, title, description]) => (
              <label
                className={`mail-intake-option ${draft.intake_mode === value ? 'selected' : ''}`}
                key={value}
              >
                <input
                  type="radio"
                  name={`intake-${account.id}`}
                  value={value}
                  checked={draft.intake_mode === value}
                  onChange={() => {
                    setDraft({ ...draft, intake_mode: value });
                    setSaved(false);
                  }}
                />
                <span>
                  <strong>
                    {title}
                    {value === 'review' && <small>推荐</small>}
                  </strong>
                  <span>{description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mail-settings-hint">
            仅用于此邮箱之后同步的邮件。已有客户按明确邮箱关联，新客户资料由你确认录入。
          </p>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="connection-notice" role="status">
            收信设置已保存，将用于之后同步的邮件。
          </p>
        )}
        {(dirty || saved) && (
          <footer className="mail-settings-footer">
            <small>生效时间：{stamp(baseline.settings_updated_at)}</small>
            <div className="connection-actions">
              <button type="button" disabled={busy || !dirty} onClick={reset}>
                取消修改
              </button>
              <button className="primary" disabled={busy || !dirty}>
                {busy ? '保存中…' : '保存设置'}
              </button>
            </div>
          </footer>
        )}
      </form>
    </section>
  );
}
export function MailExclusionSettings({
  workspace,
  onDirty,
}: {
  workspace: string;
  onDirty: DirtyNotice;
}) {
  const [open, setOpen] = useState(false),
    [discard, setDiscard] = useState(false);
  const [baseline, setBaseline] = useState<MailExclusions | null>(null),
    [entries, setEntries] = useState('');
  const [preview, setPreview] = useState<{
    rules: string[];
    version: number;
    impact: ExclusionImpact[];
  } | null>(null);
  const [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const dirty = !!baseline && entries !== baseline.rules.join('\n');
  useDraftNotice('exclusions', dirty, onDirty);
  async function load() {
    setBusy(true);
    setError('');
    try {
      const next = await api<MailExclusions>('/mail/exclusions', { workspace });
      setBaseline(next);
      setEntries(next.rules.join('\n'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setEntries(baseline?.rules.join('\n') || '');
    setPreview(null);
    setReviewed(false);
    setSaved(false);
    setError('');
  }
  return (
    <section className="mail-exclusion-settings">
      <button
        className="mail-settings-toggle"
        aria-expanded={open}
        aria-controls="mail-workspace-exclusions"
        disabled={busy}
        onClick={() => {
          if (open && dirty) {
            setDiscard(true);
            return;
          }
          setOpen(!open);
          if (!open) void load();
        }}
      >
        <ShieldOff size={16} />
        <strong>工作空间排除名单</strong>
        <span>所有绑定邮箱{dirty ? ' · 未保存' : ''}</span>
        <ChevronDown size={14} className={open ? 'is-open' : ''} />
      </button>
      {open && (
        <div id="mail-workspace-exclusions" className="mail-settings-body">
          <p className="mail-settings-scope">
            命中名单的通信将在整个工作空间隐藏。已有档案保留，邮件不出现在列表、通知及互动统计中。
          </p>
          {!baseline ? (
            <>
              <p>{busy ? '正在加载…' : error}</p>
              {!busy && <button onClick={() => void load()}>重新加载</button>}
            </>
          ) : (
            <>
              <label className="mail-setting-text">
                排除的邮箱地址或域名
                <textarea
                  disabled={busy}
                  rows={4}
                  value={entries}
                  placeholder={'private@example.com\nexample.com'}
                  onChange={(e) => {
                    setEntries(e.target.value);
                    setPreview(null);
                    setReviewed(false);
                    setSaved(false);
                  }}
                />
              </label>
              <p className="mail-settings-hint">
                每行一项。域名包含其子域名；命中任一参与者时隐藏整封邮件。请勿将 163.com
                等公共邮箱域名当作公司域名。
              </p>
              <p className="mail-settings-hint">
                此操作不彻底删除已存邮件；移除规则可恢复已存邮件的显示。曾跳过的历史邮件不会自动补入。
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {saved && (
                <p className="connection-notice" role="status">
                  排除名单已保存，所有绑定邮箱均已应用。
                </p>
              )}
              {preview && (
                <div className="mail-exclusion-preview" role="region" aria-label="排除影响预览">
                  <strong>保存后的影响</strong>
                  <p>
                    隐藏 {preview.impact.reduce((sum, x) => sum + x.to_hide, 0)} 封，恢复显示{' '}
                    {preview.impact.reduce((sum, x) => sum + x.to_restore, 0)} 封已存邮件。
                  </p>
                  <ul>
                    {preview.impact.map((x) => (
                      <li key={x.account_id}>
                        <span>{x.email}</span>
                        <span>
                          隐藏 {x.to_hide} · 恢复 {x.to_restore}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <label className="mail-setting-check">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      disabled={busy}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    <span>已核对影响范围，应用到所有绑定邮箱</span>
                  </label>
                </div>
              )}
              <footer className="mail-settings-footer">
                <small>更新：{stamp(baseline.updated_at)}</small>
                <div className="connection-actions">
                  <button disabled={busy || !dirty} onClick={reset}>
                    取消修改
                  </button>
                  {!preview ? (
                    <button
                      className="primary"
                      disabled={busy || !dirty}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          setPreview(
                            await api('/mail/exclusions/preview', {
                              workspace,
                              method: 'POST',
                              body: { rules: splitEntries(entries), version: baseline.version },
                            }),
                          );
                          setReviewed(false);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : '预览失败');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {busy ? '预览中…' : '预览影响'}
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={busy || !reviewed}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          const next = await api<MailExclusions>('/mail/exclusions', {
                            workspace,
                            method: 'PUT',
                            body: {
                              rules: preview.rules,
                              version: preview.version,
                              reviewed: true,
                            },
                          });
                          setBaseline(next);
                          setEntries(next.rules.join('\n'));
                          setPreview(null);
                          setReviewed(false);
                          setSaved(true);
                          mailChanged();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : '保存失败');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {busy ? '保存中…' : '确认并保存'}
                    </button>
                  )}
                </div>
              </footer>
            </>
          )}
        </div>
      )}
      {discard && (
        <DiscardDialog
          onKeep={() => setDiscard(false)}
          onDiscard={() => {
            reset();
            setDiscard(false);
            setOpen(false);
          }}
        />
      )}
    </section>
  );
}
