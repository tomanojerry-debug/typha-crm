import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  AtSign,
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  Ellipsis,
  Hash,
  HeartHandshake,
  LayoutGrid,
  Link2,
  Mail,
  PanelRight,
  Pencil,
  Phone,
  RefreshCw,
  UserRound,
} from 'lucide-react';
import { api } from './api';
import { BusinessActivities } from './BusinessActivities';
import { MailDialog, MailWorkspace } from './Mail';
import { CommunicationMetrics, EmailStrength, EmailTime } from './CommunicationMetrics';
import { AssociatedProjects } from './AssociatedProjects';
import { RecordRelations } from './Relationships';
import { EntityNotes, useNotesAvailable } from './Notes';
import { OutgoingPanel } from './MailComposer';
import { EmailAddress } from './EmailAddress';
import { Dialog, Popover, closeMenus } from './WorkspaceUI';
import type { Person } from '../shared/domain';
import type { MailPage } from '../shared/connections';
import type { Selection } from './Workbench';

type PersonTab = 'overview' | 'activity' | 'emails' | 'company' | 'memo' | 'notes' | 'relations';
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export function PersonRecord({
  person,
  workspace,
  refresh,
  busy,
  error,
  onSelect,
  onEdit,
  onCompose,
  onArchive,
  onRefresh,
  children,
}: {
  person: Person;
  workspace: string;
  refresh: number;
  busy: boolean;
  error: string;
  onSelect: (selection: Selection) => void;
  onEdit: () => void;
  onCompose: (draftId?: string) => void;
  onArchive: () => void;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const [tab, setTab] = useState<PersonTab>('overview');
  const [mail, setMail] = useState<MailPage | null>(null);
  const [mailError, setMailError] = useState('');
  const [reload, setReload] = useState(0);
  const [selectedMail, setSelectedMail] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const notesAvailable = useNotesAvailable(workspace);
  const editable = person.can_edit && !person.archived_at && !person.customer_archived_at;
  useEffect(() => {
    const controller = new AbortController();
    setMail(null);
    setMailError('');
    const query = new URLSearchParams({ customer_id: person.customer_id, person_id: person.id });
    api<MailPage>(`/mail/messages?${query}`, { workspace, signal: controller.signal })
      .then(setMail)
      .catch((e) => {
        if (e.name !== 'AbortError') setMailError(e.message);
      });
    return () => controller.abort();
  }, [workspace, person.customer_id, person.id, refresh, reload]);

  const openCompany = () => onSelect({ customerId: person.customer_id, full: true });
  const tabs = [
    { id: 'overview', label: '概览', icon: LayoutGrid },
    { id: 'activity', label: '活动', icon: Activity },
    { id: 'emails', label: '邮件', icon: Mail, count: mail?.total },
    { id: 'company', label: '公司', icon: Building2, count: 1 },
    { id: 'notes', label: '笔记', icon: FileText },
    { id: 'memo', label: '备注', icon: FileText, count: person.description ? 1 : 0 },
    { id: 'relations', label: '关联', icon: Link2 },
  ] as const;

  function sectionHeading(label: string, target: PersonTab, icon: ReactNode, count?: number) {
    return (
      <div className="person-section-heading">
        <button onClick={() => setTab(target)}>
          {icon}
          <h3>{label}</h3>
          {count !== undefined && <span className="person-count">{count}</span>}
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  function activityRows(limit?: number) {
    if (mailError)
      return (
        <p className="error" role="alert">
          {mailError}
        </p>
      );
    if (!mail)
      return (
        <p className="person-inline-empty" role="status">
          正在加载活动…
        </p>
      );
    if (!mail.items.length)
      return (
        <p className="person-inline-empty">
          <Activity size={16} />
          暂无邮件活动，往来邮件关联后会显示在这里。
        </p>
      );
    return (
      <div className="person-activity-list">
        {mail.items.slice(0, limit).map((item) => (
          <button key={item.id} onClick={() => setSelectedMail(item.id)}>
            <span className={`person-event-icon ${item.direction}`}>
              {item.direction === 'inbound' ? (
                <ArrowDownLeft size={14} />
              ) : (
                <ArrowUpRight size={14} />
              )}
            </span>
            <span className="person-activity-copy">
              <strong>{item.sender.map((s) => s.name || s.address).join(', ')}</strong>
              <span>
                {item.direction === 'inbound' ? '发来邮件' : '发出邮件'} · {item.subject}
              </span>
            </span>
            <EmailTime value={item.occurred_at} />
          </button>
        ))}
      </div>
    );
  }
  function note() {
    return (
      <div className="person-note-card">
        {person.description ? (
          <>
            <FileText size={15} />
            <p>{person.description}</p>
          </>
        ) : (
          <p className="person-inline-empty">
            <FileText size={16} />
            暂无备注，记录这位联系人的沟通偏好或背景。
          </p>
        )}
        {editable && (
          <button className="text-button" onClick={onEdit}>
            <Pencil size={12} />
            {person.description ? '编辑备注' : '添加备注'}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="person-workspace person-record">
      <header className="person-record-heading">
        <span className="person-avatar">
          <UserRound size={16} />
        </span>
        <h2>{person.name}</h2>
        {(person.archived_at || person.customer_archived_at) && (
          <span className="person-state">已归档 · 只读</span>
        )}
        {!person.can_edit && !person.archived_at && !person.customer_archived_at && (
          <span className="person-state">只读</span>
        )}
        <div className="person-heading-actions">
          {editable && (
            <button
              className="person-compose-button"
              onClick={() => {
                setTab('emails');
                onCompose();
              }}
              aria-label="发邮件"
              title="发邮件"
            >
              <Mail size={14} />
              <span>发邮件</span>
            </button>
          )}
          {editable && (
            <button onClick={onEdit} aria-label="编辑联系人" title="编辑联系人">
              <Pencil size={13} />
              <span>编辑联系人</span>
            </button>
          )}
          {person.can_edit && !person.customer_archived_at && (
            <Popover label="更多" icon={<Ellipsis size={14} />} className="person-more-actions">
              <button
                className="menu-item"
                disabled={busy}
                onClick={() => {
                  closeMenus();
                  if (person.archived_at) onArchive();
                  else setArchiving(true);
                }}
              >
                <Archive size={14} />
                {person.archived_at ? '恢复联系人' : '归档联系人'}
              </button>
              <p>归档后移出默认列表，历史记录保留，可随时恢复。</p>
            </Popover>
          )}
        </div>
      </header>
      {archiving && (
        <Dialog title="归档联系人" onClose={() => setArchiving(false)}>
          <div className="dialog-fields">
            <p>
              归档“{person.name}
              ”后，将从默认联系人列表隐藏并变为只读。邮件和历史记录会保留，可以从已归档列表恢复。
            </p>
            {person.is_primary && (
              <p>
                这位联系人是公司的主要联系人，归档也会清空公司主档案上的联系人姓名、邮箱和电话；恢复后会重新带回。
              </p>
            )}
            <p>尚未执行的发送任务会在发送前停止并要求重新确认。</p>
          </div>
          <footer className="form-footer">
            <button onClick={() => setArchiving(false)}>取消</button>
            <button
              onClick={() => {
                setArchiving(false);
                onArchive();
              }}
            >
              确认归档
            </button>
          </footer>
        </Dialog>
      )}
      <div className="person-record-grid">
        <section className="person-record-main">
          <div className="person-record-tabs" role="tablist" aria-label="联系人详情内容">
            {tabs.map(({ id, label, icon: Icon, ...rest }) => (
              <button
                key={id}
                role="tab"
                disabled={id === 'notes' && !notesAvailable}
                title={id === 'notes' && !notesAvailable ? '笔记服务尚未加载' : undefined}
                aria-selected={tab === id}
                id={`person-tab-${id}`}
                aria-controls={`person-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                  e.preventDefault();
                  const index = tabs.findIndex((t) => t.id === id);
                  const next =
                    e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? tabs.length - 1
                        : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                  setTab(tabs[next].id);
                  e.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next].focus();
                }}
              >
                <Icon size={13} />
                {label}
                {'count' in rest && rest.count !== undefined && (
                  <span className="person-count">{rest.count}</span>
                )}
              </button>
            ))}
          </div>
          <div
            className="person-record-body"
            role="tabpanel"
            id={`person-panel-${tab}`}
            aria-labelledby={`person-tab-${tab}`}
          >
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {tab === 'overview' && (
              <>
                <section className="person-highlights" aria-label="联系人摘要">
                  <div className="person-section-heading">
                    <h3>
                      <LayoutGrid size={14} />
                      摘要
                    </h3>
                  </div>
                  <div className="person-highlight-grid">
                    <div className="person-highlight">
                      <span>
                        关系强度（邮件）
                        <HeartHandshake size={13} />
                      </span>
                      <EmailStrength value={person.email_strength} />
                    </div>
                    <button className="person-highlight" onClick={() => setTab('emails')}>
                      <span>
                        最近邮件互动
                        <Clock3 size={13} />
                      </span>
                      <EmailTime value={person.last_email_at ?? mail?.items[0]?.occurred_at} />
                    </button>
                    <button className="person-highlight" onClick={openCompany}>
                      <span>
                        公司 / 客户
                        <Building2 size={13} />
                      </span>
                      <strong>
                        <Building2 size={13} />
                        {person.customer_name}
                      </strong>
                    </button>
                    <div className="person-highlight">
                      <span>
                        邮箱地址
                        <AtSign size={13} />
                      </span>
                      <EmailAddress
                        email={person.email}
                        editable={!!editable}
                        workspace={workspace}
                        path={`/people/${person.id}`}
                        version={person.version}
                        onCompose={() => {
                          setTab('emails');
                          onCompose();
                        }}
                        onSaved={onRefresh}
                      />
                    </div>
                    <div className="person-highlight">
                      <span>
                        电话号码
                        <Phone size={13} />
                      </span>
                      {person.phone ? (
                        <a href={`tel:${person.phone}`}>{person.phone}</a>
                      ) : (
                        <span className="person-placeholder">未填写电话</span>
                      )}
                    </div>
                    <div className="person-highlight">
                      <span>
                        职位
                        <BriefcaseBusiness size={13} />
                      </span>
                      <strong className={!person.job_title ? 'person-placeholder' : ''}>
                        {person.job_title || '未填写职位'}
                      </strong>
                    </div>
                  </div>
                </section>
                <section className="person-overview-section" aria-label="最近活动">
                  {sectionHeading('活动', 'activity', <Activity size={14} />)}
                  <BusinessActivities
                    workspace={workspace}
                    customerId={person.customer_id}
                    personId={person.id}
                    limit={3}
                  />
                  {activityRows(3)}
                  {!!mail?.items.length && (
                    <button className="person-view-all" onClick={() => setTab('activity')}>
                      查看全部
                      <ChevronRight size={12} />
                    </button>
                  )}
                </section>
                <section className="person-overview-section" aria-label="最近邮件">
                  {sectionHeading('邮件', 'emails', <Mail size={14} />, mail?.total)}
                  {mailError ? (
                    <p className="error" role="alert">
                      {mailError}
                    </p>
                  ) : !mail ? (
                    <p className="person-inline-empty" role="status">
                      正在加载邮件…
                    </p>
                  ) : mail.items.length ? (
                    <div className="person-email-preview">
                      {mail.items.slice(0, 3).map((item) => (
                        <button key={item.id} onClick={() => setSelectedMail(item.id)}>
                          <span className="person-event-icon">
                            <Mail size={13} />
                          </span>
                          <span className="person-preview-sender">
                            {item.sender.map((s) => s.name || s.address).join(', ')}
                          </span>
                          <span className="person-preview-subject">
                            <strong>{item.subject}</strong>
                            <span>{item.preview || item.body_notice || '无文本正文'}</span>
                          </span>
                          <EmailTime value={item.occurred_at} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="person-inline-empty">
                      <Mail size={16} />
                      暂无邮件往来
                    </p>
                  )}
                </section>
                <section className="person-overview-section" aria-label="联系人备注">
                  {sectionHeading(
                    '备注',
                    'memo',
                    <FileText size={14} />,
                    person.description ? 1 : 0,
                  )}
                  {note()}
                </section>
              </>
            )}
            {tab === 'activity' && (
              <section>
                <BusinessActivities
                  workspace={workspace}
                  customerId={person.customer_id}
                  personId={person.id}
                  canCreate={!!editable}
                />
                <div className="person-section-heading">
                  <h3>
                    <Activity size={14} />
                    邮件活动
                  </h3>
                  <button
                    className="icon-button"
                    aria-label="刷新活动"
                    onClick={() => setReload((v) => v + 1)}
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>
                {activityRows()}
                {!!mail?.items.length && (
                  <p className="person-activity-footnote">
                    显示最近 30 封邮件。
                    <button className="text-button" onClick={() => setTab('emails')}>
                      查看完整往来
                      <ChevronRight size={12} />
                    </button>
                  </p>
                )}
              </section>
            )}
            {tab === 'emails' && (
              <>
                <OutgoingPanel
                  workspace={workspace}
                  personId={person.id}
                  refresh={refresh}
                  onOpen={onCompose}
                />
                <MailWorkspace
                  workspace={workspace}
                  customerId={person.customer_id}
                  personId={person.id}
                  onSelect={onSelect}
                  onRefresh={onRefresh}
                  refreshVersion={refresh}
                />
              </>
            )}
            {tab === 'company' && (
              <section>
                <div className="person-section-heading">
                  <h3>
                    <Building2 size={14} />
                    所属公司 / 客户<span className="person-count">1</span>
                  </h3>
                </div>
                <button className="person-company-record" onClick={openCompany}>
                  <span className="person-company-avatar">
                    <Building2 size={20} />
                  </span>
                  <span>
                    <strong>{person.customer_name}</strong>
                    <small>
                      {person.customer_archived_at ? '已归档' : '查看公司档案、项目与完整往来'}
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              </section>
            )}
            {tab === 'notes' && (
              <EntityNotes
                workspace={workspace}
                customer={{ id: person.customer_id, name: person.customer_name }}
                person={{ id: person.id, name: person.name }}
                canCreate={!!editable}
              />
            )}
            {tab === 'memo' && (
              <section>
                <div className="person-section-heading">
                  <h3>
                    <FileText size={14} />
                    联系人备注
                  </h3>
                </div>
                {note()}
              </section>
            )}
            {tab === 'relations' && (
              <RecordRelations
                workspace={workspace}
                customerId={person.customer_id}
                object="people"
                id={person.id}
                editable={!!editable}
                onSelect={onSelect}
              />
            )}
          </div>
        </section>
        <aside className="person-record-sidebar" aria-label="联系人属性">
          <div className="person-sidebar-title">
            <PanelRight size={13} />
            详情
          </div>
          {tab === 'emails' && (
            <AssociatedProjects
              workspace={workspace}
              object="people"
              id={person.id}
              refresh={refresh}
              onSelect={onSelect}
              onManage={editable ? () => setTab('relations') : undefined}
            />
          )}
          <details className="person-properties" open>
            <summary>
              <ChevronDown size={13} />
              档案属性
            </summary>
            <dl>
              <div>
                <dt>
                  <UserRound size={13} />
                  姓名
                </dt>
                <dd>{person.name}</dd>
              </div>
              <div>
                <dt>
                  <AtSign size={13} />
                  邮箱
                </dt>
                <dd>
                  <EmailAddress
                    email={person.email}
                    editable={!!editable}
                    workspace={workspace}
                    path={`/people/${person.id}`}
                    version={person.version}
                    onCompose={() => {
                      setTab('emails');
                      onCompose();
                    }}
                    onSaved={onRefresh}
                  />
                </dd>
              </div>
              <div>
                <dt>
                  <Phone size={13} />
                  电话
                </dt>
                <dd>
                  {person.phone ? (
                    <a href={`tel:${person.phone}`}>{person.phone}</a>
                  ) : (
                    <span className="person-placeholder">未填写</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>
                  <FileText size={13} />
                  备注
                </dt>
                <dd>
                  {person.description ? (
                    <button
                      className="person-property-link person-description-preview"
                      onClick={() => setTab('memo')}
                    >
                      {person.description}
                    </button>
                  ) : editable ? (
                    <button className="person-property-link person-placeholder" onClick={onEdit}>
                      添加备注…
                    </button>
                  ) : (
                    <span className="person-placeholder">未填写</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>
                  <Building2 size={13} />
                  公司
                </dt>
                <dd>
                  <button className="person-property-link" onClick={openCompany}>
                    <Building2 size={13} />
                    {person.customer_name}
                  </button>
                </dd>
              </div>
              <div>
                <dt>
                  <BriefcaseBusiness size={13} />
                  职位
                </dt>
                <dd>{person.job_title || <span className="person-placeholder">未填写</span>}</dd>
              </div>
            </dl>
            <details className="person-more-properties">
              <summary>
                更多属性
                <ChevronRight size={12} />
              </summary>
              <dl>
                <div>
                  <dt>
                    <UserRound size={13} />
                    主要联系人
                  </dt>
                  <dd>{person.is_primary ? '是' : '否'}</dd>
                </div>
                <div>
                  <dt>
                    <Clock3 size={13} />
                    创建时间
                  </dt>
                  <dd>{date(person.created_at)}</dd>
                </div>
                <div>
                  <dt>
                    <Clock3 size={13} />
                    最近更新
                  </dt>
                  <dd>{date(person.updated_at)}</dd>
                </div>
                <div>
                  <dt>
                    <Hash size={13} />
                    记录编号
                  </dt>
                  <dd className="person-record-id">{person.id}</dd>
                </div>
              </dl>
            </details>
          </details>
          <CommunicationMetrics record={person} onOpen={() => setTab('emails')} />
        </aside>
      </div>
      {selectedMail && (
        <MailDialog
          workspace={workspace}
          id={selectedMail}
          onClose={() => setSelectedMail(null)}
          onSelect={onSelect}
        />
      )}
      {children}
    </div>
  );
}
