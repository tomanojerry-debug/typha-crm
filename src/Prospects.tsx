import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  LayoutList,
  PanelRight,
  Settings2,
  SlidersHorizontal,
  UserRound,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Table2,
  Trash2,
} from 'lucide-react';
import { customerTypes, sources, type Customer, type Member } from '../shared/domain';
import type { CustomerList } from '../shared/views';
import {
  prospectStages,
  prospectLifecycles,
  prospectOutcomes,
  prospectRequirementStatuses,
  prospectWaitingOn,
  type CreateProspect,
  type Prospect,
  type ProspectListResponse,
  type ProspectRequirement,
  type UpdateProspect,
} from '../shared/prospects';
import { api, HttpError } from './api';
import { Dialog, Popover, closeMenus } from './WorkspaceUI';
import { ResizableTable, ColumnResizeHandle, ExpandableCell } from './ResizableTable';
import { KanbanBoard, KanbanCard } from './KanbanBoard';
import { RecordCardField } from './RecordCardField';
import { RecordDrawer } from './RecordDrawer';
import { RecordEvidence } from './RecordEvidence';
import { ProspectIntake } from './ProspectIntake';
import { prospectsChanged } from './prospect-events';
import './prospects.css';

export type ProspectIntakeRequest = {
  customerId?: string;
  sourceRecordIds?: string[];
  sourceKind?: string;
};
export type ProspectWorkspaceSummary = {
  workspace: string;
  actorId: string;
  viewName: string;
  total: number | null;
  loading: boolean;
  full: boolean;
};
type Props = {
  workspace: string;
  actorId: string;
  members: Member[];
  admin: boolean;
  openId?: string | null;
  openRevision?: number;
  pendingIntake?: ProspectIntakeRequest | null;
  onIntakeConsumed: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onProject: (customerId: string, projectId: string, ask?: boolean) => void;
  onCustomer: (customerId: string) => void;
  onSummary?: (summary: ProspectWorkspaceSummary) => void;
};
type View = 'all' | 'mine' | 'today' | 'overdue' | 'closed';
const views: Record<View, string> = {
  all: '全部潜在客户',
  mine: '待我处理',
  today: '今日跟进',
  overdue: '已逾期',
  closed: '已结束',
};
const fields = {
  customer: '客户',
  stage: '咨询阶段',
  requirements: '未满足条件',
  waiting: '等谁提供',
  assignee: '谁来处理',
  date: '跟进日期',
} as const;
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
const openRequirements = (row: Prospect) =>
  row.requirements.filter((item) => !['satisfied', 'not_applicable'].includes(item.status));
const blankRequirement = (): ProspectRequirement => ({
  id: crypto.randomUUID(),
  title: '',
  status: 'missing',
  waiting_on: null,
  assignee_id: null,
  due_date: null,
  result: '',
  source_record_ids: [],
});
const cloneProspect = (row: Prospect) => structuredClone(row);
function useDisplay(key: string) {
  const validColumns = (value: unknown, defaults: string[]) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (name): name is string => typeof name === 'string' && Object.hasOwn(fields, name),
            ),
          ),
        ]
      : defaults;
  const read = () => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return {
        layout: value?.layout === 'cards' ? ('cards' as const) : ('table' as const),
        columns: validColumns(value?.columns, Object.keys(fields)),
        cardColumns: validColumns(value?.cardColumns, [
          'customer',
          'stage',
          'requirements',
          'assignee',
          'date',
        ]),
      };
    } catch {
      return {
        layout: 'table' as const,
        columns: Object.keys(fields),
        cardColumns: ['customer', 'stage', 'requirements', 'assignee', 'date'],
      };
    }
  };
  const [display, setDisplay] = useState(read);
  const update = (patch: Partial<typeof display>) => {
    const next = {
      ...display,
      ...(patch.layout ? { layout: patch.layout } : {}),
      ...(patch.columns
        ? display.layout === 'cards'
          ? { cardColumns: patch.columns }
          : { columns: patch.columns }
        : {}),
    };
    setDisplay(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // These are optional interface preferences.
    }
  };
  return {
    ...display,
    columns: display.layout === 'cards' ? display.cardColumns : display.columns,
    update,
  };
}

export function ProspectsWorkspace({
  workspace,
  actorId,
  members,
  admin,
  openId,
  openRevision,
  pendingIntake,
  onIntakeConsumed,
  onDirty,
  onBusy,
  onProject,
  onCustomer,
  onSummary,
}: Props) {
  const [view, setView] = useState<View>('all');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [stage, setStage] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<ProspectListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(openId || null);
  const [full, setFull] = useState(false);
  const [detail, setDetail] = useState<Prospect | null>(null);
  const [draft, setDraft] = useState<Prospect | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  const [intake, setIntake] = useState<ProspectIntakeRequest | null>(pendingIntake || null);
  const [intakeDirty, setIntakeDirty] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [reopenAcknowledged, setReopenAcknowledged] = useState(false);
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const display = useDisplay(`light-crm:prospects:${workspace}:${actorId}`);
  const memberName = (id: string | null) =>
    members.find((member) => member.actor_id === id)?.display_name || '未分配';
  const changed = Boolean(detail && draft && JSON.stringify(detail) !== JSON.stringify(draft));
  const reopeningWithDates = Boolean(
    detail?.lifecycle === 'closed' &&
    draft &&
    draft.lifecycle !== 'closed' &&
    openRequirements(draft).some((item) => item.due_date),
  );
  const dirty = changed || createDirty || intakeDirty;
  const busy = saving || intakeBusy;
  useEffect(() => {
    onSummary?.({
      workspace,
      actorId,
      viewName: views[view],
      total: result?.total ?? null,
      loading,
      full,
    });
  }, [onSummary, workspace, actorId, view, result?.total, loading, full]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    setSelectedId(openId || null);
    setFull(false);
    setEvidence(null);
    setCreateOpen(false);
    setCreateDirty(false);
    setIntakeDirty(false);
    setIntake(pendingIntake || null);
    setPending(null);
    setNotice('');
  }, [openId, openRevision]);
  useEffect(() => {
    if (pendingIntake) setIntake(pendingIntake);
  }, [pendingIntake]);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ view, page: String(page), q: query });
    if (type) params.set('type', type);
    if (stage) params.set('stage', stage);
    if (lifecycle && view !== 'closed') params.set('lifecycle', lifecycle);
    setLoading(true);
    setResult(null);
    setError('');
    void api<ProspectListResponse>(`/prospects?${params}`, {
      workspace,
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setResult(value);
        setLoading(false);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(errorText(reason));
        setLoading(false);
      });
    return () => controller.abort();
  }, [workspace, view, query, type, stage, lifecycle, page, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setDraft(null);
    setDetailError('');
    setAcknowledge(false);
    setReopenAcknowledged(false);
    setEvidence(null);
    if (!selectedId) {
      setDetailLoading(false);
      return () => controller.abort();
    }
    setDetailLoading(true);
    void api<Prospect>(`/prospects/${selectedId}`, { workspace, signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setDetail(value);
        setDraft(cloneProspect(value));
        setDetailLoading(false);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setDetailError(errorText(reason));
        setDetailLoading(false);
      });
    return () => controller.abort();
  }, [workspace, selectedId, revision, openRevision]);
  const reload = () => setRevision((value) => value + 1);
  function guard(action: () => void) {
    if (busy) return;
    if (dirty) setPending(() => action);
    else action();
  }
  function updateDraft(patch: Partial<Prospect>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    if (patch.lifecycle !== undefined || patch.requirements !== undefined)
      setReopenAcknowledged(false);
    setDetailError('');
  }
  function updateRequirement(id: string, patch: Partial<ProspectRequirement>) {
    if (!draft) return;
    updateDraft({
      requirements: draft.requirements.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
  }
  async function saveDetail() {
    if (!detail || !draft || busy || !changed) return;
    if (!draft.name.trim()) return setDetailError('请填写咨询名称');
    if (draft.requirements.some((item) => !item.title.trim()))
      return setDetailError('请填写每项待满足条件的名称');
    if (
      draft.requirements.some(
        (item) => ['satisfied', 'not_applicable'].includes(item.status) && !item.result.trim(),
      )
    )
      return setDetailError('条件标为已满足或不适用时，请记录实际结果或原因');
    if (draft.lifecycle === 'closed' && !draft.outcome)
      return setDetailError('结束咨询前，请选择实际结果');
    if (draft.lifecycle === 'closed' && openRequirements(draft).length && !acknowledge)
      return setDetailError('仍有未满足条件，请确认按当前状态结束');
    if (reopeningWithDates && !reopenAcknowledged)
      return setDetailError('重开前请核对保留条件的负责人和原跟进日期，并确认重新纳入待办');
    const input: UpdateProspect = {
      request_id: crypto.randomUUID(),
      version: detail.version,
      name: draft.name,
      owner_id: draft.owner_id,
      stage: draft.stage,
      lifecycle: draft.lifecycle,
      outcome: draft.lifecycle === 'closed' ? draft.outcome : null,
      outcome_reason: draft.outcome_reason,
      summary: draft.summary,
      requirements: draft.requirements,
      ...(draft.lifecycle === 'closed' ? { acknowledge_open_requirements: acknowledge } : {}),
    };
    setSaving(true);
    setDetailError('');
    try {
      const value = await api<Prospect>(`/prospects/${detail.id}`, {
        workspace,
        method: 'PATCH',
        body: input,
      });
      if (!alive.current || selection.current !== value.id) return;
      setDetail(value);
      setDraft(cloneProspect(value));
      setAcknowledge(false);
      setReopenAcknowledged(false);
      setNotice('咨询状态已保存');
      prospectsChanged(workspace);
      setRevision((current) => current + 1);
    } catch (reason) {
      if (alive.current) {
        setDetailError(errorText(reason));
        if (reason instanceof HttpError && [403, 404].includes(reason.status)) {
          setDetail(null);
          setDraft(null);
        } else if (reason instanceof HttpError && reason.status === 409) {
          // A source revision conflict must not leave a withdrawn source snapshot visible.
          try {
            const current = await api<Prospect>(`/prospects/${detail.id}`, { workspace });
            if (
              alive.current &&
              selection.current === current.id &&
              (!current.sources_valid || !current.can_edit)
            ) {
              setDetail(current);
              setDraft(cloneProspect(current));
            }
          } catch (readError) {
            if (
              alive.current &&
              readError instanceof HttpError &&
              [403, 404].includes(readError.status)
            ) {
              setDetail(null);
              setDraft(null);
            }
          }
        }
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  function fieldValue(row: Prospect, field: string) {
    const requirements = openRequirements(row);
    if (field === 'customer') return `${row.customer_name} · ${customerTypes[row.customer_type]}`;
    if (field === 'stage')
      return row.lifecycle === 'closed'
        ? row.outcome
          ? prospectOutcomes[row.outcome]
          : prospectLifecycles.closed
        : `${prospectStages[row.stage]}${row.lifecycle === 'paused' ? ' · 暂缓' : ''}`;
    if (field === 'requirements')
      return requirements.length
        ? `${requirements.length}项 · ${requirements[0].title || '条件待重新核对'}`
        : '暂无未满足条件';
    if (field === 'waiting')
      return (
        [...new Set(requirements.map((item) => item.waiting_on).filter(Boolean))]
          .map((waiting) => prospectWaitingOn[waiting!])
          .join('、') || '待明确'
      );
    if (field === 'assignee')
      return (
        [...new Set(requirements.map((item) => item.assignee_id || row.owner_id))]
          .map(memberName)
          .join('、') || memberName(row.owner_id)
      );
    if (field === 'date')
      return (
        requirements
          .map((item) => item.due_date)
          .filter((date): date is string => Boolean(date))
          .sort()[0] || '未约定'
      );
    return '';
  }
  function selectProspect(id: string, expand = false) {
    setSelectedId(id);
    setFull(expand);
  }
  function changeList(action: () => void) {
    guard(() => {
      closeMenus();
      action();
      setPage(1);
      setSelectedId(null);
      setFull(false);
    });
  }
  function openRelated(ask = false) {
    if (!detail || busy || changed) return;
    setSelectedId(null);
    setFull(false);
    onProject(detail.customer_id, detail.id, ask);
  }
  const selectedFields = Object.keys(fields).filter((field) => display.columns.includes(field));
  const selectedIndex = result?.items.findIndex((item) => item.id === selectedId) ?? -1;
  const activeFilters =
    Number(Boolean(type)) +
    Number(Boolean(stage)) +
    Number(Boolean(lifecycle && view !== 'closed'));

  const pageCount = result ? Math.max(1, Math.ceil(result.total / result.page_size)) : 1;
  return (
    <section
      className={`prospects-page work-area ${selectedId ? 'has-detail' : ''} ${full ? 'has-full-detail' : ''}`}
      aria-label="潜在客户资料库"
    >
      <div
        className="content prospects-records"
        aria-hidden={full || undefined}
        style={full ? { display: 'none' } : undefined}
      >
        <div className="view-heading">
          <Popover
            label={views[view]}
            icon={display.layout === 'table' ? <LayoutList size={15} /> : <Columns3 size={15} />}
            className="view-selector"
          >
            <p className="popover-caption">咨询视图 · 新老客户的每笔咨询</p>
            {Object.entries(views).map(([key, label]) => (
              <button
                className="menu-item"
                key={key}
                disabled={busy}
                onClick={() => changeList(() => setView(key as View))}
              >
                {label}
                {view === key && <Check size={13} />}
              </button>
            ))}
          </Popover>
          <Popover label="视图设置" icon={<Settings2 size={14} />} className="columns-popover">
            <div className="settings-layout">
              <span>显示方式</span>
              <button
                className={display.layout === 'table' ? 'current' : ''}
                disabled={busy}
                onClick={() => display.update({ layout: 'table' })}
              >
                <Table2 size={13} />
                表格
              </button>
              <button
                className={display.layout === 'cards' ? 'current' : ''}
                disabled={busy}
                onClick={() => display.update({ layout: 'cards' })}
              >
                <Columns3 size={13} />
                卡片
              </button>
            </div>
            <p className="popover-caption">显示方式与字段保存在本机</p>
          </Popover>
          <div className="view-heading-actions">
            <button
              disabled={busy}
              onClick={() =>
                guard(() => setIntake(detail ? { customerId: detail.customer_id } : {}))
              }
            >
              <Sparkles size={14} />
              从资料识别
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => guard(() => setCreateOpen(true))}
            >
              <Plus size={14} />
              新建记录
            </button>
          </div>
        </div>
        <div className="view-toolbar">
          <div className="toolbar-options">
            <Popover
              label={`筛选${activeFilters ? ` ${activeFilters}` : ''}`}
              icon={<SlidersHorizontal size={14} />}
              className="filter-popover prospects-filter-popover"
            >
              <label>
                客户类型
                <select
                  value={type}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    changeList(() => setType(value));
                  }}
                >
                  <option value="">全部类型</option>
                  {Object.entries(customerTypes).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                咨询阶段
                <select
                  value={stage}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    changeList(() => setStage(value));
                  }}
                >
                  <option value="">全部阶段</option>
                  {Object.entries(prospectStages).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {view !== 'closed' && (
                <label>
                  进展状态
                  <select
                    value={lifecycle}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value;
                      changeList(() => setLifecycle(value));
                    }}
                  >
                    <option value="">全部状态</option>
                    {Object.entries(prospectLifecycles).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  changeList(() => {
                    setType('');
                    setStage('');
                    setLifecycle('');
                  })
                }
              >
                清除筛选
              </button>
            </Popover>
            <Popover
              label={display.layout === 'table' ? '表格字段' : '卡片字段'}
              icon={display.layout === 'table' ? <Table2 size={13} /> : <Columns3 size={13} />}
              className="columns-popover column-visibility-popover card-fields-popover prospects-fields-popover"
            >
              <p className="popover-caption">咨询名称固定显示 · 其余字段本机保存</p>
              {Object.entries(fields).map(([key, label]) => (
                <label className="column-visibility-option" key={key}>
                  <input
                    type="checkbox"
                    checked={display.columns.includes(key)}
                    onChange={(event) =>
                      display.update({
                        columns: event.target.checked
                          ? [...display.columns, key]
                          : display.columns.filter((value) => value !== key),
                      })
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </Popover>
          </div>
          <label className="search">
            <Search size={13} />
            <input
              aria-label="搜索客户和咨询"
              placeholder="搜索客户或咨询…"
              maxLength={100}
              value={query}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                changeList(() => setQuery(value));
              }}
            />
          </label>
          <button
            className="icon-button"
            aria-label="刷新咨询"
            disabled={busy}
            onClick={() => guard(reload)}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {notice && (
          <p className="prospects-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button disabled={busy} onClick={() => guard(reload)}>
              重新读取
            </button>
          </div>
        )}
        <div className="workspace-body" aria-busy={loading}>
          {loading ? (
            <div className="table-loading" role="status">
              正在读取咨询…
            </div>
          ) : !result?.items.length && !error ? (
            <div className="empty">
              <UserRound size={30} />
              <h3>当前没有符合条件的咨询</h3>
              <p>新老客户的每笔咨询分别记录，可手工新建，也可从已关联资料识别需求。</p>
            </div>
          ) : result?.items.length ? (
            display.layout === 'table' ? (
              <ResizableTable
                className="record-table prospects-record-table"
                storageKey={`light-crm:view:${workspace}:${actorId}:prospects`}
                columns={[
                  { id: '_index', label: '序号', width: 36, fixed: true },
                  { id: 'name', label: '咨询名称', width: 230 },
                  ...selectedFields.map((id) => ({
                    id,
                    label: fields[id as keyof typeof fields],
                    width: id === 'customer' || id === 'requirements' ? 230 : 160,
                  })),
                  { id: '_spacer', label: '', width: 36, fixed: true, fill: true },
                ]}
              >
                <thead>
                  <tr>
                    <th className="row-number">#</th>
                    <th>
                      咨询名称
                      <ColumnResizeHandle columnId="name" />
                    </th>
                    {selectedFields.map((field) => (
                      <th key={field}>
                        {fields[field as keyof typeof fields]}
                        <ColumnResizeHandle columnId={field} />
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((row, index) => (
                    <tr
                      key={row.id}
                      className={selectedId === row.id ? 'selected' : ''}
                      onClick={() => guard(() => selectProspect(row.id))}
                    >
                      <td className="row-number">{(page - 1) * result.page_size + index + 1}</td>
                      <ExpandableCell label="咨询名称" className="cell-name">
                        <div className="record-name-cell">
                          <button
                            className="record-name"
                            onClick={(event) => {
                              event.stopPropagation();
                              guard(() => selectProspect(row.id, true));
                            }}
                          >
                            {row.name}
                          </button>
                          <button
                            className="preview-button"
                            aria-label={`预览${row.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              guard(() => selectProspect(row.id));
                            }}
                          >
                            <PanelRight size={14} />
                          </button>
                        </div>
                      </ExpandableCell>
                      {selectedFields.map((field) => (
                        <ExpandableCell
                          key={field}
                          label={fields[field as keyof typeof fields]}
                          className={`cell-${field}`}
                        >
                          {fieldValue(row, field)}
                        </ExpandableCell>
                      ))}
                      <td />
                    </tr>
                  ))}
                </tbody>
              </ResizableTable>
            ) : (
              <KanbanBoard aria-label="潜在客户卡片">
                {result.items.map((row) => (
                  <KanbanCard key={row.id} className={selectedId === row.id ? 'selected' : ''}>
                    <button
                      className="kanban-card-title"
                      onClick={() => guard(() => selectProspect(row.id))}
                      title={`预览${row.name}`}
                    >
                      <span className="kanban-card-identity">
                        <UserRound size={15} />
                      </span>
                      <span className="kanban-card-name">{row.name}</span>
                      <PanelRight className="kanban-card-preview" size={13} />
                    </button>
                    <div className="kanban-card-fields">
                      {selectedFields.map((field) => (
                        <RecordCardField
                          key={field}
                          fieldId={field}
                          label={fields[field as keyof typeof fields]}
                          kind={
                            field === 'customer'
                              ? 'company'
                              : field === 'assignee'
                                ? 'member'
                                : field === 'date'
                                  ? 'date'
                                  : field === 'stage'
                                    ? 'stage'
                                    : 'text'
                          }
                          value={fieldValue(row, field)}
                        >
                          {fieldValue(row, field)}
                        </RecordCardField>
                      ))}
                    </div>
                    {!row.sources_valid && (
                      <footer className="kanban-card-footer">
                        <span className="prospects-source-warning">来源需要重新核对</span>
                      </footer>
                    )}
                  </KanbanCard>
                ))}
              </KanbanBoard>
            )
          ) : null}
        </div>
        <footer className="table-footer">
          <span>
            {loading
              ? '加载中…'
              : `共 ${result?.total ?? '—'} 项 · 当前页 ${result?.items.length ?? 0} 项`}
            {display.layout === 'cards' && <span className="footer-detail"> · 卡片显示当前页</span>}
          </span>
          <div>
            <span>
              {page} / {pageCount}
            </span>
            <button
              className="icon-button"
              aria-label="上一页咨询"
              disabled={loading || busy || page <= 1}
              onClick={() =>
                guard(() => {
                  setPage((value) => value - 1);
                  setSelectedId(null);
                  setFull(false);
                })
              }
            >
              <ChevronLeft size={15} />
            </button>
            <button
              className="icon-button"
              aria-label="下一页咨询"
              disabled={loading || busy || page >= pageCount}
              onClick={() =>
                guard(() => {
                  setPage((value) => value + 1);
                  setSelectedId(null);
                  setFull(false);
                })
              }
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </footer>
      </div>
      {selectedId && (
        <RecordDrawer
          className="prospect-drawer"
          full={full}
          title="咨询详情"
          ariaLabel="客户咨询详情"
          expandLabel="展开完整咨询"
          busy={busy}
          onClose={() =>
            guard(() => {
              setSelectedId(null);
              setFull(false);
            })
          }
          onExpand={() => setFull(true)}
          previous={
            selectedIndex > 0
              ? () => guard(() => selectProspect(result!.items[selectedIndex - 1].id, full))
              : undefined
          }
          next={
            selectedIndex >= 0 && selectedIndex < (result?.items.length || 0) - 1
              ? () => guard(() => selectProspect(result!.items[selectedIndex + 1].id, full))
              : undefined
          }
        >
          <div className="detail-content prospects-detail">
            {notice && (
              <p className="prospects-notice" role="status">
                {notice}
              </p>
            )}
            <div className="detail-quick-actions prospects-detail-actions">
              {detail && (
                <button disabled={busy || changed} onClick={() => openRelated(true)}>
                  <Sparkles size={14} /> 分析这笔咨询
                </button>
              )}
            </div>
            {detailLoading && <p role="status">正在读取咨询详情…</p>}
            {detailError && (
              <div className="error" role="alert">
                {detailError}
                <button disabled={busy} onClick={() => guard(reload)}>
                  重新读取最新资料
                </button>
              </div>
            )}
            {detail && draft && (
              <>
                <div className="prospects-detail-title">
                  <div>
                    <span>
                      {customerTypes[detail.customer_type]} · {prospectLifecycles[detail.lifecycle]}
                    </span>
                    <h2>{detail.name}</h2>
                  </div>
                  <button
                    className="text-button"
                    disabled={busy || changed}
                    onClick={() => {
                      setSelectedId(null);
                      setFull(false);
                      onCustomer(detail.customer_id);
                    }}
                  >
                    {detail.customer_name}
                    <ArrowUpRight size={14} />
                  </button>
                </div>
                {!detail.sources_valid && (
                  <p className="prospects-source-warning" role="alert">
                    {detail.source_warning ||
                      '来源已经变化，请重新整理当前有效资料。旧摘要和条件内容已隐藏。'}
                  </p>
                )}
                <fieldset
                  className="prospects-editor"
                  disabled={!detail.can_edit || busy || !detail.sources_valid}
                >
                  <div className="prospects-form-grid">
                    <label>
                      咨询名称
                      <input
                        value={draft.name}
                        maxLength={120}
                        onChange={(event) => updateDraft({ name: event.target.value })}
                      />
                    </label>
                    <label>
                      负责人
                      <select
                        value={draft.owner_id || ''}
                        onChange={(event) => updateDraft({ owner_id: event.target.value || null })}
                      >
                        <option value="">未分配</option>
                        {members
                          .filter((member) => member.active)
                          .map((member) => (
                            <option key={member.actor_id} value={member.actor_id}>
                              {member.display_name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      咨询阶段
                      <select
                        value={draft.stage}
                        onChange={(event) =>
                          updateDraft({ stage: event.target.value as Prospect['stage'] })
                        }
                      >
                        {Object.entries(prospectStages).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      进展状态
                      <select
                        value={draft.lifecycle}
                        onChange={(event) => {
                          updateDraft({
                            lifecycle: event.target.value as Prospect['lifecycle'],
                            ...(event.target.value !== 'closed'
                              ? { outcome: null, outcome_reason: '' }
                              : {}),
                          });
                          setAcknowledge(false);
                        }}
                      >
                        {Object.entries(prospectLifecycles).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="prospects-wide">
                      需求与背景
                      <textarea
                        rows={3}
                        value={draft.summary}
                        maxLength={5000}
                        onChange={(event) => updateDraft({ summary: event.target.value })}
                        placeholder="记录本次咨询的已知需求，客户要求与本方确认分别表达。"
                      />
                    </label>
                  </div>
                  <div className="prospects-section-heading">
                    <div>
                      <h3>待满足条件</h3>
                      <p>明确还差什么、等谁提供、谁来处理和跟进日期。</p>
                    </div>
                    <button
                      onClick={() =>
                        updateDraft({ requirements: [...draft.requirements, blankRequirement()] })
                      }
                    >
                      <Plus size={14} /> 添加条件
                    </button>
                  </div>
                  {!draft.requirements.length && (
                    <p className="muted">
                      尚未记录条件。简单咨询可直接记录结果，不必经过所有阶段。
                    </p>
                  )}
                  <div className="prospects-requirements">
                    {draft.requirements.map((item, index) => (
                      <article className="prospects-requirement" key={item.id}>
                        <div className="prospects-requirement-top">
                          <span>{index + 1}</span>
                          <input
                            aria-label={`条件${index + 1}名称`}
                            value={item.title}
                            maxLength={300}
                            placeholder="例如：确认使用日期"
                            onChange={(event) =>
                              updateRequirement(item.id, { title: event.target.value })
                            }
                          />
                          <button
                            className="icon-button"
                            aria-label={`删除条件${index + 1}`}
                            onClick={() =>
                              updateDraft({
                                requirements: draft.requirements.filter(
                                  (value) => value.id !== item.id,
                                ),
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <div className="prospects-form-grid prospects-condition-fields">
                          <label>
                            当前状态
                            <select
                              value={item.status}
                              onChange={(event) =>
                                updateRequirement(item.id, {
                                  status: event.target.value as ProspectRequirement['status'],
                                })
                              }
                            >
                              {Object.entries(prospectRequirementStatuses).map(([key, label]) => (
                                <option key={key} value={key}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            等谁提供
                            <select
                              value={item.waiting_on || ''}
                              onChange={(event) =>
                                updateRequirement(item.id, {
                                  waiting_on: (event.target.value ||
                                    null) as ProspectRequirement['waiting_on'],
                                })
                              }
                            >
                              <option value="">待明确</option>
                              {Object.entries(prospectWaitingOn).map(([key, label]) => (
                                <option key={key} value={key}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            谁来处理
                            <select
                              value={item.assignee_id || ''}
                              onChange={(event) =>
                                updateRequirement(item.id, {
                                  assignee_id: event.target.value || null,
                                })
                              }
                            >
                              <option value="">随咨询负责人（{memberName(draft.owner_id)}）</option>
                              {members
                                .filter((member) => member.active)
                                .map((member) => (
                                  <option key={member.actor_id} value={member.actor_id}>
                                    {member.display_name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <label>
                            跟进日期
                            <input
                              type="date"
                              value={item.due_date || ''}
                              onChange={(event) =>
                                updateRequirement(item.id, { due_date: event.target.value || null })
                              }
                            />
                          </label>
                          <label className="prospects-wide">
                            处理结果／待补充说明
                            <textarea
                              rows={2}
                              value={item.result}
                              maxLength={3000}
                              placeholder="标为已满足或不适用时，请留下实际结果或原因。"
                              onChange={(event) =>
                                updateRequirement(item.id, { result: event.target.value })
                              }
                            />
                          </label>
                        </div>
                      </article>
                    ))}
                  </div>
                  {draft.lifecycle === 'closed' && (
                    <div className="prospects-outcome">
                      <div className="prospects-form-grid">
                        <label>
                          实际结果
                          <select
                            value={draft.outcome || ''}
                            onChange={(event) =>
                              updateDraft({
                                outcome: (event.target.value || null) as Prospect['outcome'],
                              })
                            }
                          >
                            <option value="">请选择结果</option>
                            {Object.entries(prospectOutcomes).map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          结果说明
                          <input
                            maxLength={2000}
                            value={draft.outcome_reason}
                            onChange={(event) =>
                              updateDraft({ outcome_reason: event.target.value })
                            }
                            placeholder="记录成交、未成交或解决咨询的实际情况"
                          />
                        </label>
                      </div>
                      {openRequirements(draft).length > 0 && (
                        <label className="prospects-acknowledge">
                          <input
                            type="checkbox"
                            checked={acknowledge}
                            onChange={(event) => setAcknowledge(event.target.checked)}
                          />
                          确认按当前状态结束，保留{openRequirements(draft).length}
                          项未满足条件及其历史 ，结束后从待办隐藏
                        </label>
                      )}
                      <p className="muted">
                        未完成条件保留，结束后从待办隐藏。结束咨询不会确认订单、收款或发信。
                      </p>
                    </div>
                  )}
                  {detail.lifecycle === 'closed' && draft.lifecycle !== 'closed' && (
                    <div className="prospects-outcome">
                      <h3>重新开始跟进</h3>
                      <p className="muted">
                        保留的未完成条件会以同一份业务状态重新显示在待办。请逐项核对负责人和跟进日期；
                        不会创建重复任务或恢复已取消的邮件排期。
                      </p>
                      {reopeningWithDates && (
                        <label className="prospects-acknowledge">
                          <input
                            type="checkbox"
                            checked={reopenAcknowledged}
                            onChange={(event) => setReopenAcknowledged(event.target.checked)}
                          />
                          我已核对负责人和原跟进日期，将这些未完成条件重新纳入待办
                        </label>
                      )}
                    </div>
                  )}
                  {detail.can_edit && (
                    <footer className="prospects-save">
                      <span>{changed ? '有未保存的修改' : `已保存 · 版本${detail.version}`}</span>
                      <div>
                        <button
                          disabled={!changed || busy}
                          onClick={() => {
                            setDraft(cloneProspect(detail));
                            setAcknowledge(false);
                            setReopenAcknowledged(false);
                            setDetailError('');
                          }}
                        >
                          放弃本次修改
                        </button>
                        <button
                          className="primary"
                          disabled={!changed || busy || (reopeningWithDates && !reopenAcknowledged)}
                          onClick={() => void saveDetail()}
                        >
                          <Save size={14} />
                          {saving ? '保存中…' : '保存记录'}
                        </button>
                      </div>
                    </footer>
                  )}
                </fieldset>
                <div className="prospects-section-heading">
                  <div>
                    <h3>关联资料与依据</h3>
                    <p>本次咨询与原项目共用沟通资料，原文入口继续保留。</p>
                  </div>
                  <button disabled={busy || changed} onClick={() => openRelated()}>
                    打开项目资料
                    <ArrowUpRight size={14} />
                  </button>
                </div>
                {detail.sources_valid && detail.source_refs.length > 0 ? (
                  <div className="prospects-sources">
                    {detail.source_refs.map((source) => (
                      <button key={source.record_id} onClick={() => setEvidence(source.record_id)}>
                        {source.title || '查看来源原文'}
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="muted">
                    {detail.sources_valid
                      ? '此笔咨询暂无已关联的来源，可从资料识别后明确关联。'
                      : '请在当前授权项目资料中核对有效来源。'}
                  </p>
                )}
              </>
            )}
          </div>
        </RecordDrawer>
      )}
      {evidence && detail && detail.sources_valid && (
        <RecordEvidence
          workspace={workspace}
          customerId={detail.customer_id}
          recordId={evidence}
          onClose={() => setEvidence(null)}
        />
      )}
      {createOpen && (
        <CreateProspectDialog
          workspace={workspace}
          members={members}
          admin={admin}
          onDirty={setCreateDirty}
          onBusy={setSaving}
          onClose={() =>
            guard(() => {
              setCreateOpen(false);
              setCreateDirty(false);
            })
          }
          onCreated={(row) => {
            setCreateOpen(false);
            setCreateDirty(false);
            selectProspect(row.id);
            setNotice('咨询记录已创建');
            prospectsChanged(workspace);
            reload();
          }}
        />
      )}
      {intake && (
        <Dialog
          title="AI整理咨询与跟进状态"
          className="prospect-intake-dialog"
          onClose={() =>
            guard(() => {
              setIntake(null);
              onIntakeConsumed();
            })
          }
        >
          <ProspectIntake
            workspace={workspace}
            {...intake}
            onDirty={setIntakeDirty}
            onBusy={setIntakeBusy}
            onClose={() =>
              guard(() => {
                setIntake(null);
                onIntakeConsumed();
              })
            }
            onCreated={(id) => {
              setIntake(null);
              onIntakeConsumed();
              selectProspect(id);
              prospectsChanged(workspace);
              reload();
            }}
          />
        </Dialog>
      )}
      {pending && (
        <Dialog title="咨询有未保存的修改" onClose={() => setPending(null)}>
          <p className="dialog-copy">继续后会放弃本次未保存输入，已保存的咨询和客户资料保留。</p>
          <footer className="form-footer">
            <button onClick={() => setPending(null)}>继续编辑</button>
            <button
              disabled={busy}
              onClick={() => {
                const action = pending;
                setPending(null);
                setDraft(detail ? cloneProspect(detail) : null);
                setCreateDirty(false);
                setIntakeDirty(false);
                action();
              }}
            >
              放弃修改并继续
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}

function CreateProspectDialog({
  workspace,
  members,
  admin,
  onClose,
  onCreated,
  onDirty,
  onBusy,
}: {
  workspace: string;
  members: Member[];
  admin: boolean;
  onClose: () => void;
  onCreated: (row: Prospect) => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [owner, setOwner] = useState('');
  const [newCustomer, setNewCustomer] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerType, setCustomerType] = useState<Customer['type']>('retail');
  const [source, setSource] = useState<Customer['source']>('store');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [customerNotice, setCustomerNotice] = useState('');
  const alive = useRef(true);
  const requestId = useRef(crypto.randomUUID());
  const priorPayload = useRef('');
  const dirty = Boolean(customerId || name || summary || owner || customerName || phone || email);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setDirectoryLoading(true);
    setDirectoryError('');
    void api<CustomerList>(
      `/customers?editable=true&sort=name&direction=asc&q=${encodeURIComponent(search)}`,
      { workspace, signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setCustomers((current) => [
            ...value.items,
            ...current.filter(
              (customer) =>
                customer.id === customerId && !value.items.some((item) => item.id === customer.id),
            ),
          ]);
          setDirectoryLoading(false);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setCustomers([]);
          setDirectoryError(errorText(reason));
          setDirectoryLoading(false);
        }
      });
    return () => controller.abort();
  }, [workspace, search, customerId]);
  async function saveCustomer() {
    if (busy || !customerName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const customer = await api<Customer>('/customers', {
        workspace,
        method: 'POST',
        body: { name: customerName, type: customerType, source, phone, email },
      });
      if (!alive.current) return;
      setCustomers((current) => [customer, ...current.filter((item) => item.id !== customer.id)]);
      setCustomerId(customer.id);
      setNewCustomer(false);
      setCustomerName('');
      setPhone('');
      setEmail('');
      setCustomerNotice('客户档案已保存；关闭本次窗口也会保留该档案。');
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function create() {
    if (busy || !customerId || !name.trim()) return;
    const payload = { customer_id: customerId, name, summary, owner_id: owner || null };
    const serialized = JSON.stringify(payload);
    if (priorPayload.current && priorPayload.current !== serialized)
      requestId.current = crypto.randomUUID();
    priorPayload.current = serialized;
    const input: CreateProspect = { request_id: requestId.current, ...payload };
    setBusy(true);
    setError('');
    try {
      const value = await api<Prospect>('/prospects', { workspace, method: 'POST', body: input });
      if (alive.current) onCreated(value);
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      title="新建记录 · 客户咨询"
      className="prospects-create-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="prospects-dialog-body">
        <p className="muted">已有合作客户也可以发起新咨询。同一客户的不同需求分别记录。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {customerNotice && (
          <p className="prospects-notice" role="status">
            <Check size={14} />
            {customerNotice}
          </p>
        )}
        <fieldset disabled={busy} className="prospects-editor">
          {!newCustomer ? (
            <>
              <label>
                所属客户 *
                <input
                  aria-label="搜索可编辑客户"
                  placeholder="搜索公司、工作室或个人名称…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <select
                aria-label="选择咨询客户"
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
              >
                <option value="">{directoryLoading ? '正在读取客户…' : '请选择客户'}</option>
                {customers
                  .filter((customer) => customer.can_edit && !customer.archived_at)
                  .map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name} · {customerTypes[customer.type]}
                    </option>
                  ))}
              </select>
              {directoryError && <p className="error">{directoryError}</p>}
              {admin && (
                <button className="text-button" onClick={() => setNewCustomer(true)}>
                  <Plus size={14} /> 明确新建客户档案
                </button>
              )}
            </>
          ) : (
            <div className="prospects-new-customer">
              <h3>新建客户档案</h3>
              <p className="muted">个人零售可直接使用个人名称，无须填写公司或手机号。</p>
              <div className="prospects-form-grid">
                <label>
                  客户名称 *
                  <input
                    value={customerName}
                    maxLength={120}
                    onChange={(event) => setCustomerName(event.target.value)}
                  />
                </label>
                <label>
                  客户类型
                  <select
                    value={customerType}
                    onChange={(event) => setCustomerType(event.target.value as Customer['type'])}
                  >
                    {Object.entries(customerTypes).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  来源
                  <select
                    value={source}
                    onChange={(event) => setSource(event.target.value as Customer['source'])}
                  >
                    {Object.entries(sources).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  联系电话 · 可选
                  <input
                    type="tel"
                    value={phone}
                    maxLength={60}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </label>
                <label>
                  邮箱 · 可选
                  <input
                    type="email"
                    value={email}
                    maxLength={254}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              </div>
              <div className="prospects-inline-actions">
                <button onClick={() => setNewCustomer(false)}>返回选择已有客户</button>
                <button disabled={!customerName.trim()} onClick={() => void saveCustomer()}>
                  保存客户档案并继续
                </button>
              </div>
            </div>
          )}
          <label>
            咨询名称 *
            <input
              autoComplete="off"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：冬季演出服数量与交期咨询"
            />
          </label>
          <label>
            已知需求
            <textarea
              rows={4}
              maxLength={5000}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="记录客户说了什么、还需要确认什么。可先留空，稍后补充。"
            />
          </label>
          <label>
            负责人 · 可选
            <select value={owner} onChange={(event) => setOwner(event.target.value)}>
              <option value="">未分配</option>
              {members
                .filter((member) => member.active)
                .map((member) => (
                  <option key={member.actor_id} value={member.actor_id}>
                    {member.display_name}
                  </option>
                ))}
            </select>
          </label>
        </fieldset>
      </div>
      <footer className="form-footer">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy || !customerId || !name.trim() || newCustomer}
          onClick={() => void create()}
        >
          {busy ? '保存中…' : '保存记录'}
        </button>
      </footer>
    </Dialog>
  );
}
