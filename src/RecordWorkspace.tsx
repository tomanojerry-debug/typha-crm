import { KnowledgeChanges } from './KnowledgeChanges';
import { BusinessActivities } from './BusinessActivities';
import { DocumentsWorkspace, DocumentUploadButton } from './Documents';
import { EntityNotes, useNotesAvailable } from './Notes';
import { RecordEvidence } from './RecordEvidence';
import { useEffect, useState } from 'react';
import { api } from './api';
import { MailDialog, MailWorkspace } from './Mail';
import { RecordRelations } from './Relationships';
import type { Selection } from './Workbench';
import type { MailMessage, MailPage } from '../shared/connections';
import { ArrowRight, Archive, FileText, History, Pencil, Plus, Users } from 'lucide-react';
import { activityItems } from '../shared/activity';
import {
  customerTypes,
  projectTypes,
  projectStages,
  recordKinds,
  type AuditEvent,
  type Customer,
  type CustomerRecord,
  type Project,
} from '../shared/domain';

const time = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
const actions: Record<string, string> = {
  insert: '创建了',
  update: '更新了',
  archive: '归档了',
  restore: '恢复了',
  delete: '移除了',
};
const entities: Record<string, string> = {
  list_entries: '清单进度',
  customers: '客户档案',
  projects: '项目',
  customer_records: '客户记录',
  customer_access: '访问授权',
  people: '联系人',
  relationship_edges: '对象关联',
  mail_messages: '邮件归属',
};

export function ActivityTimeline({
  records,
  audit,
  projects,
  person,
  projectId,
  limit,
  onProject,
  recordsOnly = false,
  workspace,
  customerId,
  personId,
  onSelect,
  editable = false,
}: {
  editable?: boolean;
  workspace?: string;
  customerId?: string;
  personId?: string;
  onSelect?: (s: Selection) => void;
  records: CustomerRecord[];
  audit: AuditEvent[];
  projects: Project[];
  person: (id: string | null) => string;
  projectId?: string;
  limit?: number;
  onProject?: (id: string) => void;
  recordsOnly?: boolean;
}) {
  const [filter, setFilter] = useState('all');
  const [structuredSourceIds, setStructuredSourceIds] = useState<string[]>([]);
  const [mails, setMails] = useState<MailMessage[]>([]),
    [mailError, setMailError] = useState(''),
    [selectedMail, setSelectedMail] = useState<string | null>(null),
    [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  useEffect(() => {
    setMails([]);
    setMailError('');
    if (!workspace || !customerId || recordsOnly) return;
    const c = new AbortController();
    const q = new URLSearchParams({ customer_id: customerId });
    if (personId) q.set('person_id', personId);
    if (projectId) q.set('project_id', projectId);
    api<MailPage>(`/mail/messages?${q}`, { workspace, signal: c.signal })
      .then((r) => setMails(r.items))
      .catch((e) => {
        if (e.name !== 'AbortError') setMailError(e.message);
      });
    return () => c.abort();
  }, [workspace, customerId, personId, projectId, recordsOnly]);
  const items = [
    ...activityItems(
      recordsOnly
        ? records
        : records.filter((r) => r.source_kind !== 'email' && !structuredSourceIds.includes(r.id)),
      recordsOnly
        ? []
        : audit.filter(
            (e) =>
              e.entity_type !== 'mail_messages' &&
              !(
                e.entity_type === 'customer_records' &&
                records.some((r) => r.source_kind === 'email' && r.id === e.entity_id)
              ),
          ),
      projectId,
    ),
    ...mails.map((mail) => ({
      type: 'mail' as const,
      id: `mail-${mail.id}`,
      date: mail.occurred_at,
      mail,
    })),
  ]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .filter(
      (item) =>
        filter === 'all' ||
        (filter === 'emails'
          ? item.type === 'mail'
          : filter === 'changes'
            ? item.type === 'event'
            : item.type === 'record' && (filter === 'records' || item.record.kind === filter)),
    );
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <div className="activity-timeline">
      {workspace && customerId && !recordsOnly && (
        <BusinessActivities
          workspace={workspace}
          customerId={customerId}
          personId={personId}
          projectId={projectId}
          canCreate={editable}
          limit={limit}
          onSourceRecords={setStructuredSourceIds}
        />
      )}
      {workspace && customerId && !limit && !recordsOnly && (
        <KnowledgeChanges
          workspace={workspace}
          customerId={customerId}
          projectId={projectId}
          personId={personId}
          onSelect={onSelect}
        />
      )}
      {mailError && (
        <p className="error" role="alert">
          {mailError}
        </p>
      )}
      {!limit && (
        <div className="activity-filters" aria-label="活动筛选">
          {Object.entries({
            all: '全部',
            ...(!recordsOnly && workspace ? { emails: '邮件' } : {}),
            ...(!recordsOnly && !personId ? { records: '业务记录', changes: '操作动态' } : {}),
            ...(!personId ? recordKinds : {}),
          }).map(([key, label]) => (
            <button
              key={key}
              className={filter === key ? 'current' : ''}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {shown.map((item) =>
        item.type === 'mail' ? (
          <article key={item.id} className="timeline-item timeline-mail">
            <span className="timeline-mail-icon">✉</span>
            <div>
              <header>
                <strong>{item.mail.sender.map((s) => s.name || s.address).join(', ')}</strong>
                <span>{item.mail.direction === 'inbound' ? '收到邮件' : '发出邮件'}</span>
                <time dateTime={item.date}>{time(item.date)}</time>
              </header>
              <button className="timeline-mail-link" onClick={() => setSelectedMail(item.mail.id)}>
                {item.mail.subject}
                <ArrowRight size={13} />
              </button>
              <p>{item.mail.preview || item.mail.body_notice || '无文本正文'}</p>
            </div>
          </article>
        ) : item.type === 'record' ? (
          <article key={item.id} className="timeline-item timeline-record">
            <FileText size={15} />
            <div>
              <header>
                <strong>{person(item.record.created_by)}</strong>
                <span>添加了{recordKinds[item.record.kind]}</span>
                <time dateTime={item.date}>{time(item.date)}</time>
              </header>
              {item.record.project_id && onProject ? (
                <button
                  className="timeline-relation"
                  onClick={() => onProject(item.record.project_id!)}
                >
                  {projects.find((p) => p.id === item.record.project_id)?.name || '关联项目'}
                  <ArrowRight size={11} />
                </button>
              ) : (
                !projectId && <span className="timeline-context">客户层级</span>
              )}
              <p>{item.record.body}</p>
              {workspace && customerId && (
                <button
                  className="timeline-mail-link"
                  onClick={() => setSelectedRecord(item.record.id)}
                >
                  查看记录与依据
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
          </article>
        ) : (
          <article key={item.id} className="timeline-item timeline-event">
            <History size={14} />
            <div>
              <header>
                <strong>{person(item.event.actor_id)}</strong>
                <span>
                  {actions[item.event.action] || '操作了'}
                  {entities[item.event.entity_type] || '记录'}
                </span>
                <time dateTime={item.date}>{time(item.date)}</time>
              </header>
              {item.event.entity_type === 'projects' &&
                projects.some((p) => p.id === item.event.entity_id) &&
                (onProject ? (
                  <button
                    className="timeline-relation"
                    onClick={() => onProject(item.event.entity_id)}
                  >
                    {projects.find((p) => p.id === item.event.entity_id)?.name}
                    <ArrowRight size={11} />
                  </button>
                ) : (
                  <span className="timeline-context">
                    {projects.find((p) => p.id === item.event.entity_id)?.name}
                  </span>
                ))}
            </div>
          </article>
        ),
      )}
      {!shown.length && (
        <p className="overview-empty">
          {filter === 'all'
            ? '这里还没有活动。新建记录，留下需求和后续进展。'
            : '当前筛选下没有活动。'}
        </p>
      )}
      {workspace && selectedMail && (
        <MailDialog
          workspace={workspace}
          id={selectedMail}
          onClose={() => setSelectedMail(null)}
          onSelect={onSelect}
        />
      )}
      {workspace && customerId && selectedRecord && (
        <RecordEvidence
          workspace={workspace}
          customerId={customerId}
          recordId={selectedRecord}
          onClose={() => setSelectedRecord(null)}
        />
      )}
      {workspace && !limit && !recordsOnly && (
        <p className="muted">活动显示最近 30 封邮件；完整往来请进入“邮件”。</p>
      )}
    </div>
  );
}

export function ProjectWorkspace({
  workspace,
  onSelect,
  customer,
  project,
  records,
  audit,
  full,
  person,
  busy,
  error,
  onRefresh,
  onCustomer,
  onRecord,
  onEdit,
  onChange,
}: {
  workspace: string;
  onSelect: (s: Selection) => void;
  customer: Customer;
  project: Project;
  records: CustomerRecord[];
  audit: AuditEvent[];
  full: boolean;
  person: (id: string | null) => string;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onCustomer: () => void;
  onRecord: () => void;
  onEdit: () => void;
  onChange: (patch: Record<string, unknown>, message: string) => void;
}) {
  const [tab, setTab] = useState('overview');
  const notesAvailable = useNotesAvailable(workspace);
  const editable = customer.can_edit && !customer.archived_at && !project.archived_at;
  const context = records.filter((r) => !r.project_id);
  const hints: Record<Project['type'], string> = {
    inquiry: '将款式、使用场景、数量和交期需求整理为记录，区分客户要求与待核实信息。',
    sample: '围绕版型、面料、尺码和试穿反馈追加记录，确认结果后再更新项目阶段。',
    custom: '将团体尺码表、数量、款式与交付要求写入记录，客户修改时保留新的确认信息。',
    purchase: '记录采购款式、数量与交付要求。价格、库存和产能需有有效依据后再确认。',
  };
  return (
    <div className={`detail-content project-workspace ${full ? 'customer-full' : ''}`}>
      <aside className="customer-profile">
        <span className="record-object-label">{projectTypes[project.type]}项目</span>
        <div className="detail-heading">
          <div className="grow">
            <h2>{project.name}</h2>
            <div className="detail-meta">
              {project.archived_at || customer.archived_at
                ? '已归档 · 只读'
                : !customer.can_edit
                  ? '只读权限'
                  : '关联客户下的独立项目'}
            </div>
          </div>
        </div>
        <button className="project-customer-link" onClick={onCustomer}>
          <Users size={14} />
          <span>{customer.name}</span>
          <ArrowRight size={13} />
        </button>
        <div className="detail-quick-actions">
          {editable && (
            <>
              <button className="primary" aria-label="新建记录 · 项目记录" onClick={onRecord}>
                <Plus size={14} />
                新建记录
              </button>
              <DocumentUploadButton
                workspace={workspace}
                customer={{ id: customer.id, name: customer.name }}
                project={{ id: project.id, name: project.name }}
                onUploaded={() => setTab('files')}
              />
              <button className="icon-button" aria-label="编辑项目" onClick={onEdit}>
                <Pencil size={14} />
              </button>
            </>
          )}
        </div>
        <dl className="contact-summary">
          <div>
            <dt>项目阶段</dt>
            <dd>
              {editable ? (
                <select
                  aria-label="更新项目阶段"
                  value={project.stage}
                  disabled={busy}
                  onChange={(e) => onChange({ stage: e.target.value }, '项目阶段已更新')}
                >
                  {Object.entries(projectStages).map(([k, v]) => (
                    <option value={k} key={k}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                projectStages[project.stage]
              )}
            </dd>
          </div>
          <div>
            <dt>负责人</dt>
            <dd>{person(project.owner_id)}</dd>
          </div>
          <div>
            <dt>项目类型</dt>
            <dd>{projectTypes[project.type]}</dd>
          </div>
          <div>
            <dt>目标日期</dt>
            <dd>{project.due_date || '待确定'}</dd>
          </div>
          <div>
            <dt>客户类型</dt>
            <dd>{customerTypes[customer.type]}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{time(project.created_at)}</dd>
          </div>
          <div>
            <dt>最近更新</dt>
            <dd>{time(project.updated_at)}</dd>
          </div>
        </dl>
        {customer.can_edit && !customer.archived_at && (
          <button
            className="project-archive text-button"
            disabled={busy}
            onClick={() =>
              onChange(
                { archived: !project.archived_at },
                project.archived_at ? '项目已恢复' : '项目已归档',
              )
            }
          >
            <Archive size={13} />
            {project.archived_at ? '恢复项目' : '归档项目'}
          </button>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={onRefresh}>刷新资料</button>
          </div>
        )}
      </aside>
      <section className="detail-panel">
        <div className="panel-top">
          <div className="tabs" aria-label="项目详情内容">
            {Object.entries({
              overview: '概览',
              records: '项目记录',
              activity: '活动',
              context: '客户背景',
              notes: '笔记',
              files: '文件',
              emails: '邮件',
              relations: '关联',
            }).map(([k, v]) => (
              <button
                className={tab === k ? 'current' : ''}
                key={k}
                disabled={k === 'notes' && !notesAvailable}
                title={k === 'notes' && !notesAvailable ? '笔记服务尚未加载' : undefined}
                onClick={() => setTab(k)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="detail-body">
          {tab === 'notes' && (
            <EntityNotes
              workspace={workspace}
              customer={{ id: customer.id, name: customer.name }}
              project={{ id: project.id, name: project.name }}
              canCreate={!!editable}
            />
          )}
          {tab === 'files' && (
            <DocumentsWorkspace
              workspace={workspace}
              customer={{ id: customer.id, name: customer.name }}
              project={{ id: project.id, name: project.name }}
              editable={!!editable}
              onSelect={onSelect}
            />
          )}
          {tab === 'emails' && (
            <MailWorkspace
              workspace={workspace}
              customerId={customer.id}
              projectId={project.id}
              onSelect={onSelect}
            />
          )}
          {tab === 'relations' && (
            <RecordRelations
              workspace={workspace}
              customerId={customer.id}
              object="projects"
              id={project.id}
              editable={!!editable}
              onSelect={onSelect}
            />
          )}
          {tab === 'overview' && (
            <>
              <div className="section-heading">
                <h2>需求与背景</h2>
                {editable && (
                  <button className="text-button" onClick={onEdit}>
                    <Pencil size={13} />
                    编辑
                  </button>
                )}
              </div>
              <p className="project-description">
                {project.description || '尚未填写项目说明，可补充已知需求和背景。'}
              </p>
              {!project.archived_at && !['completed', 'cancelled'].includes(project.stage) && (
                <div className="project-followup">
                  <span>跟进提示</span>
                  <p>
                    {project.stage === 'waiting_customer'
                      ? '等待客户答复后，在这个项目下记录确认内容，再更新进展。'
                      : hints[project.type]}
                  </p>
                  {editable && (
                    <button className="text-button" onClick={onRecord}>
                      记录最新进展
                      <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              )}
              <div className="section-heading overview-record-heading">
                <h2>最近活动</h2>
                <button className="text-button" onClick={() => setTab('activity')}>
                  查看全部
                  <ArrowRight size={13} />
                </button>
              </div>
              <ActivityTimeline
                workspace={workspace}
                customerId={customer.id}
                onSelect={onSelect}
                records={records}
                audit={audit}
                projects={[project]}
                projectId={project.id}
                person={person}
                limit={5}
              />
            </>
          )}
          {(tab === 'records' || tab === 'activity') && (
            <>
              <div className="section-heading">
                <div>
                  <h2>{tab === 'records' ? '项目记录' : '项目活动'}</h2>
                  <p>
                    仅此项目 · 从客户最近 100 条记录{tab === 'activity' ? '和 100 条操作历史' : ''}
                    中筛选
                  </p>
                </div>
                {editable && (
                  <button aria-label="新建记录 · 项目记录" onClick={onRecord}>
                    <Plus size={14} />
                    新建记录
                  </button>
                )}
              </div>
              <ActivityTimeline
                workspace={workspace}
                customerId={customer.id}
                onSelect={onSelect}
                key={tab}
                records={records}
                audit={audit}
                projects={[project]}
                projectId={project.id}
                person={person}
                editable={!!editable}
                recordsOnly={tab === 'records'}
              />
            </>
          )}
          {tab === 'context' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>客户背景</h2>
                  <p>客户层级的共用背景；不包含其他项目记录</p>
                </div>
                <button className="text-button" onClick={onCustomer}>
                  打开客户档案
                  <ArrowRight size={13} />
                </button>
              </div>
              <div className="relationship-summary">
                <div>
                  <span>所属客户</span>
                  <strong>{customer.name}</strong>
                </div>
                <div>
                  <span>联系人</span>
                  <strong>{customer.contact_name || '待补充'}</strong>
                </div>
                <div>
                  <span>客户负责人</span>
                  <strong>{person(customer.owner_id)}</strong>
                </div>
              </div>
              <ActivityTimeline
                workspace={workspace}
                customerId={customer.id}
                onSelect={onSelect}
                records={context}
                audit={[]}
                projects={[]}
                person={person}
                recordsOnly
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
