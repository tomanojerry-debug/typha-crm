import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, ShieldCheck } from 'lucide-react';
import type { Customer, Member, SessionInfo } from '../shared/domain';
import { api, isDemoRuntime } from './api';
import { MailboxSenderPermissions } from './MailboxSenderPermissions';
import './team-permission-settings.css';

type CustomerAccess = 'viewer' | 'editor';
type Grant = { actor_id: string; access: CustomerAccess };
type CustomerChoice = Pick<Customer, 'id' | 'name' | 'region' | 'contact_name'>;
type CustomerPage = { items: CustomerChoice[]; total: number; page_size: number };

const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
const accessLabels = { viewer: '只读', editor: '可编辑' } as const;

function memberMode(member: Member) {
  if (member.role === 'admin') return '管理员';
  return member.workspace_mode === 'tasks' ? '协作待办' : '客户工作台';
}

export function TeamPermissionSettings({
  workspace,
  authMode,
  onChanged,
}: {
  workspace: string;
  authMode?: SessionInfo['auth_mode'];
  onChanged?: () => void;
}) {
  const readOnly = isDemoRuntime();
  const [panel, setPanel] = useState<'members' | 'access' | 'senders'>('members');
  const [members, setMembers] = useState<Member[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirmMember, setConfirmMember] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    api<Member[]>('/members', { workspace, signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setMembers(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(errorText(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspace, revision]);

  function switchPanel(next: typeof panel) {
    setPanel(next);
    setConfirmMember(null);
    setError('');
    setNotice('');
  }

  function memberChanged(message: string) {
    setNotice(message);
    setRevision((current) => current + 1);
    onChanged?.();
  }

  async function createMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const input = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api<Member>('/members', {
        workspace,
        method: 'POST',
        body: {
          display_name: String(input.get('display_name')).trim(),
          email: String(input.get('email')).trim(),
          password: input.get('password'),
          workspace_mode: input.get('workspace_mode'),
        },
      });
      setCreating(false);
      memberChanged('成员已创建。');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleMember(member: Member) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/members/${member.actor_id}`, {
        workspace,
        method: 'PATCH',
        body: { active: !member.active },
      });
      setConfirmMember(null);
      memberChanged(member.active ? '成员已停用。' : '成员已启用。');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="personal-settings-content team-settings"
      aria-labelledby="team-settings-title"
    >
      <div className="personal-settings-heading">
        <div className="memory-settings-icon">
          <ShieldCheck size={19} aria-hidden="true" />
        </div>
        <h3 id="team-settings-title">成员与权限</h3>
      </div>
      {readOnly ? (
        <p className="personal-settings-description">在线体验使用固定的成员与授权。</p>
      ) : authMode === 'local' ? (
        <p className="personal-settings-description">
          当前使用本机直达。启用邮箱密码登录后，团队成员可以用各自账号进入工作空间。
        </p>
      ) : null}
      <nav className="ba-tabs team-settings-tabs" aria-label="成员与权限分类">
        <button
          type="button"
          aria-current={panel === 'members' ? 'page' : undefined}
          disabled={busy}
          onClick={() => switchPanel('members')}
        >
          成员账号
        </button>
        <button
          type="button"
          aria-current={panel === 'access' ? 'page' : undefined}
          disabled={busy}
          onClick={() => switchPanel('access')}
        >
          客户授权
        </button>
        <button
          type="button"
          aria-current={panel === 'senders' ? 'page' : undefined}
          disabled={busy}
          onClick={() => switchPanel('senders')}
        >
          邮箱发信授权
        </button>
      </nav>
      {notice && (
        <p className="ba-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="ba-empty" role="status">
          正在读取成员…
        </p>
      ) : loadError ? (
        <div className="ba-alert" role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            重新读取成员
          </button>
        </div>
      ) : panel === 'access' ? (
        <CustomerPermissions
          workspace={workspace}
          members={members}
          onChanged={onChanged}
          readOnly={readOnly}
        />
      ) : panel === 'senders' ? (
        <MailboxSenderPermissions workspace={workspace} members={members} readOnly={readOnly} />
      ) : (
        <>
          <div className="team-settings-heading">
            <h4>工作空间成员</h4>
            {!readOnly && !creating && (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => setCreating(true)}
              >
                <Plus size={14} aria-hidden="true" /> 新增成员
              </button>
            )}
          </div>
          {creating && (
            <form
              className="team-settings-form"
              aria-label="新增成员"
              onSubmit={(event) => void createMember(event)}
            >
              <fieldset disabled={busy}>
                <div className="team-settings-grid">
                  <label className="field">
                    <span>成员姓名</span>
                    <input name="display_name" required maxLength={120} autoFocus />
                  </label>
                  <label className="field">
                    <span>登录邮箱</span>
                    <input name="email" type="email" autoComplete="off" required maxLength={254} />
                  </label>
                  <label className="field">
                    <span>初始密码</span>
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                      placeholder="至少 12 位"
                    />
                  </label>
                  <label className="field">
                    <span>登录后的工作台</span>
                    <select name="workspace_mode" defaultValue="crm">
                      <option value="crm">客户工作台（业务员）</option>
                      <option value="tasks">协作待办（设计师、版师等）</option>
                    </select>
                  </label>
                </div>
                <p className="personal-settings-description">
                  客户工作台按客户授权开放资料。协作待办仅展示交办给该成员的事项和处理所需说明。
                </p>
                <div className="team-settings-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setError('');
                    }}
                  >
                    取消
                  </button>
                  <button type="submit" className="primary">
                    {busy ? '创建中…' : '创建成员'}
                  </button>
                </div>
              </fieldset>
            </form>
          )}
          <ul className="team-settings-list" aria-label="工作空间成员">
            {members.map((member) => (
              <li key={member.actor_id}>
                <div className="team-settings-row">
                  <div className="team-settings-person">
                    <strong>{member.display_name}</strong>
                    <span>{member.email}</span>
                  </div>
                  <span className="ba-tag">{memberMode(member)}</span>
                  <span className="team-settings-state">{member.active ? '已启用' : '已停用'}</span>
                  {!readOnly && member.role === 'member' && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`${member.active ? '停用' : '启用'} ${member.display_name}`}
                      onClick={() => {
                        setConfirmMember(member);
                        setError('');
                        setNotice('');
                      }}
                    >
                      {member.active ? '停用' : '启用'}
                    </button>
                  )}
                </div>
                {confirmMember?.actor_id === member.actor_id && (
                  <div className="team-settings-confirm">
                    <p>
                      {member.active
                        ? `${member.display_name} 将无法继续访问当前工作空间。`
                        : `恢复 ${member.display_name} 在当前工作空间的权限。`}
                    </p>
                    <button type="button" disabled={busy} onClick={() => setConfirmMember(null)}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => void toggleMember(member)}
                    >
                      {busy ? '正在保存…' : member.active ? '确认停用' : '确认启用'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CustomerPermissions({
  workspace,
  members,
  onChanged,
  readOnly,
}: {
  workspace: string;
  members: Member[];
  onChanged?: () => void;
  readOnly: boolean;
}) {
  const [query, setQuery] = useState({ text: '', page: 1, archived: false });
  const [directory, setDirectory] = useState<CustomerPage | null>(null);
  const [selected, setSelected] = useState<CustomerChoice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: query.text,
      page: String(query.page),
      archived: String(query.archived),
      sort: 'name',
      direction: 'asc',
    });
    setDirectory(null);
    setError('');
    api<CustomerPage>(`/customers?${params}`, { workspace, signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setDirectory(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [query, workspace]);

  return selected ? (
    <CustomerAccessForm
      key={selected.id}
      workspace={workspace}
      customer={selected}
      members={members}
      onBack={() => setSelected(null)}
      onChanged={onChanged}
      readOnly={readOnly}
    />
  ) : (
    <>
      <h4>选择客户</h4>
      <p className="personal-settings-description">
        客户权限按客户授予。成员的负责人身份由业务分工单独决定。
      </p>
      <form
        className="team-settings-search"
        onSubmit={(event) => {
          event.preventDefault();
          const input = new FormData(event.currentTarget);
          setQuery({ ...query, text: String(input.get('query')).trim(), page: 1 });
        }}
      >
        <input
          name="query"
          aria-label="搜索客户"
          defaultValue={query.text}
          maxLength={100}
          placeholder="按客户名称、联系人或邮箱搜索"
        />
        <select
          aria-label="客户状态"
          value={String(query.archived)}
          onChange={(event) =>
            setQuery({ ...query, archived: event.target.value === 'true', page: 1 })
          }
        >
          <option value="false">在用客户</option>
          <option value="true">已归档客户</option>
        </select>
        <button type="submit">搜索</button>
      </form>
      {error ? (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      ) : !directory ? (
        <p className="ba-empty" role="status">
          正在读取客户…
        </p>
      ) : directory.items.length ? (
        <>
          <ul className="team-settings-list" aria-label="可授权客户">
            {directory.items.map((customer) => (
              <li className="team-settings-row" key={customer.id}>
                <div className="team-settings-person">
                  <strong>{customer.name}</strong>
                  <span>
                    {[customer.contact_name, customer.region].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(customer)}
                  aria-label={`${readOnly ? '查看' : '设置'} ${customer.name} 的访问权限`}
                >
                  {readOnly ? '查看权限' : '设置权限'}
                </button>
              </li>
            ))}
          </ul>
          {directory.total > directory.page_size && (
            <div className="team-settings-actions">
              <button
                type="button"
                disabled={query.page === 1}
                onClick={() => setQuery({ ...query, page: query.page - 1 })}
              >
                上一页
              </button>
              <span>第 {query.page} 页</span>
              <button
                type="button"
                disabled={query.page * directory.page_size >= directory.total}
                onClick={() => setQuery({ ...query, page: query.page + 1 })}
              >
                下一页
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="ba-empty">没有找到客户。</p>
      )}
    </>
  );
}

function CustomerAccessForm({
  workspace,
  customer,
  members,
  onBack,
  onChanged,
  readOnly,
}: {
  workspace: string;
  customer: CustomerChoice;
  members: Member[];
  onBack: () => void;
  onChanged?: () => void;
  readOnly: boolean;
}) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [memberId, setMemberId] = useState('');
  const [choice, setChoice] = useState<CustomerAccess | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const memberControl = useRef<HTMLSelectElement>(null);
  const eligible = members.filter(
    (member) => member.role === 'member' && member.active && member.workspace_mode !== 'tasks',
  );
  const memberEligible = eligible.some((member) => member.actor_id === memberId);
  const previous = grants?.find((grant) => grant.actor_id === memberId)?.access ?? '';
  const path = `/customers/${customer.id}/access`;

  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (memberId) memberControl.current?.focus();
  }, [memberId]);

  useEffect(() => {
    const controller = new AbortController();
    setGrants(null);
    setError('');
    api<Grant[]>(path, { workspace, signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setGrants(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [path, workspace, revision]);

  function edit(actorId: string) {
    setMemberId(actorId);
    setChoice(grants?.find((grant) => grant.actor_id === actorId)?.access ?? '');
    setError('');
    setNotice('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !memberId || choice === previous || (choice && !memberEligible)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`${path}/${memberId}`, {
        workspace,
        method: 'PUT',
        body: { access: choice || null },
      });
      setNotice(choice ? '客户权限已保存。' : '客户权限已撤销。');
      setMemberId('');
      setChoice('');
      setRevision((value) => value + 1);
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="text-button" onClick={onBack} disabled={busy}>
        ← 返回客户列表
      </button>
      <h4 tabIndex={-1} ref={heading}>
        {customer.name} · 访问权限
      </h4>
      {notice && (
        <p className="ba-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      )}
      {!grants ? (
        error ? (
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            重新读取权限
          </button>
        ) : (
          <p className="ba-empty" role="status">
            正在读取客户权限…
          </p>
        )
      ) : (
        <>
          {grants.length ? (
            <ul className="team-settings-list" aria-label="已授权成员">
              {grants.map((grant) => {
                const member = members.find((candidate) => candidate.actor_id === grant.actor_id);
                const name = member?.display_name || '成员';
                return (
                  <li className="team-settings-row" key={grant.actor_id}>
                    <div className="team-settings-person">
                      <strong>{name}</strong>
                      {member && !member.active && <span>已停用</span>}
                    </div>
                    <span className="ba-tag">{accessLabels[grant.access]}</span>
                    {!readOnly && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => edit(grant.actor_id)}
                        aria-label={`调整 ${name} 的访问权限`}
                      >
                        调整权限
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ba-empty">尚未向普通成员授予此客户的访问权限。</p>
          )}
          {!readOnly && !!(eligible.length || memberId) && (
            <form
              className="team-settings-form"
              aria-label="设置客户权限"
              onSubmit={(event) => void save(event)}
            >
              <fieldset disabled={busy}>
                <div className="team-settings-grid">
                  <label className="field">
                    <span>成员</span>
                    <select
                      aria-label="成员"
                      ref={memberControl}
                      value={memberId}
                      onChange={(event) => edit(event.target.value)}
                      required
                    >
                      <option value="">选择客户工作台成员</option>
                      {eligible.map((member) => (
                        <option key={member.actor_id} value={member.actor_id}>
                          {member.display_name} · {member.email}
                        </option>
                      ))}
                      {memberId && !memberEligible && (
                        <option value={memberId}>
                          {members.find((member) => member.actor_id === memberId)?.display_name ||
                            '已授权成员'}{' '}
                          · 仅可撤销
                        </option>
                      )}
                    </select>
                  </label>
                  <label className="field">
                    <span>客户权限</span>
                    <select
                      aria-label="客户权限"
                      value={choice}
                      disabled={!memberId}
                      onChange={(event) => setChoice(event.target.value as typeof choice)}
                    >
                      <option value="">{previous ? '撤销访问权限' : '选择权限'}</option>
                      <option value="viewer" disabled={!memberEligible}>
                        只读
                      </option>
                      <option value="editor" disabled={!memberEligible}>
                        可编辑
                      </option>
                    </select>
                  </label>
                </div>
                <div className="team-settings-actions">
                  <button
                    type="submit"
                    className="primary"
                    disabled={!memberId || choice === previous}
                  >
                    {busy ? '保存中…' : previous && !choice ? '撤销权限' : '保存权限'}
                  </button>
                </div>
              </fieldset>
            </form>
          )}
        </>
      )}
    </>
  );
}
