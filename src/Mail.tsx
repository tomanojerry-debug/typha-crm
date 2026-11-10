import { MailReceivingSettings, MailExclusionSettings } from './MailReceivingSettings';
import { MailCustomerForm } from './MailCustomerForm';
import { ProspectSourceButton } from './ProspectSourceButton';
import { GenerateActivitiesDialog } from './BusinessActivities';
import { mailChanged } from './mail-events';
import { MailComposer, OutgoingPanel } from './MailComposer';
import type { ReplyOptions } from '../shared/outgoing';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Mail,
  RefreshCw,
  Reply,
  ReplyAll,
  X,
  Link2,
  Paperclip,
  Search,
} from 'lucide-react';
import { api } from './api';
import { Dialog, Popover } from './WorkspaceUI';
import { WorkspacePageHeader, WorkspacePageTabs } from './WorkspacePage';
import {
  mailCustomerLabels,
  type MailAccount,
  type MailMessage,
  type MailPage,
  type MailCustomerRecognition,
} from '../shared/connections';
import type { Customer, Person, Project } from '../shared/domain';
import type { Selection } from './Workbench';
import './connections.css';
import './mail-reader.css';
const time = (s: string | null) =>
  s ? new Date(s).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '暂无';
function MailSettings({
  workspace,
  onDirty,
  pageActions,
}: {
  workspace: string;
  onDirty: (dirty: boolean) => void;
  pageActions?: ReactNode;
}) {
  const [drafts, setDrafts] = useState<Set<string>>(new Set());
  const trackDirty = useCallback(
    (id: string, dirty: boolean) =>
      setDrafts((current) => {
        if (current.has(id) === dirty) return current;
        const next = new Set(current);
        if (dirty) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  useEffect(() => {
    onDirty(drafts.size > 0);
  }, [drafts, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [refresh, setRefresh] = useState(0),
    [adding, setAdding] = useState(false),
    [notice, setNotice] = useState(''),
    [reconnect, setReconnect] = useState(''),
    [settingsAccount, setSettingsAccount] = useState('');
  useEffect(() => {
    const c = new AbortController();
    api<MailAccount[]>('/mail/accounts', { workspace, signal: c.signal })
      .then(setAccounts)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, [workspace, refresh]);
  async function sync(id: string) {
    setBusy(id);
    setError('');
    setNotice('');
    try {
      await api(`/mail/accounts/${id}/sync`, { workspace, method: 'POST', body: {} });
      setNotice('本批同步完成。历史邮件较多时可继续同步，后台也会每 5 分钟检查。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '同步失败');
    } finally {
      setBusy('');
      setRefresh((x) => x + 1);
      mailChanged();
    }
  }
  return (
    <section className="connection-settings workspace-page">
      <WorkspacePageHeader
        title="邮箱设置"
        description="把邮件往来沉淀到公司与联系人档案。"
        actions={
          <>
            {pageActions}
            <button className="primary" onClick={() => setAdding(!adding)}>
              连接邮箱
            </button>
          </>
        }
      />
      <p className="muted">更换邮箱时，先连接新邮箱，再暂停旧邮箱；已同步的邮件会保留。</p>
      {accounts && accounts.length > 0 && (
        <section className="mail-intake-settings" aria-label="收信设置">
          {accounts.length > 1 && (
            <label className="mail-settings-account">
              设置邮箱
              <select
                value={settingsAccount || accounts[0].id}
                disabled={drafts.size > 0}
                onChange={(e) => setSettingsAccount(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </select>
              {drafts.size > 0 && <small>保存或取消修改后可切换邮箱。</small>}
            </label>
          )}
          {accounts
            .filter((a) => a.id === (settingsAccount || accounts[0].id))
            .map((a) => (
              <MailReceivingSettings
                key={a.id}
                account={a}
                workspace={workspace}
                onDirty={trackDirty}
                onSaved={(settings) =>
                  setAccounts(
                    (current) =>
                      current?.map((item) =>
                        item.id === a.id ? { ...item, ...settings } : item,
                      ) ?? null,
                  )
                }
              />
            ))}
        </section>
      )}
      {adding && (
        <form
          className="connection-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy('new');
            setError('');
            const form = e.currentTarget,
              f = new FormData(form);
            try {
              const account = await api<MailAccount>('/mail/accounts', {
                workspace,
                method: 'POST',
                body: {
                  email: f.get('email'),
                  authorization_code: f.get('authorization_code'),
                  aliases: String(f.get('aliases') || '')
                    .split(/[\s,，]+/)
                    .filter(Boolean),
                },
              });
              form.reset();
              setAdding(false);
              setRefresh((x) => x + 1);
              await sync(account.id);
            } catch (e) {
              setError(e instanceof Error ? e.message : '连接失败');
            } finally {
              setBusy('');
            }
          }}
        >
          <h2>连接邮箱</h2>
          <label>
            邮箱地址
            <input
              name="email"
              type="email"
              required
              placeholder="name@example.com"
              autoComplete="off"
            />
          </label>
          <label>
            IMAP 授权码
            <input
              name="authorization_code"
              type="password"
              required
              minLength={6}
              maxLength={200}
              autoComplete="new-password"
              placeholder="在邮箱设置中开启 IMAP / SMTP 并生成授权码"
            />
          </label>
          <label>
            同一邮箱的其他发件地址（可选）
            <input name="aliases" placeholder="多个地址用逗号分隔" />
            <small>仅填写自己的地址，用于区分自己与外部联系人。</small>
          </label>
          <p className="muted">授权码加密保存，用于同步邮件及执行你确认的发送。</p>
          <div className="connection-actions">
            <button type="button" disabled={!!busy} onClick={() => setAdding(false)}>
              取消
            </button>
            <button className="primary" disabled={!!busy}>
              {busy === 'new' ? '正在连接…' : '连接并同步'}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="connection-notice" role="status">
          {notice}
        </p>
      )}
      {accounts?.map((a) => (
        <article className="mail-account" key={a.id}>
          <div className="mail-account-heading">
            <Mail size={20} />
            <div>
              <strong>{a.email}</strong>
              <small>
                {!a.enabled
                  ? '已暂停'
                  : busy === a.id
                    ? '正在同步…'
                    : a.sync_error
                      ? '需要检查连接'
                      : a.last_sync_at
                        ? '已连接'
                        : '尚未完成首次同步'}
              </small>
            </div>
            <span className="connection-tag">{a.synced_count} 封已保存</span>
          </div>
          <dl>
            <div>
              <dt>最近同步</dt>
              <dd>{time(a.last_sync_at)}</dd>
            </div>
            <div>
              <dt>已发送文件夹</dt>
              <dd>{a.sent_folder || '尚未发现'}</dd>
            </div>
          </dl>
          {a.last_sync_at && !a.sent_folder && (
            <p className="muted">未识别到已发送文件夹，目前只同步收件箱。</p>
          )}
          {a.sync_error && <p className="error">{a.sync_error}</p>}
          <div className="connection-actions">
            <button disabled={!!busy} onClick={() => setReconnect(reconnect === a.id ? '' : a.id)}>
              更新授权码
            </button>
            <button
              disabled={!!busy}
              onClick={async () => {
                setBusy(a.id);
                setError('');
                try {
                  await api(`/mail/accounts/${a.id}`, {
                    workspace,
                    method: 'PATCH',
                    body: { enabled: !a.enabled },
                  });
                  setRefresh((x) => x + 1);
                } catch (e) {
                  setError(e instanceof Error ? e.message : '更新失败');
                } finally {
                  setBusy('');
                }
              }}
            >
              {a.enabled ? '暂停同步' : '恢复同步'}
            </button>
            <button disabled={!!busy || !a.enabled} onClick={() => void sync(a.id)}>
              <RefreshCw size={14} />
              {busy === a.id ? '正在同步…' : '立即同步'}
            </button>
          </div>
          {reconnect === a.id && (
            <form
              className="connection-form compact"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setBusy(a.id);
                setError('');
                try {
                  await api(`/mail/accounts/${a.id}`, {
                    workspace,
                    method: 'PATCH',
                    body: { authorization_code: f.get('code') },
                  });
                  setReconnect('');
                  await sync(a.id);
                } catch (e) {
                  setError(e instanceof Error ? e.message : '更新失败');
                } finally {
                  setBusy('');
                }
              }}
            >
              <label>
                新的 IMAP 授权码
                <input
                  name="code"
                  type="password"
                  required
                  minLength={6}
                  maxLength={100}
                  autoComplete="new-password"
                />
              </label>
              <button disabled={!!busy}>保存并重试</button>
            </form>
          )}
        </article>
      ))}
      {accounts?.length === 0 && !adding && (
        <div className="connection-empty">
          <Mail size={28} />
          <h3>连接第一个邮箱</h3>
          <p>同步后，往来邮件会出现在对应公司与联系人的档案中。</p>
          <button onClick={() => setAdding(true)}>连接邮箱</button>
        </div>
      )}
      <MailExclusionSettings workspace={workspace} onDirty={trackDirty} />
    </section>
  );
}
export function MailCenter({
  workspace,
  admin,
  onSelect,
  onRefresh,
  onDirty,
  refreshVersion = 0,
  askButton,
}: {
  workspace: string;
  admin: boolean;
  onSelect: (s: Selection) => void;
  onRefresh: () => void;
  onDirty: (dirty: boolean) => void;
  refreshVersion?: number;
  askButton?: ReactNode;
}) {
  const [settings, setSettings] = useState(false),
    [dirty, setDirty] = useState(false),
    [leaving, setLeaving] = useState(false);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  return (
    <div className="mail-center">
      {settings && admin ? (
        <MailSettings
          workspace={workspace}
          onDirty={setDirty}
          pageActions={
            <>
              <button onClick={() => (dirty ? setLeaving(true) : setSettings(false))}>
                往来邮件
              </button>
              {askButton}
            </>
          }
        />
      ) : (
        <MailWorkspace
          workspace={workspace}
          admin={admin}
          refreshVersion={refreshVersion}
          onSettings={() => setSettings(true)}
          pageActions={askButton}
          onSelect={onSelect}
          onRefresh={() => {
            mailChanged();
            onRefresh();
          }}
        />
      )}
      {leaving && (
        <Dialog title="收信设置尚未保存" onClose={() => setLeaving(false)}>
          <p className="dialog-copy">切换后会放弃本次修改，已保存的设置继续生效。</p>
          <footer className="form-footer">
            <button onClick={() => setLeaving(false)}>继续编辑</button>
            <button
              onClick={() => {
                setLeaving(false);
                setSettings(false);
              }}
            >
              放弃修改并切换
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
export function MailWorkspace({
  workspace,
  customerId,
  personId,
  projectId,
  refreshVersion = 0,
  admin = false,
  onSelect,
  onSettings,
  onRefresh,
  pageActions,
}: {
  workspace: string;
  customerId?: string;
  personId?: string;
  projectId?: string;
  refreshVersion?: number;
  admin?: boolean;
  onSelect?: (s: Selection) => void;
  onSettings?: () => void;
  onRefresh?: () => void;
  pageActions?: ReactNode;
}) {
  const compact = !projectId;
  const Heading = customerId ? 'h2' : 'h1';
  const [mailScope, setMailScope] = useState<'all' | 'true' | 'false'>(
      customerId ? 'false' : 'all',
    ),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [data, setData] = useState<MailPage | null>(null),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  const pending = mailScope === 'true';
  async function openMail(id: string) {
    setSelected(id);
    try {
      await api(`/mail/messages/${id}/read`, { workspace, method: 'POST', body: {} });
      mailChanged();
    } catch {
      /* A read marker never prevents opening an authorized message. */
    }
  }
  function refreshMail() {
    setRefresh((x) => x + 1);
    onRefresh?.();
    mailChanged();
  }
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError('');
    const q = new URLSearchParams({ pending: mailScope, q: query, page: String(page) });
    if (customerId) q.set('customer_id', customerId);
    if (personId) q.set('person_id', personId);
    if (projectId) q.set('project_id', projectId);
    const t = setTimeout(() => {
      api<MailPage>(`/mail/messages?${q}`, { workspace, signal: c.signal })
        .then(setData)
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    }, 120);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [workspace, customerId, personId, projectId, mailScope, query, page, refresh, refreshVersion]);
  return (
    <section
      className={`mail-workspace ${customerId ? 'record-mail' : 'mail-center-workspace workspace-page'} ${compact ? 'compact-record-mail' : ''}`}
    >
      {!customerId ? (
        <WorkspacePageHeader
          title="邮件管理"
          description="查看往来邮件，核对待录入资料与客户关联。"
          meta={
            data && (
              <span className="workspace-page-count" aria-label={`${data.total} 封邮件`}>
                {data.total}
              </span>
            )
          }
          actions={
            <>
              <Popover
                label={query ? '搜索 · 1' : '搜索'}
                icon={<Search size={13} />}
                className="compact-mail-search"
              >
                <label>
                  主题或往来地址
                  <input
                    aria-label="搜索邮件"
                    placeholder="搜索邮件…"
                    value={query}
                    maxLength={200}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                {query && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setQuery('');
                      setPage(1);
                    }}
                  >
                    清除搜索
                  </button>
                )}
              </Popover>
              <button
                className="icon-button"
                aria-label="刷新邮件"
                title="刷新邮件"
                onClick={refreshMail}
              >
                <RefreshCw size={13} />
              </button>
              {onSettings && admin && <button onClick={onSettings}>邮箱设置</button>}
              {pageActions}
            </>
          }
        />
      ) : compact ? (
        <header className="compact-mail-heading">
          <Heading>
            {!customerId && pending ? '待录入邮件' : '邮件'}
            {data && <span aria-label={`${data.total} 封邮件`}>{data.total}</span>}
          </Heading>
          <div className="compact-mail-actions">
            <Popover
              label={query ? '搜索 · 1' : '搜索'}
              icon={<Search size={13} />}
              className="compact-mail-search"
            >
              <label>
                主题或往来地址
                <input
                  aria-label="搜索邮件"
                  placeholder="搜索邮件…"
                  value={query}
                  maxLength={200}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              {query && (
                <button
                  className="text-button"
                  onClick={() => {
                    setQuery('');
                    setPage(1);
                  }}
                >
                  清除搜索
                </button>
              )}
            </Popover>
            <button
              className="icon-button"
              aria-label="刷新邮件"
              title="刷新邮件"
              onClick={refreshMail}
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </header>
      ) : (
        <header className="connection-heading">
          <div>
            {!customerId && <span className="eyebrow">COMMUNICATIONS</span>}
            <h1>{pending ? '待录入邮件' : '邮件'}</h1>
            <p>
              {pending
                ? '核对客户后，将原始邮件放入对应档案。'
                : '查看与客户的真实往来，保留完整上下文。'}
            </p>
          </div>
          <div className="connection-actions">
            {onSettings && admin && <button onClick={onSettings}>连接 / 管理邮箱</button>}
            <button className="icon-button" aria-label="刷新邮件" onClick={refreshMail}>
              <RefreshCw size={15} />
            </button>
          </div>
        </header>
      )}
      {!customerId && (
        <WorkspacePageTabs label="邮件处理状态" className="mail-tracking-tabs">
          {(
            [
              ['all', '全部'],
              ['true', '待录入'],
              ['false', '已关联'],
            ] as const
          )
            .filter(([value]) => admin || value !== 'true')
            .map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={mailScope === value}
                onClick={() => {
                  setMailScope(value);
                  setPage(1);
                }}
              >
                {label}
              </button>
            ))}
          <span>按最新邮件排序 · 自动更新</span>
        </WorkspacePageTabs>
      )}
      {!compact && customerId && data && (
        <div className="mail-summary">
          <span>
            最近收到 <strong>{time(data.last_inbound)}</strong>
          </span>
          <span>
            最近发出 <strong>{time(data.last_outbound)}</strong>
          </span>
        </div>
      )}
      {!compact && (
        <div className="mail-toolbar">
          <input
            aria-label="搜索邮件"
            placeholder="搜索主题或往来地址…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
          <span>{data ? `${data.total} 封邮件` : '正在加载…'}</span>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {compact && !data && !error && (
        <p className="compact-mail-status" role="status">
          正在加载邮件…
        </p>
      )}
      <div className={compact ? 'compact-mail-list' : 'mail-list'}>
        {data?.items.map((m) =>
          compact ? (
            <button
              className={`compact-mail-row ${m.unread ? 'is-unread' : ''}`}
              key={m.id}
              onClick={() => void openMail(m.id)}
            >
              <span
                className={`compact-mail-avatar ${m.direction}`}
                aria-label={m.direction === 'inbound' ? '收到邮件' : '发出邮件'}
              >
                {m.sender[0]?.name?.slice(0, 1) ||
                  m.sender[0]?.address?.slice(0, 1).toUpperCase() || <Mail size={14} />}
              </span>
              <span className="compact-mail-content">
                <span className="compact-mail-subject">
                  <strong>{m.subject || '无主题'}</strong>
                  {!customerId && m.unread && <span className="mail-new-tag">新邮件</span>}
                  {m.attachments.length > 0 && (
                    <span
                      className="compact-mail-attachments"
                      title={`${m.attachments.length} 个附件`}
                    >
                      <Paperclip size={11} />
                      {m.attachments.length}
                    </span>
                  )}
                  <time dateTime={m.occurred_at} title={time(m.occurred_at)}>
                    {new Date(m.occurred_at).toLocaleDateString('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                    })}
                  </time>
                </span>
                <span className="compact-mail-addresses">
                  {!customerId && (
                    <span className="mail-tracking-labels">
                      <span title={m.customer_recognition?.reason}>
                        {
                          mailCustomerLabels[
                            m.customer_recognition?.kind ?? (m.customer_id ? 'known' : 'new')
                          ]
                        }
                      </span>
                      <span>{m.customer_id ? '已关联' : '待录入'}</span>
                    </span>
                  )}
                  {m.direction === 'outbound' ? '发给 ' : ''}
                  {(m.direction === 'outbound' ? m.recipients : m.sender)
                    .map((x) => (x.name ? `${x.name} · ${x.address}` : x.address))
                    .join(', ')}
                </span>
                <span className="compact-mail-preview">
                  {m.preview || m.body_notice || '无文本正文'}
                </span>
              </span>
            </button>
          ) : (
            <button className="mail-row" key={m.id} onClick={() => void openMail(m.id)}>
              <span className={`mail-direction ${m.direction}`}>
                {m.direction === 'outbound' ? (
                  <ArrowUpRight size={17} />
                ) : (
                  <ArrowDownLeft size={17} />
                )}
              </span>
              <span className="mail-row-body">
                <span>
                  <strong>{m.subject}</strong>
                  <time>{time(m.occurred_at)}</time>
                </span>
                <small>
                  {m.sender.map((x) => x.name || x.address).join(', ')} →{' '}
                  {m.recipients.map((x) => x.name || x.address).join(', ')}
                </small>
                <p>{m.preview || m.body_notice || '无文本正文'}</p>
                <span className="mail-row-context">
                  {m.customer_name && <em>{m.customer_name}</em>}
                  {pending && <em>{m.match_reason}</em>}
                  {m.attachments.length > 0 && (
                    <small>
                      <Paperclip size={12} />
                      {m.attachments.length} 个附件
                    </small>
                  )}
                </span>
              </span>
            </button>
          ),
        )}
      </div>
      {compact && data?.total === 0 ? (
        <div className="compact-mail-empty">
          <Mail size={18} />
          <p>{query ? '没有匹配的邮件' : pending ? '暂无待录入邮件' : '暂无邮件往来'}</p>
          {query && (
            <button
              className="text-button"
              onClick={() => {
                setQuery('');
                setPage(1);
              }}
            >
              清除搜索
            </button>
          )}
        </div>
      ) : (
        data?.total === 0 && (
          <div className="connection-empty">
            <Mail size={27} />
            <h3>{query ? '没有匹配的邮件' : pending ? '暂无待录入邮件' : '暂无邮件往来'}</h3>
            <p>
              {query
                ? '换一个主题或邮箱地址试试。'
                : customerId
                  ? '匹配到此档案的邮件会自动出现在这里。'
                  : admin
                    ? pending
                      ? '新的未知联系人邮件同步后会进入这里。邮箱可在上方“邮箱设置”中管理。'
                      : '尚未确定客户归属的邮件在“待关联”中。邮箱可在上方“邮箱设置”中管理。'
                    : '归入你有权查看的客户后，邮件会出现在这里。'}
            </p>
            {onSettings && admin && !query && <button onClick={onSettings}>管理邮箱连接</button>}
          </div>
        )
      )}
      {data && data.total > 30 && (
        <div className="connection-pagination">
          <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>
            {page} / {Math.ceil(data.total / 30)}
          </span>
          <button disabled={page * 30 >= data.total} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      )}
      {selected && (
        <MailDialog
          id={selected}
          workspace={workspace}
          onClose={() => setSelected(null)}
          onSelect={onSelect}
          onAssigned={refreshMail}
        />
      )}
    </section>
  );
}
export function MailDialog({
  id,
  workspace,
  onClose,
  onSelect,
  onAssigned,
}: {
  id: string;
  workspace: string;
  onClose: () => void;
  onSelect?: (s: Selection) => void;
  onAssigned?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mail, setMail] = useState<MailMessage | null>(null),
    [error, setError] = useState(''),
    [loadingReply, setLoadingReply] = useState(false),
    [reload, setReload] = useState(0),
    [composing, setComposing] = useState<{
      plan: ReplyOptions;
      source: MailMessage;
      draftId?: string;
    } | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityNotice, setActivityNotice] = useState('');
  useEffect(() => {
    const c = new AbortController();
    setError('');
    api<MailMessage>(`/mail/messages/${id}`, { workspace, signal: c.signal })
      .then(setMail)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, [id, workspace, reload]);
  useEffect(() => {
    if (composing || activityOpen) return;
    const el = ref.current!,
      previous = document.activeElement as HTMLElement | null;
    el.showModal();
    return () => {
      el.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [composing, activityOpen]);
  function open(s: Selection) {
    onClose();
    onSelect?.(s);
  }
  function intake() {
    ref.current
      ?.querySelector('.mail-intake')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function startReply(mode: 'reply' | 'all', draftId?: string) {
    if (!mail || loadingReply) return;
    if (!mail.customer_id) {
      intake();
      return;
    }
    setLoadingReply(true);
    setError('');
    try {
      const q = new URLSearchParams({ mode, ...(draftId ? { draft_id: draftId } : {}) });
      const plan = await api<ReplyOptions>(`/mail/messages/${id}/reply-options?${q}`, {
        workspace,
      });
      setComposing({ plan, source: mail, draftId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingReply(false);
    }
  }
  if (activityOpen && mail?.customer_id)
    return (
      <GenerateActivitiesDialog
        workspace={workspace}
        customerId={mail.customer_id}
        projectId={mail.project_id || undefined}
        sourceContext={{
          channel: 'email',
          mailId: mail.id,
          personIds: mail.people.map((p) => p.id),
        }}
        onClose={() => setActivityOpen(false)}
        onGenerated={(result) => {
          setActivityOpen(false);
          setActivityNotice(
            result.activities.length
              ? `已保存 ${result.activities.length} 条活动，可在对应公司／联系人活动页查看。`
              : '未找到适用活动，原邮件保留。',
          );
        }}
      />
    );
  if (composing)
    return (
      <MailComposer
        workspace={workspace}
        person={composing.plan.target}
        kind={composing.plan.kind}
        draftId={composing.draftId}
        reply={composing}
        onClose={onClose}
        onChanged={mailChanged}
      />
    );
  const addresses = (label: string, values: MailMessage['sender']) => (
    <div className="compose-row mail-reader-row" key={label}>
      <dt>{label}</dt>
      <dd>
        {values.length
          ? values.map((a, i) => (
              <span className="recipient-chip" key={`${a.address}:${i}`}>
                <Mail size={12} />
                <span>
                  {a.name && <strong>{a.name} </strong>}
                  {a.address}
                </span>
              </span>
            ))
          : '—'}
      </dd>
    </div>
  );
  return (
    <dialog
      ref={ref}
      className="modal mail-compose-dialog mail-reader-dialog"
      aria-label="邮件详情"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>邮件详情</h2>
        <button className="icon-button" aria-label="关闭邮件" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="compose-body mail-reader-content">
        {!mail && !error && (
          <p className="compose-loading" role="status">
            正在加载邮件…
          </p>
        )}
        {mail && (
          <>
            {activityNotice && (
              <p className="ba-notice" role="status">
                {activityNotice}
              </p>
            )}
            {mail.customer_id && (
              <div className="ba-toolbar">
                <span />
                <button onClick={() => setActivityOpen(true)}>从这封邮件生成活动</button>
              </div>
            )}
            <dl className="mail-reader-fields">
              {addresses('发件人', mail.sender)}
              {addresses('收件人', mail.recipients)}
              {!!mail.cc.length && addresses('抄送', mail.cc)}
              {!!mail.reply_to?.length && addresses('回复至', mail.reply_to)}
              <div className="compose-row mail-reader-row">
                <dt>关联项目</dt>
                <dd>
                  {mail.project_id ? (
                    <button
                      className="mail-reader-project"
                      disabled={!onSelect}
                      onClick={() =>
                        open({
                          customerId: mail.customer_id!,
                          projectId: mail.project_id!,
                          full: true,
                        })
                      }
                    >
                      {mail.project_name || '查看关联项目'}
                      {onSelect && ' →'}
                    </button>
                  ) : mail.customer_id ? (
                    '客户层级 · 不指定项目'
                  ) : (
                    '待关联客户'
                  )}
                </dd>
              </div>
              <div className="compose-row mail-reader-row compose-subject">
                <dt>主题</dt>
                <dd>
                  <h3>{mail.subject || '无主题'}</h3>
                </dd>
              </div>
            </dl>
            <div className="mail-reader-meta">
              <time dateTime={mail.occurred_at}>{time(mail.occurred_at)}</time>
              <span>
                {mail.account_email} · {mail.direction === 'inbound' ? '收到' : '发出'}
              </span>
            </div>
            {mail.customer_id && (
              <div className="mail-entity-links mail-reader-links">
                <button
                  disabled={!onSelect}
                  onClick={() => open({ customerId: mail.customer_id!, full: true })}
                >
                  {mail.customer_name}
                  {onSelect && ' →'}
                </button>
                {mail.people.map((p) => (
                  <button
                    key={p.id}
                    disabled={!onSelect}
                    onClick={() =>
                      open({ customerId: mail.customer_id!, personId: p.id, full: true })
                    }
                  >
                    {p.name}
                    {onSelect && ' →'}
                  </button>
                ))}
              </div>
            )}
            {mail.body_notice && <p className="connection-notice">{mail.body_notice}</p>}
            <div className="mail-body mail-reader-message" aria-label="邮件正文">
              {mail.body || '无文本正文'}
            </div>
            {!!mail.attachments.length && (
              <div className="mail-attachments">
                <h3>
                  附件 <small>请在原邮箱打开文件</small>
                </h3>
                {mail.attachments.map((a, i) => (
                  <span key={i}>
                    <Paperclip size={13} />
                    {a.name} · {Math.ceil(a.size / 1024)} KB
                  </span>
                ))}
              </div>
            )}
            {mail.customer_id && (
              <OutgoingPanel
                workspace={workspace}
                personId={mail.customer_id}
                kind="customers"
                replyToMessageId={mail.id}
                refresh={reload}
                onOpen={(draftId) => void startReply('reply', draftId)}
              />
            )}
            {!mail.customer_id && (
              <MailIntake
                mail={mail}
                workspace={workspace}
                onAssigned={() => {
                  mailChanged();
                  setReload((v) => v + 1);
                  onAssigned?.();
                }}
              />
            )}
          </>
        )}
        {error && (
          <p className="error compose-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="compose-footer mail-reader-footer">
        <span className="compose-save-state">
          {mail
            ? `${mailCustomerLabels[mail.customer_recognition?.kind || (mail.customer_id ? 'known' : 'new')]} · ${mail.customer_id ? '已关联' : '待录入'}`
            : ''}
        </span>
        {mail && (
          <ProspectSourceButton
            workspace={workspace}
            customerId={mail.customer_id}
            sourceKind="email"
            sourceId={mail.id}
            disabled={loadingReply}
          />
        )}
        {mail?.customer_id &&
          (mail.recipients.length > 1 || mail.cc.length > 0 || mail.sender.length > 1) && (
            <button disabled={loadingReply} onClick={() => void startReply('all')}>
              <ReplyAll size={15} />
              回复全部
            </button>
          )}
        <button
          className="primary"
          disabled={!mail || loadingReply}
          onClick={() => void startReply('reply')}
        >
          <Reply size={15} />
          {loadingReply ? '正在准备…' : mail && !mail.customer_id ? '关联客户后回复' : '回复'}
        </button>
      </footer>
    </dialog>
  );
}

function MailIntake({
  mail,
  workspace,
  onAssigned,
}: {
  mail: MailMessage;
  workspace: string;
  onAssigned: () => void;
}) {
  const [mode, setMode] = useState<'new' | 'existing'>(
    mail.customer_recognition?.candidates.length ? 'existing' : 'new',
  );
  return (
    <section className="mail-intake">
      <div className="mail-intake-heading">
        <strong>下一步 · 完善客户档案</strong>
        <p>
          {mail.customer_recognition?.reason ||
            '系统尚未确定这封邮件所属的公司。请先核对邮件，再选择录入或关联。'}
        </p>
      </div>
      <div className="tabs">
        <button className={mode === 'new' ? 'current' : ''} onClick={() => setMode('new')}>
          录入新公司
        </button>
        <button
          className={mode === 'existing' ? 'current' : ''}
          onClick={() => setMode('existing')}
        >
          关联已有公司
        </button>
      </div>
      <div hidden={mode !== 'new'}>
        <MailCustomerForm mail={mail} workspace={workspace} onAssigned={onAssigned} />
      </div>
      <div hidden={mode !== 'existing'}>
        <MailAssignment
          id={mail.id}
          workspace={workspace}
          reason={mail.match_reason}
          candidates={mail.customer_recognition?.candidates}
          onAssigned={onAssigned}
        />
      </div>
    </section>
  );
}
function MailAssignment({
  id,
  workspace,
  reason,
  candidates = [],
  onAssigned,
}: {
  id: string;
  workspace: string;
  reason: string;
  candidates?: MailCustomerRecognition['candidates'];
  onAssigned: () => void;
}) {
  const [query, setQuery] = useState(''),
    [customers, setCustomers] = useState<Customer[]>([]),
    [customerId, setCustomerId] = useState(''),
    [projects, setProjects] = useState<Project[]>([]),
    [people, setPeople] = useState<Person[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController(),
      t = setTimeout(() => {
        api<{ items: Customer[] }>(
          `/customers?q=${encodeURIComponent(query)}&sort=name&direction=asc`,
          { workspace, signal: c.signal },
        )
          .then((x) => setCustomers(x.items))
          .catch((e) => {
            if (e.name !== 'AbortError') setError(e.message);
          });
      }, 150);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [workspace, query]);
  useEffect(() => {
    setProjects([]);
    setPeople([]);
    if (!customerId) return;
    const c = new AbortController();
    Promise.all([
      api<Project[]>(`/customers/${customerId}/projects`, { workspace, signal: c.signal }),
      api<{ items: Person[] }>(`/people?customer_id=${customerId}`, {
        workspace,
        signal: c.signal,
      }),
    ])
      .then(([p, people]) => {
        setProjects(p.filter((p) => !p.archived_at));
        setPeople(people.items);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, [workspace, customerId]);
  return (
    <form
      className="connection-form mail-assignment"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const f = new FormData(e.currentTarget);
        try {
          await api(`/mail/messages/${id}/assign`, {
            workspace,
            method: 'POST',
            body: {
              customer_id: customerId,
              project_id: f.get('project') || null,
              person_ids: f.getAll('person').filter(Boolean),
              reviewed: f.get('reviewed') === 'on',
            },
          });
          onAssigned();
        } catch (e) {
          setError(e instanceof Error ? e.message : '关联失败');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>
        <Link2 size={15} />
        关联到档案
      </h3>
      <p className="muted">{reason}</p>
      {candidates.length > 0 && (
        <div className="mail-customer-candidates" aria-label="可能匹配的已有公司">
          <span>可能匹配的已有公司</span>
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy || c.archived}
              onClick={() => setCustomerId(c.id)}
            >
              {c.name}
              {c.archived ? ' · 已归档' : ' · 选择'}
            </button>
          ))}
        </div>
      )}
      <label>
        搜索公司
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索已有客户…"
        />
      </label>
      <label>
        公司 / 客户
        <select required value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">选择客户</option>
          {[
            ...new Map(
              [
                ...candidates.filter((c) => !c.archived),
                ...customers.filter((c) => !c.archived_at),
              ].map((c) => [c.id, c]),
            ).values(),
          ].map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {customerId && (
        <div key={customerId}>
          <label>
            项目（可选）
            <select name="project">
              <option value="">仅归入客户，暂不指定项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            额外关联联系人（可选）
            <select name="person">
              <option value="">按已知邮箱匹配</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <label className="mail-review">
        <input type="checkbox" name="reviewed" required />
        我已核对所有收发件人及正文，确认整封邮件可由该客户的授权成员查看。
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy || !customerId}>
        确认关联
      </button>
    </form>
  );
}
