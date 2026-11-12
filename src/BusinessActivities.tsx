import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AtSign,
  ArrowRight,
  Check,
  FileText,
  Mail,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { api, HttpError } from './api';
import { Dialog } from './WorkspaceUI';
import { KnowledgeChanges } from './KnowledgeChanges';
import { MailComposer } from './MailComposer';
import { activityKindLabels } from './ActivitySettings';
import type { Customer, Person, Project, SessionInfo } from '../shared/domain';
import type { OutgoingMail } from '../shared/outgoing';
import {
  activityBaseField,
  collaborationAttachmentLimit,
  collaborationAttachmentTypes,
} from '../shared/business-activities';
import type {
  ActivityCollaborationMember,
  ActivityDetail,
  ActivityField,
  ActivityGenerationResult,
  ActivityMember,
  ActivitySource,
  ActivityTask,
  ActivityTaskMailDraft,
  ActivityValue,
  AssignedActivityTask,
  BusinessActivity,
  BusinessActivityType,
  CollaborationTaskAttachment as HandoffFile,
} from '../shared/business-activities';
import './business-activities.css';

const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
type ActivityIndexStatus = {
  originals: { state: string; record_count?: number; source_count?: number };
  graph: { state: string; error?: string | null; synced_at?: string | null };
  vector: { state: string; error?: string | null; source_count?: number; chunk_count?: number };
};
const indexStateLabels: Record<string, string> = {
  saved: '已保存',
  ready: '已就绪',
  not_synced: '尚未同步',
  pending: '待处理',
  queued: '待处理',
  syncing: '处理中',
  processing: '处理中',
  running: '处理中',
  failed: '失败',
  disabled: '未启用',
};
export function ActivityKnowledgeStatus({
  workspace,
  customerId,
  personId,
  projectId,
  revision = 0,
}: {
  workspace: string;
  customerId: string;
  personId?: string;
  projectId?: string;
  revision?: number;
}) {
  const [data, setData] = useState<ActivityIndexStatus | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setError('');
    const query = new URLSearchParams({
      ...(personId ? { person_id: personId } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    });
    const load = async () => {
      try {
        const next = await api<ActivityIndexStatus>(
          `/customers/${customerId}/activity-status?${query}`,
          { workspace, signal: c.signal },
        );
        if (c.signal.aborted) return;
        setData(next);
        if (
          [next.graph.state, next.vector.state].some((s) =>
            ['pending', 'queued', 'syncing', 'processing', 'running'].includes(s),
          )
        )
          timer = setTimeout(() => void load(), 5000);
      } catch (e) {
        if (!c.signal.aborted) setError(errorText(e));
      }
    };
    void load();
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [workspace, customerId, personId, projectId, revision, reload]);
  return (
    <div className="ba-status-strip" aria-label="原文与知识索引状态" aria-live="polite">
      {data ? (
        <>
          <span>
            原文{indexStateLabels[data.originals.state] || '状态未知'}
            {data.originals.source_count !== undefined
              ? ` · ${data.originals.source_count} 份`
              : ''}
          </span>
          <span className={data.vector.state === 'failed' ? 'failed' : ''}>
            向量{indexStateLabels[data.vector.state] || '状态未知'}
            {data.vector.chunk_count !== undefined ? ` · ${data.vector.chunk_count} 片段` : ''}
          </span>
          <span className={data.graph.state === 'failed' ? 'failed' : ''}>
            图谱{indexStateLabels[data.graph.state] || '状态未知'}
          </span>
          {(data.vector.error || data.graph.error) && (
            <span className="failed">{data.vector.error || data.graph.error}</span>
          )}
        </>
      ) : (
        !error && <span>正在读取知识状态…</span>
      )}
      {error && (
        <p className="error" role="alert">
          知识状态读取失败：{error}
        </p>
      )}
      <button
        className="icon-button"
        aria-label="刷新知识状态"
        onClick={() => setReload((n) => n + 1)}
      >
        <RefreshCw size={12} />
      </button>
    </div>
  );
}
export const activityTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '发生时间未提供';
export function activityValue(value: ActivityValue | undefined) {
  return value === null || value === undefined || value === ''
    ? '未识别到'
    : typeof value === 'boolean'
      ? value
        ? '是'
        : '否'
      : Array.isArray(value)
        ? value.join('、') || '未识别到'
        : String(value);
}
export function activitiesChanged(workspace: string, customerId?: string) {
  window.dispatchEvent(
    new CustomEvent('business-activities-changed', { detail: { workspace, customerId } }),
  );
}
export function useActivitiesChanged(workspace: string, refresh: () => void, customerId?: string) {
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ workspace: string; customerId?: string }>).detail;
      if (
        detail.workspace === workspace &&
        (!customerId || !detail.customerId || detail.customerId === customerId)
      )
        refresh();
    };
    window.addEventListener('business-activities-changed', listener);
    return () => window.removeEventListener('business-activities-changed', listener);
  }, [workspace, customerId, refresh]);
}

export function BusinessActivities({
  workspace,
  customerId,
  personId,
  projectId,
  canCreate = false,
  limit,
  onSourceRecords,
}: {
  workspace: string;
  customerId: string;
  personId?: string;
  projectId?: string;
  canCreate?: boolean;
  limit?: number;
  onSourceRecords?: (ids: string[]) => void;
}) {
  const [items, setItems] = useState<BusinessActivity[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useActivitiesChanged(workspace, refresh, customerId);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setNext(null);
    setBusy(true);
    setError('');
    const query = new URLSearchParams({
      customer_id: customerId,
      limit: String(limit || 20),
      ...(personId ? { person_id: personId } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    });
    api<{ items: BusinessActivity[]; next_cursor: string | null }>(`/activities?${query}`, {
      workspace,
      signal: controller.signal,
    })
      .then((page) => {
        setItems(page.items);
        setNext(page.next_cursor);
        setBusy(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorText(e));
          setBusy(false);
        }
      });
    return () => controller.abort();
  }, [workspace, customerId, personId, projectId, revision, limit]);
  useEffect(() => {
    onSourceRecords?.([
      ...new Set(
        items.flatMap((a) =>
          Object.values(a.field_provenance).flatMap((p) => p.evidence.map((e) => e.record_id)),
        ),
      ),
    ]);
  }, [items, onSourceRecords]);
  async function more() {
    if (!next || busy) return;
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({
        customer_id: customerId,
        cursor: next,
        limit: '20',
        ...(personId ? { person_id: personId } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      });
      const page = await api<{ items: BusinessActivity[]; next_cursor: string | null }>(
        `/activities?${query}`,
        { workspace },
      );
      setItems((old) => [...new Map([...old, ...page.items].map((a) => [a.id, a])).values()]);
      setNext(page.next_cursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ba-activities" aria-label="结构化活动">
      {!limit && (
        <div className="ba-toolbar">
          <h3>活动记录</h3>
          <div className="ba-button-row">
            <button
              className="icon-button"
              aria-label="刷新活动记录"
              disabled={busy}
              onClick={refresh}
            >
              <RefreshCw size={14} />
            </button>
            {canCreate && (
              <button className="primary" onClick={() => setCreating(true)}>
                <Sparkles size={14} />
                生成活动
              </button>
            )}
          </div>
        </div>
      )}
      {!limit && (
        <ActivityKnowledgeStatus
          workspace={workspace}
          customerId={customerId}
          personId={personId}
          projectId={projectId}
          revision={revision}
        />
      )}
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
      {busy && !items.length && (
        <p className="ba-empty" role="status">
          正在读取活动…
        </p>
      )}
      {!busy && !error && !items.length && (
        <p className="ba-empty">
          还没有结构化活动。{canCreate ? '选择已归档的微信或邮件，按已配置类型整理。' : ''}
        </p>
      )}
      {items.map((item) => (
        <button className="ba-activity-card" key={item.id} onClick={() => setSelected(item.id)}>
          <span className="ba-card-meta">
            <span className="ba-tag">{item.type_name}</span>
            <time>{activityTime(item.occurred_at)}</time>
          </span>
          <strong>{item.title}</strong>
          {item.summary && <span className="ba-card-summary">{item.summary}</span>}
          {!!item.missing_required_fields?.length && (
            <span className="ba-warning">部分必填信息待补充</span>
          )}
          <span className="ba-card-footer">
            <span>{item.project_id ? '项目活动' : '公司层级'}</span>
            <span>
              字段与原文 <ArrowRight size={12} />
            </span>
          </span>
        </button>
      ))}
      {!limit && next && (
        <button className="ba-load-more" disabled={busy} onClick={() => void more()}>
          {busy ? '加载中…' : '加载更多活动'}
        </button>
      )}
      {creating && (
        <GenerateActivitiesDialog
          workspace={workspace}
          customerId={customerId}
          personId={personId}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onGenerated={(result) => {
            setCreating(false);
            setNotice(
              result.activities.length
                ? `${result.reused ? '已读取同一请求的已有结果' : '已生成并保存'} ${result.activities.length} 条活动。`
                : '未识别到符合所选类型的活动，原文已保留。',
            );
            refresh();
          }}
        />
      )}
      {selected && (
        <ActivityDetailDialog
          workspace={workspace}
          activityId={selected}
          personId={personId}
          projectId={projectId}
          editable={canCreate}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </section>
  );
}

type SourceContext = {
  wechatQueryId?: string;
  mailId?: string;
  channel?: 'email' | 'wechat';
  personIds?: string[];
};
export function GenerateActivitiesDialog({
  workspace,
  customerId,
  personId,
  projectId,
  sourceContext,
  onClose,
  onGenerated,
}: {
  workspace: string;
  customerId: string;
  personId?: string;
  projectId?: string;
  sourceContext?: SourceContext;
  onClose: () => void;
  onGenerated: (result: ActivityGenerationResult) => void;
}) {
  const [types, setTypes] = useState<BusinessActivityType[]>([]);
  const [typeId, setTypeId] = useState('');
  const [sources, setSources] = useState<ActivitySource[]>([]);
  const [members, setMembers] = useState<ActivityMember[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState(projectId || '');
  const [handler, setHandler] = useState('');
  const [persons, setPersons] = useState<string[]>(
    personId ? [personId] : sourceContext?.personIds || [],
  );
  const [channel, setChannel] = useState(sourceContext?.channel || '');
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const pinned = !!(sourceContext?.wechatQueryId || sourceContext?.mailId);
  useEffect(() => {
    const c = new AbortController();
    setError('');
    setLoading(true);
    const loadPeople = async () => {
      const rows: Person[] = [];
      let page = 1;
      for (;;) {
        const result = await api<{ items: Person[]; total: number }>(
          `/people?customer_id=${customerId}&page=${page}`,
          { workspace, signal: c.signal },
        );
        rows.push(...result.items);
        if (!result.items.length || rows.length >= result.total) break;
        page++;
      }
      return rows;
    };
    Promise.all([
      api<BusinessActivityType[]>('/activity-types', { workspace, signal: c.signal }),
      api<ActivityMember[]>(`/activity-members?customer_id=${customerId}`, {
        workspace,
        signal: c.signal,
      }),
      loadPeople(),
      api<Project[]>(`/customers/${customerId}/projects`, { workspace, signal: c.signal }),
    ])
      .then(([definitions, nextMembers, nextPeople, nextProjects]) => {
        setTypes(definitions.filter((t) => !t.archived));
        setMembers(nextMembers);
        setPeople(nextPeople);
        setProjects(nextProjects.filter((p) => !p.archived_at));
        setLoading(false);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setError(errorText(e));
          setLoading(false);
        }
      });
    return () => c.abort();
  }, [workspace, customerId]);
  useEffect(() => {
    const c = new AbortController();
    setSourceLoading(true);
    setSelected([]);
    setError('');
    const query = new URLSearchParams({
      customer_id: customerId,
      ...(personId ? { person_id: personId } : {}),
      ...(project ? { project_id: project } : {}),
      ...(channel ? { channel } : {}),
      ...(sourceContext?.wechatQueryId ? { wechat_query_id: sourceContext.wechatQueryId } : {}),
      ...(sourceContext?.mailId ? { mail_id: sourceContext.mailId } : {}),
    });
    api<ActivitySource[]>(`/activity-sources?${query}`, { workspace, signal: c.signal })
      .then((rows) => {
        setSources(rows);
        if (pinned && rows.length <= 60) setSelected(rows.map((s) => s.id));
        setSourceLoading(false);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setError(errorText(e));
          setSources([]);
          setSourceLoading(false);
        }
      });
    return () => c.abort();
  }, [
    workspace,
    customerId,
    personId,
    project,
    channel,
    sourceContext?.wechatQueryId,
    sourceContext?.mailId,
    pinned,
  ]);
  const chosen = sources.filter((s) => selected.includes(s.id));
  const characters = chosen.reduce((n, s) => n + s.body.length, 0);
  const oversized = chosen.length > 60 || characters > 60000;
  async function generate() {
    if (busy || !typeId || !selected.length || oversized) return;
    setBusy(true);
    setError('');
    const body = {
      customer_id: customerId,
      project_id: project || null,
      type_id: typeId,
      source_ids: selected,
      linked_person_ids: persons,
      handler_id: handler || null,
    };
    const key = JSON.stringify(body);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    try {
      const result = await api<ActivityGenerationResult>('/activities/generate', {
        workspace,
        method: 'POST',
        body: { ...body, request_id: request.current.id },
      });
      activitiesChanged(workspace, customerId);
      onGenerated(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="从已有资料生成活动"
      className="ba-dialog ba-generate-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="ba-dialog-body">
        <p className="ba-muted ba-small">
          选择已有授权原文，AI 按活动结构整理并保存。不会重复读取微信，也不会自动派工或发送邮件。
        </p>
        {loading ? (
          <p role="status">正在读取活动类型与关联信息…</p>
        ) : (
          <div className="ba-form-grid">
            <label className="field">
              活动类型
              <select
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                disabled={busy}
                required
              >
                <option value="">请选择整理方式</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              关联项目
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                disabled={busy || !!projectId}
              >
                <option value="">公司层级 · 不指定项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              经办人
              <select value={handler} onChange={(e) => setHandler(e.target.value)} disabled={busy}>
                <option value="">未指定</option>
                {members.map((m) => (
                  <option key={m.actor_id} value={m.actor_id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              资料来源
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as '' | 'email' | 'wechat')}
                disabled={busy || pinned}
              >
                <option value="">微信和邮件</option>
                <option value="wechat">微信</option>
                <option value="email">邮件</option>
              </select>
            </label>
            <fieldset className="ba-person-picker">
              <legend>关联联系人，可留空</legend>
              <div>
                {people.map((p) => (
                  <label className="ba-check" key={p.id}>
                    <input
                      type="checkbox"
                      checked={persons.includes(p.id)}
                      disabled={busy || p.id === personId}
                      onChange={(e) =>
                        setPersons((old) =>
                          e.target.checked ? [...old, p.id] : old.filter((id) => id !== p.id),
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
              </div>
              <small>本批生成的活动会关联所选联系人；仅引用原文中提到的姓名不会自动关联。</small>
            </fieldset>
          </div>
        )}
        {!loading && !types.length && (
          <p className="ba-alert">还没有可用活动类型，请先在“设置 → 活动与 Schema”创建。</p>
        )}
        <div className="ba-toolbar">
          <strong>
            选择原文{' '}
            <small>
              {selected.length} 条 · {characters.toLocaleString()} 字符
            </small>
          </strong>
          <button
            disabled={busy || sourceLoading || !sources.length}
            onClick={() =>
              setSelected(selected.length ? [] : sources.slice(0, 60).map((s) => s.id))
            }
          >
            {selected.length ? '清除选择' : sources.length > 60 ? '选择前 60 条' : '选择全部'}
          </button>
        </div>
        {sourceLoading ? (
          <p role="status">正在读取原文…</p>
        ) : (
          <div className="ba-source-picker">
            {sources.map((s) => (
              <label className="ba-source-option" key={s.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  disabled={busy}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked ? [...old, s.id] : old.filter((id) => id !== s.id),
                    )
                  }
                />
                <span>
                  <span className="ba-source-heading">
                    {s.channel === 'email' ? <Mail size={13} /> : <MessageSquare size={13} />}
                    <strong>{s.title || s.speaker || '沟通原文'}</strong>
                    <time>{activityTime(s.occurred_at)}</time>
                  </span>
                  <span className="ba-source-text">{s.body}</span>
                  {!!s.activity_count && (
                    <small>已用于 {s.activity_count} 条活动；再次整理会检查已有来源</small>
                  )}
                </span>
              </label>
            ))}
            {!sources.length && (
              <p className="ba-empty">当前范围还没有已归属的微信或邮件原文。请先同步或关联资料。</p>
            )}
          </div>
        )}
        {sources.length >= 200 && !pinned && (
          <p className="ba-muted ba-small">
            当前显示最近 200 条来源。更早的微信可从已有日期批次进入整理。
          </p>
        )}
        {(sources.length > 60 || oversized) && (
          <p className={oversized ? 'ba-alert' : 'ba-muted ba-small'}>
            每次最多 60 条原消息、60000 字符，请明确分批选择；未选的原文不会在本次整理。
          </p>
        )}
        {error && (
          <p className="ba-alert" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p className="ba-notice" role="status">
            AI 正在识别事件、核对原文并保存，请保留此窗口；同一请求重试不会重复新增。
          </p>
        )}
      </div>
      <footer className="form-footer">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy || loading || sourceLoading || !typeId || !selected.length || oversized}
          onClick={() => void generate()}
        >
          <Sparkles size={14} />
          {busy ? '正在整理…' : '生成并保存活动'}
        </button>
      </footer>
    </Dialog>
  );
}

export function ActivityDetailDialog({
  workspace,
  activityId,
  personId,
  projectId,
  editable = true,
  onClose,
  onChanged,
}: {
  workspace: string;
  activityId: string;
  personId?: string;
  projectId?: string;
  editable?: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<ActivityDetail | null>(null);
  const [members, setMembers] = useState<ActivityMember[]>([]);
  const [actor, setActor] = useState('');
  const [maySend, setMaySend] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [personNames, setPersonNames] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [memberError, setMemberError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, ActivityValue>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [mailDraft, setMailDraft] = useState<{
    taskId: string;
    customer: Customer;
    recipient: Person | null;
    seed: ActivityTaskMailDraft;
    existing: OutgoingMail | null;
  } | null>(null);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    const c = new AbortController();
    setError('');
    setData(null);
    const query = new URLSearchParams({
      ...(personId ? { person_id: personId } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    });
    api<ActivityDetail>(`/activities/${activityId}?${query}`, { workspace, signal: c.signal })
      .then((detail) => {
        setData(detail);
        setDraft({ ...detail.values });
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorText(e));
      });
    api<SessionInfo>('/session', { signal: c.signal })
      .then((s) => {
        if (c.signal.aborted) return;
        setActor(s.actor.id);
      })
      .catch(() => {});
    setMaySend(false);
    api<{ can_send: boolean }>('/mail-sender-capability', { workspace, signal: c.signal })
      .then((capability) => {
        if (!c.signal.aborted) setMaySend(capability.can_send);
      })
      .catch(() => {});
    return () => c.abort();
  }, [workspace, activityId, personId, projectId, revision]);
  useEffect(() => {
    if (!data?.customer_id) return;
    const c = new AbortController();
    setMemberError('');
    api<ActivityMember[]>(`/activity-members?customer_id=${data.customer_id}`, {
      workspace,
      signal: c.signal,
    })
      .then(setMembers)
      .catch((e) => {
        if (!c.signal.aborted) setMemberError(errorText(e));
      });
    return () => c.abort();
  }, [workspace, data?.customer_id]);
  useEffect(() => {
    if (!data) return;
    const c = new AbortController();
    setCompanyName('');
    setProjectName('');
    setPersonNames([]);
    api<{ name: string }>(`/customers/${data.customer_id}`, { workspace, signal: c.signal })
      .then((row) => setCompanyName(row.name))
      .catch(() => {});
    if (data.project_id)
      api<Project[]>(`/customers/${data.customer_id}/projects`, { workspace, signal: c.signal })
        .then((rows) => setProjectName(rows.find((p) => p.id === data.project_id)?.name || ''))
        .catch(() => {});
    Promise.all(
      data.linked_person_ids.map((id) =>
        api<Person>(`/people/${id}`, { workspace, signal: c.signal }),
      ),
    )
      .then((rows) => setPersonNames(rows.map((p) => p.name)))
      .catch(() => {});
    return () => c.abort();
  }, [workspace, data?.customer_id, data?.project_id, data?.linked_person_ids.join(',')]);
  function displayField(f: ActivityField, value: ActivityValue | undefined) {
    if (f.id === activityBaseField.customer) return companyName || '当前公司';
    if (f.id === activityBaseField.project)
      return data?.project_id ? projectName || '关联项目' : '未指定项目';
    if (f.id === activityBaseField.handler && !value) return '未指定经办人';
    if (value === null || value === undefined || value === '')
      return data?.field_provenance[f.id]?.origin === 'manual' || !f.ai_enabled
        ? '未填写'
        : '未识别到';
    if (f.kind === 'actor_reference' && typeof value === 'string')
      return members.find((m) => m.actor_id === value)?.display_name || '工作空间成员';
    if (f.kind === 'timestamp' && typeof value === 'string' && Number.isFinite(Date.parse(value)))
      return activityTime(value);
    return activityValue(value);
  }
  async function saveFields() {
    if (!data || busy) return;
    const values: Record<string, ActivityValue> = {};
    for (const [id, value] of Object.entries(draft))
      if (JSON.stringify(value) !== JSON.stringify(data.values[id])) values[id] = value;
    if (!Object.keys(values).length) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/activities/${activityId}`, {
        workspace,
        method: 'PATCH',
        body: { version: data.version, values },
      });
      setEditing(false);
      setNotice('修改已保存，保留人工来源；原始微信和邮件不被改写。');
      activitiesChanged(workspace, data.customer_id);
      refresh();
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function openTaskMail(task: ActivityTask) {
    if (!data || !maySend || busy) return;
    setBusy(true);
    setError('');
    try {
      const seed = await api<ActivityTaskMailDraft>(
        `/activities/${activityId}/task-mail-draft/${task.id}`,
        { workspace },
      );
      if (seed.customer_id !== data.customer_id || seed.project_id !== data.project_id)
        throw new Error('交接附件与当前活动范围不一致，请刷新后重试');
      const [customer, existing] = await Promise.all([
        api<Customer>(`/customers/${seed.customer_id}`, { workspace }),
        api<OutgoingMail>(`/outgoing/${seed.draft_id}`, { workspace }).catch((e) => {
          if (e instanceof HttpError && e.status === 404) return null;
          throw e;
        }),
      ]);
      if (
        existing &&
        (existing.handoff_task_id !== task.id ||
          existing.customer_id !== seed.customer_id ||
          existing.project_id !== seed.project_id)
      )
        throw new Error('已保存邮件与当前交接项目不一致，请从客户档案打开该邮件核对');
      const person = existing
        ? existing.person_id
        : (personId ??
          (data.linked_person_ids.length === 1 ? data.linked_person_ids[0] : undefined));
      const recipient = person ? await api<Person>(`/people/${person}`, { workspace }) : null;
      if (recipient && (recipient.customer_id !== seed.customer_id || recipient.archived_at))
        throw new Error('关联联系人已归档或不属于当前客户，请核对后重试');
      setMailDraft({ taskId: task.id, customer, recipient, seed, existing });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function revokeTask(task: ActivityTask) {
    if (!data || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/task-collaborations/${task.id}/revoke`, {
        workspace,
        method: 'POST',
        body: { version: task.version },
      });
      setNotice('协作已撤回。');
      activitiesChanged(workspace, data.customer_id);
      refresh();
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        title={data?.title || '活动详情'}
        className="ba-dialog ba-detail-dialog"
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <div className="ba-dialog-body">
          {error && (
            <div className="ba-alert" role="alert">
              {error}
              <button disabled={busy} onClick={refresh}>
                重新读取
              </button>
            </div>
          )}
          {notice && (
            <p className="ba-notice" role="status">
              {notice}
            </p>
          )}
          {!data && !error && <p role="status">正在读取活动、字段与原文…</p>}
          {data && (
            <>
              <div className="ba-detail-meta">
                <span className="ba-tag">{data.type_name}</span>
                <time>{activityTime(data.occurred_at)}</time>
                <small>活动 ID：{data.id}</small>
              </div>
              <p className="ba-related-records">
                关联记录：{companyName || '当前公司'}
                {projectName ? ` / ${projectName}` : ''}
                {personNames.length ? ` / ${personNames.join('、')}` : ''}
              </p>
              <p className="ba-muted ba-small">
                公司与已关联联系人共用这一条活动；知识索引不会增加独立证据数量。
              </p>
              <ActivityKnowledgeStatus
                workspace={workspace}
                customerId={data.customer_id}
                personId={personId}
                projectId={projectId || data.project_id || undefined}
                revision={revision}
              />
              <div className="ba-toolbar">
                <h3>属性与依据</h3>
                {editable && data.can_edit && (
                  <div className="ba-button-row">
                    {editing ? (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => {
                            setEditing(false);
                            setDraft({ ...data.values });
                          }}
                        >
                          取消编辑
                        </button>
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => void saveFields()}
                        >
                          {busy ? '保存中…' : '保存修改'}
                        </button>
                      </>
                    ) : (
                      <button onClick={() => setEditing(true)}>
                        <Pencil size={13} />
                        编辑字段
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="ba-detail-fields">
                {data.fields.map((f) => {
                  const provenance = data.field_provenance[f.id];
                  const writable =
                    !f.system &&
                    !f.read_only &&
                    !['record_reference', 'actor_reference'].includes(f.kind);
                  return (
                    <div className="ba-detail-field" key={f.id}>
                      <div>
                        <strong>{f.name}</strong>
                        {f.inherited && (
                          <span className="ba-inline-source">
                            来自 {f.source_schema_name || 'Schema'}
                          </span>
                        )}
                        <small>
                          {provenance?.origin === 'manual'
                            ? '人工补充'
                            : provenance?.origin === 'ai'
                              ? 'AI 整理'
                              : '系统／关联信息'}
                        </small>
                      </div>
                      <div>
                        {editing && writable ? (
                          <ActivityValueInput
                            field={f}
                            value={draft[f.id] ?? null}
                            onChange={(value) => setDraft((old) => ({ ...old, [f.id]: value }))}
                          />
                        ) : (
                          <p
                            className={
                              data.values[f.id] == null || data.values[f.id] === ''
                                ? 'ba-muted'
                                : ''
                            }
                          >
                            {displayField(f, data.values[f.id])}
                          </p>
                        )}
                        {provenance?.explanation && (
                          <p className="ba-muted ba-small">{provenance.explanation}</p>
                        )}
                        {provenance?.origin === 'manual' &&
                          Object.hasOwn(data.ai_values, f.id) &&
                          JSON.stringify(data.ai_values[f.id]) !==
                            JSON.stringify(data.values[f.id]) && (
                            <p className="ba-muted ba-small">
                              原 AI 整理：{activityValue(data.ai_values[f.id])}
                            </p>
                          )}
                        {!!provenance?.evidence.length && (
                          <details className="ba-evidence">
                            <summary>原文依据 · {provenance.evidence.length} 处</summary>
                            {provenance.evidence.map((e, i) => {
                              const source = data.sources.find((s) => s.id === e.source_id);
                              return source ? (
                                <blockquote key={`${e.source_id}:${i}`}>
                                  <small>
                                    {source.speaker || source.title} ·{' '}
                                    {activityTime(source.occurred_at)}
                                  </small>
                                  <p>{e.quote}</p>
                                </blockquote>
                              ) : (
                                <p className="ba-muted" key={`${e.source_id}:${i}`}>
                                  来源已不可用或权限发生变化。
                                </p>
                              );
                            })}
                          </details>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <details className="ba-originals">
                <summary>
                  <FileText size={14} />
                  查看本活动引用的原文（{data.sources.length}）
                </summary>
                {data.sources.map((source) => (
                  <article key={source.id}>
                    <strong>{source.speaker || source.title}</strong>
                    <small>
                      {source.channel === 'email'
                        ? '邮件'
                        : source.channel === 'wechat'
                          ? '微信'
                          : '人工补充／处理结果'}{' '}
                      · {activityTime(source.occurred_at)}
                    </small>
                    <p>{source.body}</p>
                  </article>
                ))}
              </details>
              <section className="ba-comments">
                <h3>备注与跟进事项</h3>
                {data.comments.map((comment) => (
                  <article key={comment.id}>
                    <div>
                      <strong>
                        {members.find((m) => m.actor_id === comment.created_by)?.display_name ||
                          '工作空间成员'}
                      </strong>
                      <time>{activityTime(comment.created_at)}</time>
                    </div>
                    <p>{comment.body}</p>
                  </article>
                ))}
                {memberError && (
                  <p className="ba-alert" role="alert">
                    成员暂不可读取：{memberError}
                  </p>
                )}
                {editable && data.can_edit && (
                  <ActivityCommentForm
                    workspace={workspace}
                    activity={data}
                    members={members}
                    onSaved={() => {
                      refresh();
                      onChanged?.();
                    }}
                  />
                )}
              </section>
              {!!data.tasks.length && (
                <section className="ba-tasks-in-detail">
                  <h3>关联待办</h3>
                  {data.tasks.map((task) => (
                    <article key={task.id}>
                      <strong>{task.title}</strong>
                      <p className="ba-muted ba-small">
                        @
                        {task.assignee_display_name ||
                          members.find((m) => m.actor_id === task.assignee_id)?.display_name ||
                          '已分派成员'}{' '}
                        · {taskLabels[task.status]}
                        {task.due_date ? ` · ${task.due_date}` : ''}
                      </p>
                      {task.result && <p>{task.result}</p>}
                      {task.task_only && (
                        <div className="ba-task-result">
                          <strong>{task.revoked_at ? '协作已撤回' : '交接要求'}</strong>
                          <p>{task.collaboration_brief}</p>
                          {task.attachment && <p>交付文件 · {task.attachment.filename}</p>}
                        </div>
                      )}
                      {task.task_only && !task.revoked_at && editable && data.can_edit && (
                        <div className="ba-button-row">
                          <button disabled={busy} onClick={() => void revokeTask(task)}>
                            撤回协作
                          </button>
                          {task.attachment && task.status === 'completed' && maySend && (
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={() => void openTaskMail(task)}
                            >
                              <Mail size={14} />
                              带附件写邮件
                            </button>
                          )}
                          {task.attachment && task.status === 'completed' && !maySend && (
                            <span className="ba-muted ba-small">
                              由有发件权限的业务员核对并发送。
                            </span>
                          )}
                        </div>
                      )}
                      {task.assignee_id === actor && !task.revoked_at && (
                        <ActivityTaskActions
                          workspace={workspace}
                          task={task}
                          onChanged={() => {
                            refresh();
                            onChanged?.();
                          }}
                        />
                      )}
                    </article>
                  ))}
                </section>
              )}
              <div className="ba-knowledge">
                <h3>当前范围的知识状态与变化</h3>
                <KnowledgeChanges
                  key={revision}
                  workspace={workspace}
                  customerId={data.customer_id}
                  projectId={projectId || data.project_id || undefined}
                  personId={personId}
                />
              </div>
            </>
          )}
        </div>
      </Dialog>
      {mailDraft && (
        <MailComposer
          key={mailDraft.taskId}
          workspace={workspace}
          kind={mailDraft.recipient ? 'people' : 'customers'}
          person={
            mailDraft.recipient ?? {
              id: mailDraft.customer.id,
              customer_id: mailDraft.customer.id,
              customer_name: mailDraft.customer.name,
              name: mailDraft.customer.name,
              email: '',
            }
          }
          draftId={mailDraft.existing ? mailDraft.seed.draft_id : undefined}
          handoff={{
            taskId: mailDraft.taskId,
            draftId: mailDraft.seed.draft_id,
            projectId: mailDraft.seed.project_id,
            cc: mailDraft.seed.cc?.email ?? null,
            attachment: {
              name: mailDraft.seed.attachment.filename,
              content: mailDraft.seed.attachment.content_base64,
            },
          }}
          onClose={() => setMailDraft(null)}
          onChanged={() => onChanged?.()}
        />
      )}
    </>
  );
}

export function ActivityValueInput({
  field,
  value,
  onChange,
}: {
  field: ActivityField;
  value: ActivityValue;
  onChange: (value: ActivityValue) => void;
}) {
  if (field.kind === 'checkbox')
    return (
      <select
        aria-label={field.name}
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}
      >
        <option value="">未填写</option>
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  if (field.kind === 'select')
    return (
      <select
        aria-label={field.name}
        value={String(value || '')}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">未填写</option>
        {field.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  if (field.kind === 'multi_select')
    return (
      <div className="ba-multi-values">
        {field.options.map((option) => (
          <label className="ba-check" key={option}>
            <input
              type="checkbox"
              checked={Array.isArray(value) && value.includes(option)}
              onChange={(e) => {
                const current = Array.isArray(value) ? value : [];
                onChange(
                  e.target.checked ? [...current, option] : current.filter((v) => v !== option),
                );
              }}
            />
            {option}
          </label>
        ))}
      </div>
    );
  if (['number', 'currency', 'rating'].includes(field.kind))
    return (
      <input
        aria-label={field.name}
        type="number"
        step={field.kind === 'rating' ? '1' : 'any'}
        min={field.kind === 'rating' ? 1 : undefined}
        max={field.kind === 'rating' ? 5 : undefined}
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  if (field.kind === 'date')
    return (
      <input
        aria-label={field.name}
        type="date"
        value={typeof value === 'string' ? value.slice(0, 10) : ''}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  if (field.kind === 'timestamp')
    return (
      <input
        aria-label={field.name}
        type="datetime-local"
        value={
          typeof value === 'string' && Number.isFinite(Date.parse(value))
            ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16)
            : ''
        }
        onChange={(e) => onChange(e.target.value ? `${e.target.value}:00+08:00` : null)}
      />
    );
  return (
    <textarea
      aria-label={field.name}
      rows={3}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

function ActivityCommentForm({
  workspace,
  activity,
  members,
  onSaved,
}: {
  workspace: string;
  activity: BusinessActivity;
  members: ActivityMember[];
  onSaved: () => void;
}) {
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [taskOnly, setTaskOnly] = useState(false);
  const [brief, setBrief] = useState('');
  const [fileRequired, setFileRequired] = useState(false);
  const [ccActor, setCcActor] = useState('');
  const [collaborators, setCollaborators] = useState<ActivityCollaborationMember[]>([]);
  const [memberStatus, setMemberStatus] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [memberError, setMemberError] = useState('');
  const [memberRevision, setMemberRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (!taskOnly) return;
    const c = new AbortController();
    setMemberStatus('loading');
    setMemberError('');
    api<ActivityCollaborationMember[]>(
      `/activity-collaboration-members?customer_id=${activity.customer_id}`,
      { workspace, signal: c.signal },
    )
      .then((items) => {
        if (c.signal.aborted) return;
        setCollaborators(items);
        setMemberStatus('loaded');
      })
      .catch((e) => {
        if (c.signal.aborted) return;
        setCollaborators([]);
        setMemberStatus('idle');
        setMemberError(errorText(e));
      });
    return () => c.abort();
  }, [taskOnly, workspace, activity.customer_id, memberRevision]);
  const ready = taskOnly
    ? memberStatus === 'loaded' && !!assignee && !!title.trim() && !!brief.trim()
    : !!body.trim() && (!assignee || !!title.trim());
  async function save() {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    const input = {
      body: body.trim() || `已发起协作待办：${title.trim()}`,
      ...(assignee
        ? { assignee_id: assignee, task_title: title.trim(), ...(due ? { due_date: due } : {}) }
        : {}),
      ...(taskOnly
        ? {
            task_only: true,
            collaboration_brief: brief.trim(),
            attachment_required: fileRequired,
            ...(ccActor ? { mail_cc_actor_id: ccActor } : {}),
          }
        : {}),
    };
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    try {
      await api(`/activities/${activity.id}/comments`, {
        workspace,
        method: 'POST',
        body: { ...input, request_id: request.current.id },
      });
      setBody('');
      setAssignee('');
      setTitle('');
      setDue('');
      setTaskOnly(false);
      setBrief('');
      setFileRequired(false);
      setCcActor('');
      request.current = null;
      activitiesChanged(workspace, activity.customer_id);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ba-comment-form">
      <label className="field">
        交接范围
        <select
          value={taskOnly ? 'task' : 'customer'}
          onChange={(event) => {
            setTaskOnly(event.target.value === 'task');
            setAssignee('');
            setCcActor('');
            setMemberStatus('idle');
          }}
          disabled={busy}
        >
          <option value="customer">客户活动 · 面向已获客户授权的同事</option>
          <option value="task">仅共享交接要求 · 可指派任务协作成员</option>
        </select>
      </label>
      <label className="field">
        {taskOnly ? '内部备注，可空' : '补充说明'}
        <textarea
          rows={3}
          value={body}
          maxLength={4000}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
          placeholder="补充情况；只有你明确选择同事并填写跟进事项时，才生成待办。"
        />
      </label>
      <label className="field">
        <span>
          <AtSign size={13} />
          {taskOnly ? '选择协作人' : '交给同事跟进，可选'}
        </span>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={busy}>
          <option value="">{taskOnly ? '请选择协作人' : '仅保存备注'}</option>
          {(taskOnly ? collaborators : members.filter((m) => m.can_assign)).map((m) => (
            <option key={m.actor_id} value={m.actor_id}>
              @{m.display_name}
            </option>
          ))}
        </select>
      </label>
      {taskOnly && memberStatus === 'loading' && <p role="status">正在读取协作成员…</p>}
      {taskOnly && memberError && (
        <p className="ba-alert" role="alert">
          {memberError}{' '}
          <button onClick={() => setMemberRevision((n) => n + 1)}>重新读取成员</button>
        </p>
      )}
      {(assignee || taskOnly) && (
        <div className="ba-form-grid">
          <label className="field">
            具体跟进事项
            <input
              value={title}
              maxLength={500}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              required
              placeholder="明确需要做什么"
            />
          </label>
          <label className="field">
            截止日期，可空
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>
      )}
      {taskOnly ? (
        <>
          <label className="field">
            发给协作人的要求
            <textarea
              rows={3}
              value={brief}
              maxLength={4000}
              onChange={(e) => setBrief(e.target.value)}
              disabled={busy}
              placeholder="例如：根据确认的款式和人数整理尺码表，标明需单独核对的尺寸。"
            />
          </label>
          <label className="ba-handoff-checkbox">
            <input
              type="checkbox"
              checked={fileRequired}
              onChange={(e) => setFileRequired(e.target.checked)}
              disabled={busy}
            />
            完成时须提交文件
          </label>
          <label className="field">
            邮件默认抄送，可空
            <select value={ccActor} onChange={(e) => setCcActor(e.target.value)} disabled={busy}>
              <option value="">无默认抄送</option>
              {collaborators
                .filter((m) => m.can_receive_cc)
                .map((m) => (
                  <option key={m.actor_id} value={m.actor_id}>
                    {m.display_name}
                  </option>
                ))}
            </select>
          </label>
          <p className="ba-muted ba-small">
            协作人会收到上面的交接要求。选中的同事会以账号邮箱预填到后续邮件的抄送栏，发件人可以核对或修改。
          </p>
        </>
      ) : (
        <p className="ba-muted ba-small">提交后，所选同事可从待办打开这条活动。</p>
      )}
      {error && (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy || !ready} onClick={() => void save()}>
        {busy
          ? '提交中…'
          : taskOnly
            ? '发送协作待办'
            : assignee
              ? '保存备注并创建待办'
              : '保存备注'}
      </button>
    </div>
  );
}

export const taskLabels = { open: '待处理', in_progress: '处理中', completed: '已完成' };

async function readHandoffFile(file: File) {
  const extension = /\.(xlsx|csv|pdf)$/i.exec(file.name)?.[1]?.toLowerCase() as
    keyof typeof collaborationAttachmentTypes | undefined;
  if (!extension || !file.size || file.size > collaborationAttachmentLimit)
    throw new Error('请选择不超过 1 MB 的 XLSX、CSV 或 PDF 文件');
  const contentType = collaborationAttachmentTypes[extension];
  return new Promise<{ filename: string; content_type: string; content_base64: string }>(
    (resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve({
          filename: file.name,
          content_type: contentType,
          content_base64: String(reader.result).split(',')[1],
        });
      reader.onerror = () => reject(new Error('读取交付文件失败，请重新选择文件'));
      reader.readAsDataURL(file);
    },
  );
}

export function CollaborationTaskAttachment({
  workspace,
  task,
  onUnavailable,
}: {
  workspace: string;
  task: AssignedActivityTask;
  onUnavailable: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function download() {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const file = await api<HandoffFile>(`/task-collaborations/${task.id}/attachment`, {
        workspace,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const bytes = Uint8Array.from(atob(file.content_base64), (letter) => letter.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(errorText(e));
      if (e instanceof HttpError && [401, 403, 404].includes(e.status)) onUnavailable();
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  if (!task.attachment) return null;
  return (
    <div className="ba-task-result">
      <button disabled={busy} onClick={() => void download()}>
        {busy ? '读取文件中…' : `下载 ${task.attachment.filename}`}
      </button>
      {error && (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ActivityTaskActions({
  workspace,
  task,
  onChanged,
}: {
  workspace: string;
  task: AssignedActivityTask;
  onChanged: () => void;
}) {
  const [completing, setCompleting] = useState(false);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function update(status: 'in_progress' | 'completed') {
    if (busy || (status === 'completed' && (!result.trim() || (task.attachment_required && !file))))
      return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const attachment = status === 'completed' && file ? await readHandoffFile(file) : null;
      if (controller.signal.aborted) return;
      await api(`/tasks/${task.id}`, {
        workspace,
        method: 'PATCH',
        signal: controller.signal,
        body: {
          version: task.version,
          status,
          ...(status === 'completed' ? { result: result.trim() } : {}),
          ...(attachment ? { attachment } : {}),
        },
      });
      if (controller.signal.aborted) return;
      activitiesChanged(workspace, 'customer_id' in task ? task.customer_id : undefined);
      setCompleting(false);
      setFile(null);
      onChanged();
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(errorText(e));
      if (e instanceof HttpError && [401, 403, 404].includes(e.status)) onChanged();
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  if (task.status === 'completed') return null;
  return (
    <div className="ba-task-actions">
      {task.status === 'open' && (
        <button disabled={busy} onClick={() => void update('in_progress')}>
          开始处理
        </button>
      )}
      <button disabled={busy} onClick={() => setCompleting((v) => !v)}>
        <Check size={13} />
        填写结果并完成
      </button>
      {completing && (
        <div className="ba-task-complete">
          <label className="field">
            处理结果
            <textarea
              rows={3}
              value={result}
              maxLength={4000}
              onChange={(e) => setResult(e.target.value)}
              disabled={busy}
              placeholder="写明实际处理结果；完成待办不代表已经发信或作出公司承诺。"
            />
          </label>
          {task.task_only && (
            <label className="field">
              {task.attachment_required ? '交付文件，必填' : '交付文件，可选'}
              <input
                type="file"
                accept=".xlsx,.csv,.pdf"
                disabled={busy}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <small className="ba-muted">支持 XLSX、CSV 或 PDF，单个文件不超过 1 MB。</small>
            </label>
          )}
          <button
            className="primary"
            disabled={busy || !result.trim() || (!!task.attachment_required && !file)}
            onClick={() => void update('completed')}
          >
            {busy ? '保存中…' : '保存结果并完成'}
          </button>
        </div>
      )}
      {error && (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
