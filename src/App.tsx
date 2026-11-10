import { MailWorkspace } from './Mail';
import { DocumentsWorkspace, DocumentUploadButton } from './Documents';
import { EntityNotes, useNotesAvailable } from './Notes';
import { CommunicationMetrics } from './CommunicationMetrics';
import { AssociatedProjects } from './AssociatedProjects';
import { RecordRelations } from './Relationships';
import { CompanyAttributes } from './CompanyAttributes';
import { PersonDetail, CompanyPeople } from './People';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Building2,
  ArrowRight,
  Archive,
  Check,
  FolderOpen,
  Pencil,
  Plus,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { api, HttpError, transientReadFailure } from './api';
import { ActivityTimeline, ProjectWorkspace } from './RecordWorkspace';
import { EmailAddress } from './EmailAddress';
import { MailComposer, OutgoingPanel } from './MailComposer';
import { Workbench, type CustomerList, type Selection } from './Workbench';
import {
  customerTypes,
  customerStatuses,
  sources,
  projectTypes,
  projectStages,
  recordKinds,
  type Customer,
  type Project,
  type CustomerRecord,
  type AuditEvent,
  type Member,
  type SessionInfo,
} from '../shared/domain';

type Workspace = SessionInfo['workspaces'][number];
type ModalState =
  | {
      kind: 'customer';
      value?: Customer;
      initialStatus?: Customer['status'];
      initialType?: Customer['type'];
    }
  | { kind: 'project'; value?: Project; initialType?: Project['type'] }
  | { kind: 'record'; projectId?: string; lockProject?: boolean }
  | null;
const time = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
function Brand() {
  return (
    <div className="brand">
      light<span>crm</span>
    </div>
  );
}
function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <FolderOpen size={30} strokeWidth={1.2} />
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Options({ values }: { values: Record<string, string> }) {
  return (
    <>
      {Object.entries(values).map(([key, value]) => (
        <option key={key} value={key}>
          {value}
        </option>
      ))}
    </>
  );
}
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field ${wide ? 'wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {isValidElement<{ id?: string }>(children) ? cloneElement(children, { id }) : children}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: (requestClose: () => void) => ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    el.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      onChangeCapture={() => setDirty(true)}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <header>
        <div>
          <h2 id="modal-title">{title}</h2>
        </div>
        <button className="icon-button" onClick={requestClose} aria-label="关闭弹窗">
          <X size={20} />
        </button>
      </header>
      {confirmClose && (
        <div className="discard-notice" role="alert">
          <span>还有未保存的内容，要放弃这次修改吗？</span>
          <div>
            <button onClick={() => setConfirmClose(false)}>继续编辑</button>
            <button onClick={onClose}>放弃修改</button>
          </div>
        </div>
      )}
      {children(requestClose)}
    </dialog>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/auth/login', {
        method: 'POST',
        body: { email: form.get('email'), password: form.get('password') },
      });
      onLogin();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <section className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">A LITTLE CLOSER, EVERY DAY.</span>
          <h1>
            把每一段关系，
            <br />
            照顾得更好。
          </h1>
          <p>
            从一次问询，到下一个共同的项目。
            <br />
            让客户、沟通与进展，有一个清晰的归处。
          </p>
        </div>
        <span className="login-footer">
          客户与项目工作台 <span>01 / FOUNDATION</span>
        </span>
      </section>
      <section className="login-form">
        <span className="eyebrow">WELCOME BACK</span>
        <h2>回到你的工作空间</h2>
        <p className="muted">登录后，继续处理获授权的客户与项目。</p>
        <form onSubmit={submit}>
          <Field label="邮箱">
            <input
              type="email"
              name="email"
              autoComplete="username"
              required
              placeholder="you@example.com"
            />
          </Field>
          <Field label="密码">
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              placeholder="输入账号密码"
            />
          </Field>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? '正在登录…' : '登录工作空间'}
            <ArrowRight size={17} />
          </button>
        </form>
        <p className="login-hint">
          <ShieldCheck size={16} />
          客户资料仅向获授权的成员开放。
        </p>
        <details className="setup-hint">
          <summary>首次本地使用</summary>
          <p>
            在项目目录运行 <code>npm run setup -- --demo</code>。随机登录凭据保存在{' '}
            <code>.local/initial-login.txt</code>。
          </p>
        </details>
      </section>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null),
    [starting, setStarting] = useState(true),
    [sessionError, setSessionError] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const loadSession = useCallback(async () => {
    try {
      const s = await api<SessionInfo>('/session');
      setSession(s);
      setWorkspaceId((current) =>
        s.workspaces.some((w) => w.id === current) ? current : (s.workspaces[0]?.id ?? ''),
      );
      setSessionError('');
    } catch (e) {
      setSession(null);
      setSessionError(e instanceof HttpError && e.status === 401 ? '' : errorText(e));
    } finally {
      setStarting(false);
    }
  }, []);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  if (starting)
    return (
      <div className="startup">
        <Brand />
        <p>正在打开工作空间…</p>
      </div>
    );
  if (!session)
    return sessionError ? (
      <div className="startup">
        <Brand />
        <p role="alert">{sessionError}</p>
        <button onClick={() => void loadSession()}>重新打开工作空间</button>
      </div>
    ) : (
      <Login onLogin={() => void loadSession()} />
    );
  const workspace = session.workspaces.find((w) => w.id === workspaceId);
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
      setSession(null);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) setSession(null);
      else setSessionError(errorText(e));
    }
  }
  if (!workspace)
    return (
      <div className="startup">
        <Brand />
        <h2>暂无可访问的工作空间</h2>
        <p>请联系管理员恢复成员权限。</p>
        {session.auth_mode !== 'local' && <button onClick={logout}>退出登录</button>}
      </div>
    );
  return (
    <WorkspaceApp
      key={workspace.id}
      session={session}
      workspace={workspace}
      onWorkspace={setWorkspaceId}
      onLogout={logout}
      onUnauthorized={() => void loadSession()}
    />
  );
}
function WorkspaceApp({
  session,
  workspace,
  onWorkspace,
  onLogout,
  onUnauthorized,
}: {
  session: SessionInfo;
  workspace: Workspace;
  onWorkspace: (id: string) => void;
  onLogout: () => void;
  onUnauthorized: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [refresh, setRefresh] = useState(0),
    [toast, setToast] = useState(''),
    [error, setError] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const reload = useCallback(() => setRefresh((v) => v + 1), []);
  const notify = (text: string) => {
    setToast(text);
    reload();
  };
  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof HttpError && e.status === 401) onUnauthorized();
      else setError(errorText(e));
    },
    [onUnauthorized],
  );
  useEffect(() => {
    const controller = new AbortController();
    api<Member[]>('/members', { workspace: workspace.id, signal: controller.signal })
      .then(setMembers)
      .catch((e) => {
        if (e.name !== 'AbortError') handleError(e);
      });
    return () => controller.abort();
  }, [workspace.id, refresh, handleError]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  return (
    <>
      <Workbench
        session={session}
        workspace={workspace}
        members={members}
        onWorkspace={onWorkspace}
        onLogout={onLogout}
        onUnauthorized={onUnauthorized}
        refresh={refresh}
        reload={reload}
        notify={notify}
        selected={selected}
        onSelect={setSelected}
        onCreateCustomer={(initialType) => setModal({ kind: 'customer', initialType })}
        onCreateProject={(initialType) => setModal({ kind: 'project', initialType })}
        renderDetail={(selection) =>
          selection.personId ? (
            <PersonDetail
              id={selection.personId}
              workspace={workspace.id}
              refresh={refresh}
              onSelect={setSelected}
              notify={notify}
            />
          ) : (
            <CustomerDetail
              key={selection.customerId}
              id={selection.customerId}
              full={!!selection.full}
              focusProject={selection.projectId}
              initialTab={selection.customerTab}
              onSelect={setSelected}
              workspace={workspace}
              members={members}
              refresh={refresh}
              notify={notify}
              onRefresh={reload}
              onUnauthorized={onUnauthorized}
            />
          )
        }
      />
      {modal && (
        <EntityForm
          modal={modal}
          workspace={workspace}
          members={members}
          onClose={() => setModal(null)}
          onSaved={(value) => {
            if (modal.kind === 'customer' && value.id)
              setSelected({ customerId: value.id, full: true });
            if (modal.kind === 'project' && value.id && value.customer_id)
              setSelected({ customerId: value.customer_id, projectId: value.id, full: true });
            setModal(null);
            notify('已保存');
          }}
        />
      )}
      {error && (
        <div className="error global-error" role="alert">
          {error}
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </>
  );
}

function CustomerDetail({
  id,
  full = false,
  focusProject,
  initialTab,
  onSelect,
  workspace,
  members,
  refresh,
  notify,
  onRefresh,
  onUnauthorized,
}: {
  id: string;
  full?: boolean;
  focusProject?: string;
  initialTab?: Selection['customerTab'];
  onSelect: (selection: Selection) => void;
  workspace: Workspace;
  members: Member[];
  refresh: number;
  notify: (message: string) => void;
  onRefresh: () => void;
  onUnauthorized: () => void;
}) {
  const [data, setData] = useState<{
    customer: Customer;
    projects: Project[];
    records: CustomerRecord[];
    audit: AuditEvent[];
  } | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<
      | 'overview'
      | 'projects'
      | 'records'
      | 'files'
      | 'notes'
      | 'audit'
      | 'activity'
      | 'people'
      | 'emails'
      | 'relations'
    >(initialTab || (full ? 'overview' : 'projects')),
    [modal, setModal] = useState<ModalState>(null);
  const [recordProject, setRecordProject] = useState('');
  const [compose, setCompose] = useState<string | null>(null);
  const [mailRevision, setMailRevision] = useState(0);
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const notesAvailable = useNotesAvailable(workspace.id);
  const admin = workspace.role === 'admin',
    base = `/customers/${id}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setData((current) =>
      current?.customer.id === id && current.customer.workspace_id === workspace.id
        ? current
        : null,
    );
    const options = { workspace: workspace.id, signal: controller.signal };
    void Promise.all([
      api<Customer>(base, options),
      api<Project[]>(`${base}/projects`, options),
      api<CustomerRecord[]>(`${base}/records`, options),
      api<AuditEvent[]>(`${base}/audit`, options),
    ])
      .then(([customer, projects, records, audit]) => {
        if (controller.signal.aborted) return;
        setData({ customer, projects, records, audit });
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted && e.name !== 'AbortError') {
          if (!transientReadFailure(e)) setData(null);
          setLoading(false);
          setError(errorText(e));
          if (e instanceof HttpError && e.status === 401) onUnauthorized();
        }
      });
    return () => controller.abort();
  }, [id, workspace.id, refresh, base, onUnauthorized]);
  async function change(path: string, body: unknown, message: string, method = 'PATCH') {
    setBusy(true);
    setError('');
    try {
      await api(path, { workspace: workspace.id, method, body });
      notify(message);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof HttpError && [401, 404].includes(e.status)) {
        setData(null);
        if (e.status === 401) onUnauthorized();
      }
    } finally {
      setBusy(false);
    }
  }
  const person = (actor: string | null) =>
    members.find((m) => m.actor_id === actor)?.display_name ?? '未分配';
  if (!data || data.customer.id !== id || data.customer.workspace_id !== workspace.id)
    return (
      <div className="detail-loading">
        {loading ? (
          <div className="empty">正在加载客户资料…</div>
        ) : (
          <div className="error" role="alert">
            {error}
            <button onClick={onRefresh}>重新加载</button>
          </div>
        )}
      </div>
    );
  const { customer: c, projects, records, audit } = data;
  const editable = c.can_edit && !c.archived_at;
  const emailField = (
    <EmailAddress
      email={c.email}
      editable={!!editable}
      workspace={workspace.id}
      path={base}
      version={c.version}
      onCompose={() => {
        setTab('emails');
        setCompose('new');
      }}
      onSaved={onRefresh}
    />
  );
  const filteredRecords = recordProject
    ? records.filter((r) => r.project_id === recordProject)
    : records;
  const form = modal && (
    <EntityForm
      modal={modal}
      workspace={workspace}
      members={members}
      customerId={id}
      customerName={c.name}
      projects={projects}
      onClose={() => setModal(null)}
      onSaved={(value) => {
        if (modal.kind === 'project' && !modal.value && value.id)
          onSelect({ customerId: id, projectId: value.id, full: true });
        setModal(null);
        notify('已保存');
      }}
    />
  );
  if (focusProject) {
    const project = projects.find((p) => p.id === focusProject);
    if (!project)
      return (
        <div className="detail-loading">
          <Empty
            title="项目不可访问"
            text="项目不存在或访问权限已改变。"
            action={
              <button onClick={() => onSelect({ customerId: id, full: true })}>返回客户档案</button>
            }
          />
        </div>
      );
    return (
      <>
        <ProjectWorkspace
          workspace={workspace.id}
          onSelect={onSelect}
          key={project.id}
          customer={c}
          project={project}
          records={records}
          audit={audit}
          full={full}
          person={person}
          busy={busy}
          error={error}
          onRefresh={onRefresh}
          onCustomer={() => onSelect({ customerId: id, full: true })}
          onRecord={() => setModal({ kind: 'record', projectId: project.id, lockProject: true })}
          onEdit={() => setModal({ kind: 'project', value: project })}
          onChange={(patch, message) =>
            void change(
              `${base}/projects/${project.id}`,
              { version: project.version, ...patch },
              message,
            )
          }
        />
        {form}
      </>
    );
  }
  const recordHeading = (
    <div className="detail-heading">
      <div className="grow">
        <h2>{c.name}</h2>
        <div className="detail-meta">
          <span>{customerTypes[c.type]}</span>
          <span>来自{sources[c.source]}</span>
          <span>{c.region || '地区待补充'}</span>
          {c.archived_at && <Badge>已归档</Badge>}
          {!c.can_edit && <Badge>只读权限</Badge>}
        </div>
      </div>
      <div className="heading-actions">
        {editable && (
          <DocumentUploadButton
            workspace={workspace.id}
            customer={{ id: c.id, name: c.name }}
            onUploaded={() => setTab('files')}
          />
        )}
        {full && editable && (
          <button aria-label="新建记录 · 客户记录" onClick={() => setModal({ kind: 'record' })}>
            <Plus size={14} />
            新建记录
          </button>
        )}
        {editable && (
          <button onClick={() => setModal({ kind: 'customer', value: c })}>
            <Pencil size={15} />
            编辑资料
          </button>
        )}
        {admin && (
          <button
            className="icon-button"
            title={c.archived_at ? '恢复客户' : '归档客户'}
            aria-label={c.archived_at ? '恢复客户' : '归档客户'}
            disabled={busy}
            onClick={() =>
              void change(
                base,
                { version: c.version, archived: !c.archived_at },
                c.archived_at ? '客户已恢复' : '客户已归档，历史记录已保留',
              )
            }
          >
            <Archive size={19} />
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className={`detail-content ${full ? 'customer-full company-layout' : ''}`}>
      {full && (
        <header className="company-record-heading">
          <Building2 size={20} />
          {recordHeading}
        </header>
      )}
      <aside className="customer-profile">
        {!full && recordHeading}
        {full && <div className="details-panel-title">属性</div>}
        {tab === 'emails' && (
          <AssociatedProjects
            workspace={workspace.id}
            object="customers"
            id={id}
            refresh={refresh}
            onSelect={onSelect}
            onManage={() => setTab('projects')}
          />
        )}
        <CommunicationMetrics record={c} onOpen={() => setTab('emails')} />
        <dl className="contact-summary">
          {full && (
            <div>
              <dt>名称</dt>
              <dd>{c.name}</dd>
            </div>
          )}
          <div>
            <dt>联系人</dt>
            <dd>
              {c.contact_name ? (
                <button className="text-button" onClick={() => setTab('people')}>
                  {c.contact_name}
                </button>
              ) : (
                '未填写'
              )}
            </dd>
          </div>
          <div>
            <dt>负责人</dt>
            <dd>{person(c.owner_id)}</dd>
          </div>
          <div className="contact-email">
            <dt>邮箱</dt>
            <dd>{emailField}</dd>
          </div>
          {full && (
            <>
              <div>
                <dt>电话</dt>
                <dd>{c.phone || '未填写'}</dd>
              </div>
              <div>
                <dt>客户类型</dt>
                <dd>{customerTypes[c.type]}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{sources[c.source]}</dd>
              </div>
              <div>
                <dt>地区</dt>
                <dd>{c.region || '未填写'}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{time(c.created_at)}</dd>
              </div>
              <div>
                <dt>最近更新</dt>
                <dd>{time(c.updated_at)}</dd>
              </div>
            </>
          )}
        </dl>
        <CompanyAttributes
          key={`${workspace.id}:${id}`}
          workspace={workspace.id}
          customer={c}
          refresh={refresh}
          onSaved={onRefresh}
        />
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={onRefresh}>刷新资料</button>
          </div>
        )}
        {c.archived_at && (
          <div className="notice">
            <Archive size={16} />
            这个客户已归档，资料保留为只读。管理员恢复后可继续维护。
          </div>
        )}
        <div className="detail-quick-actions">
          {editable && !full && (
            <button aria-label="新建记录 · 客户记录" onClick={() => setModal({ kind: 'record' })}>
              <Plus size={15} />
              新建记录
            </button>
          )}
          {editable ? (
            <select
              aria-label="更新客户合作状态"
              value={c.status}
              disabled={busy}
              onChange={(e) =>
                void change(base, { version: c.version, status: e.target.value }, '合作状态已更新')
              }
            >
              <Options values={customerStatuses} />
            </select>
          ) : (
            <Badge tone={c.status}>{customerStatuses[c.status]}</Badge>
          )}
        </div>
      </aside>
      <section className="detail-panel">
        <div className="panel-top">
          <div className="tabs" aria-label="客户档案内容">
            {full && (
              <button
                className={tab === 'overview' ? 'current' : ''}
                onClick={() => setTab('overview')}
              >
                概览
              </button>
            )}
            <button
              className={tab === 'activity' ? 'current' : ''}
              onClick={() => setTab('activity')}
            >
              活动
            </button>
            <button className={tab === 'emails' ? 'current' : ''} onClick={() => setTab('emails')}>
              邮件
            </button>
            <button
              className={tab === 'relations' ? 'current' : ''}
              onClick={() => setTab('relations')}
            >
              关联
            </button>
            <button className={tab === 'people' ? 'current' : ''} onClick={() => setTab('people')}>
              联系人
            </button>
            <button
              className={tab === 'projects' ? 'current' : ''}
              onClick={() => setTab('projects')}
            >
              项目 <span>{projects.filter((p) => !p.archived_at).length}</span>
            </button>
            <button
              className={tab === 'records' ? 'current' : ''}
              onClick={() => setTab('records')}
            >
              记录{' '}
              <span>
                {records.length}
                {records.length === 100 ? '+' : ''}
              </span>
            </button>
            <button
              className={tab === 'notes' ? 'current' : ''}
              disabled={!notesAvailable}
              title={notesAvailable ? '客户笔记' : '笔记服务尚未加载'}
              onClick={() => setTab('notes')}
            >
              笔记
            </button>
            <button className={tab === 'files' ? 'current' : ''} onClick={() => setTab('files')}>
              文件
            </button>
            <button className={tab === 'audit' ? 'current' : ''} onClick={() => setTab('audit')}>
              历史
            </button>
          </div>
        </div>
        <div className="detail-body">
          {tab === 'emails' && (
            <>
              <OutgoingPanel
                workspace={workspace.id}
                personId={id}
                kind="customers"
                refresh={refresh + mailRevision}
                onOpen={setCompose}
              />
              <MailWorkspace
                workspace={workspace.id}
                customerId={id}
                onSelect={onSelect}
                onRefresh={onRefresh}
                refreshVersion={refresh + mailRevision}
              />
            </>
          )}
          {tab === 'relations' && (
            <RecordRelations
              workspace={workspace.id}
              customerId={id}
              object="customers"
              id={id}
              editable={!!editable}
              onSelect={onSelect}
            />
          )}
          {tab === 'people' && (
            <CompanyPeople
              customer={c}
              workspace={workspace.id}
              refresh={refresh}
              onSelect={onSelect}
              notify={notify}
            />
          )}
          {tab === 'overview' && (
            <div className="customer-overview">
              <div className="relationship-summary">
                <div>
                  <span>合作状态</span>
                  <strong>{customerStatuses[c.status]}</strong>
                </div>
                <div>
                  <span>客户负责人</span>
                  <strong>{person(c.owner_id)}</strong>
                </div>
                <div>
                  <span>最近记录</span>
                  <strong>{records[0] ? time(records[0].created_at) : '暂无记录'}</strong>
                </div>
              </div>
              <div className="section-heading">
                <div>
                  <h2>当前项目</h2>
                  <p>
                    {
                      projects.filter(
                        (p) => !p.archived_at && !['completed', 'cancelled'].includes(p.stage),
                      ).length
                    }{' '}
                    个未结束项目 · {projects.filter((p) => !p.archived_at).length} 个未归档项目
                  </p>
                </div>
                {editable && (
                  <button
                    aria-label="新建记录 · 项目"
                    onClick={() => setModal({ kind: 'project' })}
                  >
                    <Plus size={14} />
                    新建记录
                  </button>
                )}
              </div>
              <div className="overview-projects">
                {projects
                  .filter((p) => !p.archived_at)
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        onSelect({ customerId: id, projectId: p.id, full: true });
                      }}
                    >
                      <div>
                        <strong>{p.name}</strong>
                        <small>
                          {projectTypes[p.type]} · {person(p.owner_id)}
                        </small>
                      </div>
                      <span>
                        {projectStages[p.stage]}
                        <small>{p.due_date || '目标日期待定'}</small>
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  ))}
              </div>
              {!projects.some((p) => !p.archived_at) && (
                <p className="overview-empty">
                  暂无未归档项目，可在此建立询盘、样衣、定制或采购项目。
                </p>
              )}
              <div className="section-heading overview-record-heading">
                <div>
                  <h2>最近活动</h2>
                  <p>邮件往来、人工记录与项目动态</p>
                </div>
                <button className="text-button" onClick={() => setTab('activity')}>
                  查看全部 <ArrowRight size={13} />
                </button>
              </div>
              <ActivityTimeline
                workspace={workspace.id}
                customerId={id}
                onSelect={onSelect}
                records={records}
                audit={audit}
                projects={projects}
                person={person}
                limit={5}
                onProject={(projectId) => onSelect({ customerId: id, projectId, full: true })}
              />
            </div>
          )}
          {tab === 'notes' && (
            <EntityNotes
              workspace={workspace.id}
              customer={{ id: c.id, name: c.name }}
              canCreate={!!editable}
            />
          )}
          {tab === 'files' && (
            <DocumentsWorkspace
              workspace={workspace.id}
              customer={{ id: c.id, name: c.name }}
              editable={!!editable}
              refresh={refresh}
              onSelect={onSelect}
            />
          )}
          {tab === 'projects' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>关联项目</h2>
                </div>
                {editable && (
                  <button
                    className="primary"
                    aria-label="新建记录 · 项目"
                    onClick={() => setModal({ kind: 'project' })}
                  >
                    <Plus size={16} />
                    新建记录
                  </button>
                )}
              </div>
              {!projects.length ? (
                <Empty
                  title="暂无关联项目"
                  text="点击“新建记录”，跟进询盘、样衣、定制或采购进展。"
                />
              ) : (
                <div className="project-grid">
                  {projects.map((p) => (
                    <article
                      className={`project-card ${p.archived_at ? 'is-archived' : ''} `}
                      id={`project-${p.id}`}
                      key={p.id}
                    >
                      <div className="project-card-top">
                        <h3>
                          <button
                            className="project-name-link"
                            onClick={() =>
                              onSelect({ customerId: id, projectId: p.id, full: true })
                            }
                          >
                            {p.name}
                            <ArrowRight size={13} />
                          </button>
                        </h3>
                        {editable && !p.archived_at ? (
                          <select
                            className={`stage-select ${p.stage}`}
                            aria-label={`${p.name}的阶段`}
                            value={p.stage}
                            disabled={busy}
                            onChange={(e) =>
                              void change(
                                `${base}/projects/${p.id}`,
                                { version: p.version, stage: e.target.value },
                                '项目阶段已更新',
                              )
                            }
                          >
                            <Options values={projectStages} />
                          </select>
                        ) : (
                          <Badge tone={p.stage}>
                            {p.archived_at ? '已归档' : projectStages[p.stage]}
                          </Badge>
                        )}
                      </div>
                      <p>{p.description || '暂无项目说明，后续可补充需求与背景。'}</p>
                      <div className="project-info">
                        <span>{projectTypes[p.type]}</span>
                        <span>{p.due_date ? `目标日期 ${p.due_date}` : '目标日期待定'}</span>
                      </div>
                      <footer>
                        <span>{person(p.owner_id)}</span>
                        <button
                          className="text-button"
                          onClick={() => {
                            setRecordProject(p.id);
                            setTab('records');
                          }}
                        >
                          查看记录
                        </button>
                        {editable && (
                          <div>
                            {!p.archived_at && (
                              <button
                                className="text-button"
                                onClick={() =>
                                  setModal({ kind: 'record', projectId: p.id, lockProject: true })
                                }
                                aria-label={`为${p.name}新建记录`}
                              >
                                <Plus size={12} />
                                新建记录
                              </button>
                            )}
                            {!p.archived_at && (
                              <button
                                className="text-button"
                                onClick={() => setModal({ kind: 'project', value: p })}
                              >
                                <Pencil size={13} />
                                编辑
                              </button>
                            )}
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() =>
                                void change(
                                  `${base}/projects/${p.id}`,
                                  { version: p.version, archived: !p.archived_at },
                                  p.archived_at ? '项目已恢复' : '项目已归档',
                                )
                              }
                            >
                              {p.archived_at ? '恢复' : '归档'}
                            </button>
                          </div>
                        )}
                      </footer>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
          {tab === 'records' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>客户记录</h2>
                  <p>最近 100 条人工记录 · 原话、推断与公司确认分别保存</p>
                </div>
                {editable && (
                  <button
                    className="primary"
                    aria-label="新建记录 · 客户记录"
                    onClick={() =>
                      setModal({ kind: 'record', projectId: recordProject || undefined })
                    }
                  >
                    <Plus size={16} />
                    新建记录
                  </button>
                )}
              </div>
              <select
                className="record-filter"
                aria-label="按项目查看记录"
                value={recordProject}
                onChange={(e) => setRecordProject(e.target.value)}
              >
                <option value="">全部客户记录</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {!filteredRecords.length ? (
                <Empty
                  title="还没有记录"
                  text="可记录客户原话、内部判断或已确认事项。暂不明确项目时，保留在客户层级。"
                />
              ) : (
                <div className="record-list">
                  {filteredRecords.map((r) => (
                    <article key={r.id} className="record">
                      <div>
                        <Badge tone={r.kind}>{recordKinds[r.kind]}</Badge>
                        <span>
                          {r.project_id
                            ? (projects.find((p) => p.id === r.project_id)?.name ?? '关联项目')
                            : '客户层级 · 未指定项目'}
                        </span>
                      </div>
                      <p>{r.body}</p>
                      <footer>
                        {person(r.created_by)}
                        <span>·</span>
                        {time(r.created_at)}
                      </footer>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
          {tab === 'activity' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>客户活动</h2>
                  <p>最近 30 封邮件、100 条人工记录与操作历史 · 按时间排列</p>
                </div>
                {editable && (
                  <button
                    aria-label="新建记录 · 客户记录"
                    onClick={() => setModal({ kind: 'record' })}
                  >
                    <Plus size={14} />
                    新建记录
                  </button>
                )}
              </div>
              <ActivityTimeline
                workspace={workspace.id}
                customerId={id}
                editable={!!editable}
                onSelect={onSelect}
                records={records}
                audit={audit}
                projects={projects}
                person={person}
                onProject={(projectId) => onSelect({ customerId: id, projectId, full: true })}
              />
            </>
          )}
          {tab === 'audit' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>操作历史</h2>
                  <p>最近 100 条操作 · 时间为北京时间</p>
                </div>
              </div>
              <div className="audit-list">
                {audit.map((event) => (
                  <div key={event.id}>
                    <p>
                      <strong>{person(event.actor_id)}</strong>{' '}
                      {(
                        {
                          insert: '创建了',
                          update: '更新了',
                          archive: '归档了',
                          restore: '恢复了',
                          delete: '移除了',
                        } as Record<string, string>
                      )[event.action] ?? event.action}{' '}
                      {(
                        {
                          customers: '客户档案',
                          projects: '项目',
                          customer_records: '客户记录',
                          customer_access: '客户访问授权',
                        } as Record<string, string>
                      )[event.entity_type] ?? '记录'}
                    </p>
                    <time>{time(event.created_at)}</time>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
      {form}
      {compose && (
        <MailComposer
          key={`${id}:${compose}`}
          workspace={workspace.id}
          kind="customers"
          person={{
            id: c.id,
            customer_id: c.id,
            customer_name: c.name,
            name: c.name,
            email: c.email,
          }}
          draftId={compose === 'new' ? undefined : compose}
          onClose={() => {
            setCompose(null);
            onRefresh();
          }}
          onChanged={() => setMailRevision((n) => n + 1)}
        />
      )}
    </div>
  );
}

function EntityForm({
  modal,
  workspace,
  members,
  customerId,
  customerName,
  projects = [],
  onClose,
  onSaved,
}: {
  modal: NonNullable<ModalState>;
  workspace: Workspace;
  members: Member[];
  customerId?: string;
  customerName?: string;
  projects?: Project[];
  onClose: () => void;
  onSaved: (value: { id?: string; customer_id?: string }) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerOptions, setCustomerOptions] = useState<Customer[]>([]);
  const [chosenCustomer, setChosenCustomer] = useState<Customer | null>(null);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerError, setCustomerError] = useState('');
  const effectiveCustomerId = customerId || chosenCustomer?.id;
  useEffect(() => {
    if (modal.kind !== 'project' || customerId) return;
    const controller = new AbortController();
    setCustomerLoading(true);
    setCustomerError('');
    const timer = setTimeout(() => {
      api<CustomerList>(
        `/customers?editable=true&q=${encodeURIComponent(customerQuery)}&sort=name&direction=asc`,
        { workspace: workspace.id, signal: controller.signal },
      )
        .then((result) => {
          setCustomerOptions(result.items);
          setCustomerLoading(false);
        })
        .catch((e) => {
          if (e.name !== 'AbortError') {
            setCustomerOptions([]);
            setCustomerLoading(false);
            setCustomerError(errorText(e));
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [modal.kind, customerId, customerQuery, workspace.id]);
  const initial = modal.kind === 'customer' || modal.kind === 'project' ? modal.value : undefined;
  const title =
    modal.kind === 'customer'
      ? initial
        ? '编辑客户资料'
        : '新建记录 · 公司'
      : modal.kind === 'project'
        ? initial
          ? '编辑项目'
          : '新建记录 · 项目'
        : '新建记录 · 客户记录';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    let path: string,
      body: Record<string, unknown> = fields;
    if (modal.kind === 'customer') {
      path = `/customers${initial ? `/${initial.id}` : ''}`;
      body = {
        ...fields,
        owner_id: fields.owner_id || null,
        ...(initial ? { version: initial.version } : {}),
      };
    } else if (modal.kind === 'project') {
      if (!effectiveCustomerId) {
        setError('请先选择所属客户');
        setBusy(false);
        return;
      }
      path = `/customers/${effectiveCustomerId}/projects${initial ? `/${initial.id}` : ''}`;
      body = {
        ...fields,
        due_date: fields.due_date || null,
        owner_id: fields.owner_id || null,
        ...(initial ? { version: initial.version } : {}),
      };
    } else {
      path = `/customers/${customerId}/records`;
      body = { ...fields, project_id: fields.project_id || null };
    }
    try {
      const value = await api<{ id?: string; customer_id?: string }>(path, {
        workspace: workspace.id,
        method: initial ? 'PATCH' : 'POST',
        body,
      });
      onSaved(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const ownerOptions = (
    <>
      <option value="">暂不分配</option>
      {members
        .filter((m) => m.active && (modal.kind !== 'customer' || !!initial || m.role === 'admin'))
        .map((m) => (
          <option key={m.actor_id} value={m.actor_id}>
            {m.display_name}
          </option>
        ))}
    </>
  );
  const c = modal.kind === 'customer' ? modal.value : undefined;
  const p = modal.kind === 'project' ? modal.value : undefined;
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {(requestClose) => (
        <form onSubmit={submit}>
          <div className="form-grid">
            {customerName && (
              <div className="form-hint wide">
                <Users size={15} />
                当前客户：{customerName}
              </div>
            )}
            {modal.kind === 'customer' && (
              <>
                <Field label="客户名称 *" wide>
                  <input
                    name="name"
                    defaultValue={c?.name}
                    required
                    maxLength={120}
                    autoFocus
                    placeholder="公司、工作室或个人名称"
                  />
                </Field>
                <Field label="客户类型 *">
                  <select
                    name="type"
                    defaultValue={
                      c?.type ??
                      (modal.kind === 'customer' ? modal.initialType : undefined) ??
                      'distributor'
                    }
                  >
                    <Options values={customerTypes} />
                  </select>
                </Field>
                <Field label="来源渠道 *">
                  <select name="source" defaultValue={c?.source ?? 'email'}>
                    <Options values={sources} />
                  </select>
                </Field>
                <Field label="地区">
                  <input
                    name="region"
                    defaultValue={c?.region}
                    maxLength={200}
                    placeholder="例如：中国 · 上海"
                  />
                </Field>
                <Field label="合作状态">
                  <select
                    name="status"
                    defaultValue={
                      c?.status ??
                      (modal.kind === 'customer' ? modal.initialStatus : undefined) ??
                      'potential'
                    }
                  >
                    <Options values={customerStatuses} />
                  </select>
                </Field>
                <Field label="联系人">
                  <input name="contact_name" defaultValue={c?.contact_name} maxLength={200} />
                </Field>
                <Field label="联系电话">
                  <input name="phone" type="tel" defaultValue={c?.phone} maxLength={60} />
                </Field>
                <Field label="邮箱">
                  <input name="email" type="email" defaultValue={c?.email} maxLength={254} />
                </Field>
                <Field label="负责人">
                  <select name="owner_id" defaultValue={c?.owner_id ?? ''}>
                    {ownerOptions}
                  </select>
                </Field>
              </>
            )}
            {modal.kind === 'project' && (
              <>
                {!customerId && (
                  <div className="customer-picker wide">
                    <label htmlFor="project-customer-search">所属客户 *</label>
                    {chosenCustomer ? (
                      <div className="chosen-customer">
                        <strong>{chosenCustomer.name}</strong>
                        <button type="button" onClick={() => setChosenCustomer(null)}>
                          重新选择
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          id="project-customer-search"
                          aria-label="搜索可编辑客户"
                          value={customerQuery}
                          maxLength={100}
                          onChange={(e) => setCustomerQuery(e.target.value)}
                          placeholder="搜索客户、联系人或邮箱"
                        />
                        <div className="customer-options">
                          {customerLoading ? (
                            <p>正在查找客户…</p>
                          ) : customerError ? (
                            <p role="alert">{customerError}</p>
                          ) : customerOptions.length ? (
                            customerOptions.map((c) => (
                              <button type="button" key={c.id} onClick={() => setChosenCustomer(c)}>
                                <span>{c.name}</span>
                                <small>{customerTypes[c.type]}</small>
                              </button>
                            ))
                          ) : (
                            <p>没有可编辑客户，请调整搜索或联系管理员授权。</p>
                          )}
                        </div>
                        <small>最多显示 30 位可编辑客户，可通过搜索继续查找。</small>
                      </>
                    )}
                  </div>
                )}
                <div className="form-hint wide">
                  <ShieldCheck size={15} />
                  项目创建后不能更换所属客户。
                </div>
                <Field label="项目名称 *" wide>
                  <input
                    name="name"
                    defaultValue={p?.name}
                    required
                    maxLength={120}
                    autoFocus
                    placeholder="例如：春季系列样衣确认"
                  />
                </Field>
                <Field label="项目类型">
                  <select
                    name="type"
                    defaultValue={
                      p?.type ??
                      (modal.kind === 'project' ? modal.initialType : undefined) ??
                      'inquiry'
                    }
                  >
                    <Options values={projectTypes} />
                  </select>
                </Field>
                <Field label="当前阶段">
                  <select name="stage" defaultValue={p?.stage ?? 'new'}>
                    <Options values={projectStages} />
                  </select>
                </Field>
                <Field label="目标日期">
                  <input name="due_date" type="date" defaultValue={p?.due_date ?? ''} />
                </Field>
                <Field label="负责人">
                  <select name="owner_id" defaultValue={p?.owner_id ?? ''}>
                    {ownerOptions}
                  </select>
                </Field>
                <Field label="项目说明" wide>
                  <textarea
                    name="description"
                    defaultValue={p?.description}
                    maxLength={5000}
                    rows={4}
                    placeholder="写下已知需求、背景或待确认事项…"
                  />
                </Field>
              </>
            )}
            {modal.kind === 'record' && (
              <>
                <Field label="记录性质">
                  <select name="kind">
                    <Options values={recordKinds} />
                  </select>
                </Field>
                {modal.lockProject && (
                  <input type="hidden" name="project_id" value={modal.projectId} />
                )}
                <Field label="所属项目">
                  {modal.lockProject ? (
                    <input
                      readOnly
                      value={projects.find((p) => p.id === modal.projectId)?.name || '当前项目'}
                    />
                  ) : (
                    <select name="project_id" defaultValue={modal.projectId ?? ''}>
                      <option value="">客户层级（暂不指定项目）</option>
                      {projects
                        .filter((p) => !p.archived_at)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  )}
                </Field>
                <Field label="记录内容 *" wide>
                  <textarea
                    name="body"
                    required
                    maxLength={10000}
                    rows={7}
                    autoFocus
                    placeholder="保留必要上下文，明确哪些是客户原话，哪些尚待确认…"
                  />
                </Field>
                <div className="form-hint wide">
                  记录以当前登录身份保存，提交后保留原文。需要纠错时，请新增说明记录。
                </div>
              </>
            )}
            {error && (
              <p className="error wide" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="form-footer">
            <button type="button" disabled={busy} onClick={requestClose}>
              取消
            </button>
            <button className="primary" disabled={busy}>
              {busy ? '正在保存…' : '保存记录'}
              <Check size={16} />
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
