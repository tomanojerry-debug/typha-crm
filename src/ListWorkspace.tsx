import { ResizableTable, ColumnResizeHandle, ExpandableCell } from './ResizableTable';
import { useEffect, useState, useRef } from 'react';
import {
  Table2,
  Columns3,
  Plus,
  Settings2,
  SlidersHorizontal,
  ArrowDownUp,
  Search,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  X,
  Building2,
  UserRound,
  Folder,
  GripVertical,
  Check,
  MoreHorizontal,
  Pencil,
  Trash2,
  PanelRight,
} from 'lucide-react';
import { api } from './api';
import { Dialog, Popover, ViewSaveMenu, closeMenus } from './WorkspaceUI';
import { ListRecordPicker } from './ListRecordPicker';
import { KanbanBoard, KanbanCard } from './KanbanBoard';
import { RecordCardField } from './RecordCardField';
import type { Member } from '../shared/domain';
import { defaultView, type RecordList, type SavedView } from '../shared/views';
import {
  defaultListConfig,
  fieldTypes,
  stageColors,
  listOperators,
  type ListField,
  type ListConfig,
  type WorkflowEntry,
  type WorkflowResult,
  type FieldKind,
  type StageOption,
  type ListRule,
} from '../shared/list-workflow';
import type { Selection } from './Workbench';
import type { AskScope } from '../shared/ask';
import './lists.css';
const failure = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
const baseNames: Record<string, string> = {
  name: '记录',
  customer_name: '所属客户',
  email: '邮箱',
};
function cleanConfig(c: ListConfig, fields: ListField[]): ListConfig {
  const active = fields.filter((f) => !f.archived),
    ids = new Set(active.map((f) => f.id));
  const def = defaultListConfig(fields);
  return {
    ...c,
    columns: c.columns.filter((id) => Object.hasOwn(baseNames, id) || ids.has(id)),
    sort: c.sort === 'name' || ids.has(c.sort) ? c.sort : 'name',
    group_by: active.some((f) => f.id === c.group_by && f.kind === 'stage')
      ? c.group_by
      : def.group_by,
    filters: {
      ...c.filters,
      rules: c.filters.rules.filter((r) => r.field === 'name' || ids.has(r.field)),
    },
  };
}
export function ListWorkspace({
  list,
  tablePreferenceKey,
  workspace,
  members,
  views,
  initialView,
  onChanged,
  onSelect,
  onDirty,
  onRemember,
  onRename,
  refresh,
  onAskScope,
}: {
  list: RecordList;
  tablePreferenceKey: string;
  workspace: string;
  members: Member[];
  views: SavedView[];
  initialView?: SavedView;
  onChanged: () => void;
  onSelect: (v: Selection) => void;
  onDirty: (v: boolean) => void;
  onRemember: (id: string | null) => void;
  onRename: () => void;
  refresh: number;
  onAskScope?: (scope: Extract<AskScope, { kind: 'list' }> | null) => void;
}) {
  const [fields, setFields] = useState<ListField[]>([]),
    [config, setConfig] = useState<ListConfig | null>(null);
  const [layout, setLayout] = useState<'list' | 'board'>(initialView?.config.layout || 'list');
  const [query, setQuery] = useState(initialView?.config.query || ''),
    [page, setPage] = useState(1);
  const [baseline, setBaseline] = useState(''),
    [view, setView] = useState<SavedView | undefined>(initialView);
  const [result, setResult] = useState<WorkflowResult | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<
      'add' | 'field' | 'filters' | 'save' | 'rename' | 'remove' | null
    >(null),
    [editField, setEditField] = useState<ListField | undefined>();
  const [viewName, setViewName] = useState(''),
    [checked, setChecked] = useState<string[]>([]),
    [pending, setPending] = useState<(() => void) | null>(null);
  const [draftFilters, setDraftFilters] = useState<ListConfig['filters']>({
    match: 'all',
    rules: [],
  });
  const [columnQuery, setColumnQuery] = useState('');
  const allViews = views.filter((v) => v.list_id === list.id);
  const snapshot = JSON.stringify({ config, layout, query }),
    dirty = Boolean(config && baseline && snapshot !== baseline);
  const askSnapshot = JSON.stringify({ config, query, page, checked, items: result?.items });
  useEffect(() => {
    if (!config || !result || loading) {
      onAskScope?.(null);
      return;
    }
    onAskScope?.({
      kind: 'list',
      list_id: list.id,
      config,
      query,
      page,
      selected_ids: result.items
        .filter((r) => checked.includes(r.id))
        .map((r) =>
          list.object === 'customers'
            ? r.customer_id
            : list.object === 'people'
              ? r.person_id!
              : r.project_id!,
        ),
    });
  }, [list.id, askSnapshot, loading, onAskScope]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    const controller = new AbortController();
    api<ListField[]>(`/lists/${list.id}/fields`, { workspace, signal: controller.signal })
      .then((fs) => {
        setFields(fs);
        const next = cleanConfig(initialView?.config.list_config || defaultListConfig(fs), fs);
        const display = initialView?.config.layout === 'board' ? 'board' : 'list';
        setConfig(next);
        setLayout(display);
        setBaseline(
          JSON.stringify({
            config: next,
            layout: display,
            query: initialView?.config.query || '',
          }),
        );
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setError(failure(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [list.id, workspace]);
  useEffect(() => {
    if (!config) return;
    const controller = new AbortController();
    setLoading(true);
    setChecked([]);
    const timer = setTimeout(
      () =>
        api<WorkflowResult>(`/lists/${list.id}/browse`, {
          workspace,
          method: 'POST',
          body: { config, query, page },
          signal: controller.signal,
        })
          .then((r) => {
            setResult(r);
            setLoading(false);
            const last = Math.max(1, Math.ceil(r.total / r.page_size));
            if (page > last) setPage(last);
          })
          .catch((e) => {
            if (e.name !== 'AbortError') {
              setError(failure(e));
              setResult(null);
              setLoading(false);
            }
          }),
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [config, query, page, list.id, workspace, revision, refresh]);
  function change(patch: Partial<ListConfig>) {
    setConfig((c) => (c ? { ...c, ...patch } : c));
    setPage(1);
  }
  function openRecord(r: WorkflowEntry) {
    onSelect({
      customerId: r.customer_id,
      ...(r.project_id ? { projectId: r.project_id } : {}),
      ...(r.person_id ? { personId: r.person_id } : {}),
      full: true,
    });
  }
  function guard(action: () => void) {
    closeMenus();
    if (dirty) setPending(() => action);
    else action();
  }
  function choose(v?: SavedView) {
    guard(() => {
      const next = cleanConfig(v?.config.list_config || defaultListConfig(fields), fields),
        display = v?.config.layout === 'board' ? 'board' : 'list',
        q = v?.config.query || '';
      setConfig(next);
      setLayout(display);
      setQuery(q);
      setPage(1);
      setView(v);
      setBaseline(JSON.stringify({ config: next, layout: display, query: q }));
      onRemember(v?.id || null);
    });
  }
  async function saveView(asNew = false) {
    if (!config || busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<SavedView>(!asNew && view ? `/views/${view.id}` : '/views', {
        workspace,
        method: !asNew && view ? 'PATCH' : 'POST',
        body: {
          object: list.object,
          list_id: list.id,
          name: asNew ? viewName : view?.name || viewName,
          config: { ...defaultView(list.object), query, layout, list_config: config },
          ...(!asNew && view ? { version: view.version } : {}),
        },
      });
      setView(saved);
      setBaseline(snapshot);
      setDialog(null);
      onRemember(saved.id);
      onChanged();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  async function mutateView(remove = false) {
    if (!view || busy) return;
    setBusy(true);
    setError('');
    try {
      if (remove) {
        await api(`/views/${view.id}`, {
          workspace,
          method: 'DELETE',
          body: { version: view.version },
        });
        setView(undefined);
        onRemember(null);
      } else {
        const v = await api<SavedView>(`/views/${view.id}`, {
          workspace,
          method: 'PATCH',
          body: {
            object: list.object,
            list_id: list.id,
            name: viewName,
            config: view.config,
            version: view.version,
          },
        });
        setView(v);
      }
      onChanged();
      setDialog(null);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  const entrySaving = useRef(false);
  async function saveValue(r: WorkflowEntry, field: ListField, value: string | null) {
    if (
      entrySaving.current ||
      busy ||
      loading ||
      !r.can_edit ||
      value === (r.field_values[field.id] ?? null)
    )
      return;
    entrySaving.current = true;
    setBusy(true);
    setError('');
    try {
      const updated = await api<Pick<WorkflowEntry, 'id' | 'version' | 'field_values'>>(
        `/lists/${list.id}/entries/${r.id}`,
        {
          workspace,
          method: 'PATCH',
          body: { version: r.version, values: { [field.id]: value } },
        },
      );
      setResult((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.id === updated.id ? { ...item, ...updated } : item,
              ),
            }
          : prev,
      );
      setLoading(true);
      setRevision((n) => n + 1);
    } catch (e) {
      setError(failure(e));
      setLoading(true);
      setRevision((n) => n + 1);
    } finally {
      entrySaving.current = false;
      setBusy(false);
    }
  }
  async function setFieldArchived(f: ListField, archived: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<ListField>(`/lists/${list.id}/fields/${f.id}`, {
        workspace,
        method: 'PATCH',
        body: { version: f.version, archived },
      });
      const fs = fields.map((old) => (old.id === next.id ? next : old));
      setFields(fs);
      if (config) {
        const next = cleanConfig(config, fs);
        setConfig(next);
      }
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  async function removeEntries() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/lists/${list.id}/entries`, {
        workspace,
        method: 'DELETE',
        body: {
          entries: result?.items
            .filter((r) => checked.includes(r.id))
            .map((r) => ({
              customer_id: r.customer_id,
              project_id: r.project_id,
              person_id: r.person_id,
            })),
        },
      });
      setChecked([]);
      setRevision((n) => n + 1);
      onChanged();
      setDialog(null);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  const active = fields.filter((f) => !f.archived),
    groupField = active.find((f) => f.id === config?.group_by),
    names = { ...baseNames, ...Object.fromEntries(fields.map((f) => [f.id, f.name])) };
  const Icon =
    list.object === 'customers' ? Building2 : list.object === 'people' ? UserRound : Folder;
  function fieldValue(r: WorkflowEntry, f: ListField) {
    const v = r.field_values[f.id];
    if (!v) return <span className="wf-unset">未填写</span>;
    if (f.kind === 'stage') {
      const o = f.options.find((o) => o.id === v);
      return (
        <span className="wf-stage">
          <i style={{ background: stageColors[o?.color || 'gray'] }} />
          {o?.label || v}
        </span>
      );
    }
    if (f.kind === 'member')
      return members.find((m) => m.actor_id === v)?.display_name || '已停用成员';
    if (f.kind === 'currency')
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: f.currency,
        maximumFractionDigits: 2,
      }).format(Number(v));
    return v;
  }
  if (!config)
    return (
      <div className="wf-loading">
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : (
          '正在打开清单…'
        )}
      </div>
    );
  return (
    <section
      className={`list-workspace ${layout === 'board' ? 'is-board' : ''}`}
      aria-label={`${list.name}清单`}
    >
      <div className="wf-viewbar">
        <Popover
          label={view?.name || '全部记录'}
          icon={layout === 'board' ? <Columns3 size={15} /> : <Table2 size={15} />}
        >
          <p className="popover-caption">清单视图</p>
          <button className="menu-item" onClick={() => choose()}>
            全部记录{!view && <Check size={13} />}
          </button>
          {allViews.map((v) => (
            <button className="menu-item" key={v.id} onClick={() => choose(v)}>
              {v.config.layout === 'board' ? <Columns3 size={14} /> : <Table2 size={14} />} {v.name}
              {view?.id === v.id && <Check size={13} />}
            </button>
          ))}
        </Popover>
        <Popover label="视图设置" icon={<Settings2 size={14} />} className="wf-settings">
          <p className="popover-caption">展示方式</p>
          <div className="wf-segments">
            <button aria-pressed={layout === 'list'} onClick={() => setLayout('list')}>
              <Table2 size={14} />
              表格
            </button>
            <button aria-pressed={layout === 'board'} onClick={() => setLayout('board')}>
              <Columns3 size={14} />
              卡片
            </button>
          </div>
          {fields.some((f) => f.archived) && (
            <>
              <p className="popover-caption">已停用字段 · 数据保留</p>
              {fields
                .filter((f) => f.archived)
                .map((f) => (
                  <button
                    key={f.id}
                    disabled={busy}
                    className="menu-item"
                    onClick={() => void setFieldArchived(f, false)}
                  >
                    {f.name}
                    <span>恢复</span>
                  </button>
                ))}
            </>
          )}
          <button
            className="menu-item menu-separated"
            onClick={() => {
              closeMenus();
              setEditField(undefined);
              setDialog('field');
            }}
          >
            <Plus size={14} />
            创建字段
          </button>
        </Popover>
        {dirty && <span className="wf-unsaved">未保存</span>}
        <div className="wf-view-actions">
          <div className="wf-segments compact" role="group" aria-label="清单展示方式">
            <button
              aria-label="表格视图"
              aria-pressed={layout === 'list'}
              onClick={() => setLayout('list')}
            >
              <Table2 size={15} />
            </button>
            <button
              aria-label="卡片视图"
              aria-pressed={layout === 'board'}
              onClick={() => setLayout('board')}
            >
              <Columns3 size={15} />
            </button>
          </div>
          <ViewSaveMenu
            canUpdate={!!view}
            busy={busy}
            onSave={() => void saveView()}
            onSaveAs={() => {
              setViewName(
                view?.name ? `${view.name} 副本` : layout === 'board' ? '卡片视图' : '工作视图',
              );
              setDialog('save');
            }}
          />
          <Popover label="更多" icon={<MoreHorizontal size={14} />} className="wf-more">
            <button
              className="menu-item"
              onClick={() => {
                closeMenus();
                onRename();
              }}
            >
              重命名清单
            </button>
            {view && (
              <>
                <button
                  className="menu-item"
                  onClick={() => {
                    closeMenus();
                    setViewName(view.name);
                    setDialog('rename');
                  }}
                >
                  重命名视图
                </button>
                <button className="menu-item" disabled={busy} onClick={() => void mutateView(true)}>
                  删除此保存视图
                </button>
              </>
            )}
          </Popover>
          <button className="primary" onClick={() => setDialog('add')}>
            <Plus size={14} />
            添加到清单
          </button>
        </div>
      </div>
      <div className="wf-toolbar">
        <Popover
          label={config.sort === 'name' ? '排序' : `按${names[config.sort]}排序`}
          icon={<ArrowDownUp size={13} />}
        >
          <label className="wf-setting-label">
            排序字段
            <select
              aria-label="排序字段"
              value={config.sort}
              onChange={(e) => change({ sort: e.target.value })}
            >
              <option value="name">记录名称</option>
              {active.map((f) => (
                <option value={f.id} key={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="wf-setting-label">
            顺序
            <select
              aria-label="排序顺序"
              value={config.direction}
              onChange={(e) => change({ direction: e.target.value as 'asc' | 'desc' })}
            >
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
          </label>
        </Popover>
        <button
          className={config.filters.rules.length ? 'wf-filter-active' : ''}
          onClick={() => {
            setDraftFilters(structuredClone(config.filters));
            setDialog('filters');
          }}
        >
          <SlidersHorizontal size={13} />
          筛选{config.filters.rules.length > 0 && <span>{config.filters.rules.length}</span>}
        </button>
        {config.filters.rules.length > 0 && (
          <button
            className="icon-button"
            aria-label="清除清单筛选"
            onClick={() => change({ filters: { match: 'all', rules: [] } })}
          >
            <X size={13} />
          </button>
        )}
        <Popover
          label={layout === 'board' ? '卡片字段' : '表格字段'}
          icon={layout === 'board' ? <Columns3 size={13} /> : <Table2 size={13} />}
          className="wf-card-fields-popover wf-settings"
        >
          <p className="popover-caption">名称始终显示 · 随当前视图保存</p>
          <input
            aria-label="查找清单字段"
            placeholder="搜索字段…"
            value={columnQuery}
            onChange={(e) => setColumnQuery(e.target.value)}
          />
          {[
            ...config.columns,
            ...Object.keys(names).filter(
              (k) => !config.columns.includes(k) && !fields.some((f) => f.id === k && f.archived),
            ),
          ]
            .filter(
              (k) =>
                names[k]?.includes(columnQuery) &&
                (layout === 'list' || (k !== 'name' && k !== groupField?.id)),
            )
            .map((k) => (
              <div className="wf-column-option" key={k}>
                <label>
                  <input
                    type="checkbox"
                    checked={config.columns.includes(k)}
                    disabled={k === 'name'}
                    onChange={(e) =>
                      change({
                        columns: e.target.checked
                          ? [...config.columns, k]
                          : config.columns.filter((v) => v !== k),
                      })
                    }
                  />
                  {names[k]}
                </label>
                {layout === 'list' && config.columns.includes(k) && k !== 'name' && (
                  <>
                    <button
                      className="icon-button"
                      aria-label={`左移${names[k]}`}
                      disabled={config.columns.indexOf(k) <= 1}
                      onClick={() => {
                        const cols = [...config.columns],
                          i = cols.indexOf(k);
                        [cols[i - 1], cols[i]] = [cols[i], cols[i - 1]];
                        change({ columns: cols });
                      }}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`右移${names[k]}`}
                      disabled={config.columns.indexOf(k) === config.columns.length - 1}
                      onClick={() => {
                        const cols = [...config.columns],
                          i = cols.indexOf(k);
                        [cols[i + 1], cols[i]] = [cols[i], cols[i + 1]];
                        change({ columns: cols });
                      }}
                    >
                      <ArrowDown size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
        </Popover>
        <span className="wf-scope-note">进度仅属于此清单</span>
        <label className="wf-search">
          <Search size={13} />
          <input
            aria-label="搜索清单记录"
            value={query}
            placeholder="搜索记录…"
            maxLength={100}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {error && (
        <div className="wf-error error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => {
              setError('');
              setRevision((n) => n + 1);
            }}
          >
            重新加载
          </button>
        </div>
      )}
      {checked.length > 0 && (
        <div className="wf-selection">
          已选择 {checked.length} 条
          <button disabled={busy} onClick={() => setDialog('remove')}>
            从此清单移除
          </button>
          <button className="text-button" onClick={() => setChecked([])}>
            取消选择
          </button>
        </div>
      )}
      <div
        className={`wf-data ${layout === 'board' ? 'wf-board-scroll' : ''}`}
        aria-busy={loading || busy}
      >
        {layout === 'list' ? (
          <div className="wf-table-scroll">
            <ResizableTable
              key={`${list.id}:${view?.id || 'all'}`}
              storageKey={`${tablePreferenceKey}:list:${list.id}:${view?.id || 'all'}`}
              className="wf-table"
              columns={[
                { id: '_select', label: '选择', width: 34, fixed: true },
                ...config.columns.map((id) => ({
                  id,
                  label: names[id],
                  width:
                    id === 'name' ? 260 : id === 'email' ? 260 : id === 'customer_name' ? 220 : 180,
                })),
                { id: '_add', label: '添加字段', width: 160, fixed: true },
              ]}
            >
              <thead>
                <tr>
                  <th className="wf-check">
                    <input
                      aria-label="选择本页全部记录"
                      type="checkbox"
                      checked={Boolean(
                        result?.items.length && checked.length === result.items.length,
                      )}
                      onChange={(e) =>
                        setChecked(e.target.checked ? result?.items.map((r) => r.id) || [] : [])
                      }
                    />
                  </th>
                  {config.columns.map((id) => (
                    <th key={id}>
                      {Object.hasOwn(baseNames, id) ? (
                        <span>{names[id]}</span>
                      ) : (
                        <Popover
                          label={names[id]}
                          icon={<FieldIcon field={fields.find((f) => f.id === id)!} />}
                        >
                          <button
                            className="menu-item"
                            onClick={() => {
                              closeMenus();
                              setEditField(fields.find((f) => f.id === id));
                              setDialog('field');
                            }}
                          >
                            <Pencil size={13} />
                            编辑字段与选项
                          </button>
                          <button
                            className="menu-item"
                            onClick={() => {
                              closeMenus();
                              change({ sort: id });
                            }}
                          >
                            按此字段排序
                          </button>
                          <button
                            className="menu-item"
                            onClick={() => {
                              closeMenus();
                              change({ columns: config.columns.filter((c) => c !== id) });
                            }}
                          >
                            在此视图隐藏
                          </button>
                          <button
                            className="menu-item"
                            disabled={busy}
                            onClick={() => {
                              closeMenus();
                              void setFieldArchived(
                                fields.find((f) => f.id === id)!,
                                true,
                              );
                            }}
                          >
                            停用字段（保留数据）
                          </button>
                        </Popover>
                      )}
                      <ColumnResizeHandle columnId={id} />
                    </th>
                  ))}
                  <th className="wf-add-column">
                    <button
                      onClick={() => {
                        setEditField(undefined);
                        setDialog('field');
                      }}
                    >
                      <Plus size={14} />
                      添加字段
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result?.items.map((r) => (
                  <tr key={r.id}>
                    <td className="wf-check">
                      <input
                        aria-label={`选择${r.name}`}
                        type="checkbox"
                        checked={checked.includes(r.id)}
                        onChange={(e) =>
                          setChecked((p) =>
                            e.target.checked ? [...p, r.id] : p.filter((id) => id !== r.id),
                          )
                        }
                      />
                    </td>
                    {config.columns.map((id) => (
                      <ExpandableCell key={id} label={names[id]}>
                        {id === 'name' ? (
                          <button className="wf-record-name" onClick={() => openRecord(r)}>
                            <Icon size={15} />
                            <span>{r.name}</span>
                            <span className="wf-open">↗</span>
                          </button>
                        ) : id === 'customer_name' ? (
                          <button
                            className="wf-record-name"
                            onClick={() => onSelect({ customerId: r.customer_id, full: true })}
                          >
                            {r.customer_name}
                          </button>
                        ) : id === 'email' ? (
                          <span className="wf-static">{r.email || '—'}</span>
                        ) : (
                          <ValueEditor
                            key={`${r.id}:${id}:${r.version}`}
                            field={fields.find((f) => f.id === id)!}
                            value={r.field_values[id] || ''}
                            members={members}
                            disabled={!r.can_edit || busy || loading}
                            label={`${r.name}的${names[id]}`}
                            onSave={(v) =>
                              void saveValue(
                                r,
                                fields.find((f) => f.id === id)!,
                                v,
                              )
                            }
                          />
                        )}
                      </ExpandableCell>
                    ))}
                    <td />
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td>{loading ? '加载中…' : `${result?.total || 0} 条记录`}</td>
                  {config.columns.slice(1).map((id) => (
                    <td key={id}>
                      {result?.sums[id] !== undefined
                        ? new Intl.NumberFormat('zh-CN', {
                            style: 'currency',
                            currency: fields.find((f) => f.id === id)?.currency || 'CNY',
                            maximumFractionDigits: 2,
                          }).format(Number(result.sums[id]))
                        : ''}
                    </td>
                  ))}
                  <td />
                </tr>
              </tfoot>
            </ResizableTable>
            {!loading && !result?.items.length && (
              <div className="wf-empty">
                <Table2 size={28} />
                <h3>
                  {query || config.filters.rules.length ? '没有符合条件的记录' : '还没有清单记录'}
                </h3>
                <p>
                  {query || config.filters.rules.length
                    ? '调整筛选条件或搜索内容。'
                    : '从资料库选择客户，开始跟进这个业务流程。'}
                </p>
                <button onClick={() => setDialog('add')}>
                  <Plus size={14} />
                  添加到清单
                </button>
              </div>
            )}
          </div>
        ) : (
          <KanbanBoard aria-label={`${list.name}清单卡片`}>
            {result?.items.map((r) => (
              <KanbanCard key={r.id}>
                <button
                  className="kanban-card-title"
                  onClick={() => openRecord(r)}
                  title={`打开${r.name}`}
                >
                  <span className="kanban-card-identity">
                    <Icon size={15} />
                  </span>
                  <span className="kanban-card-name">{r.name}</span>
                  <PanelRight className="kanban-card-preview" size={13} />
                </button>
                <div className="kanban-card-fields">
                  {config.columns
                    .filter((id) => id !== 'name' && id !== groupField?.id)
                    .map((id) => {
                      const field = fields.find((field) => field.id === id);
                      const value = Object.hasOwn(baseNames, id)
                        ? id === 'email'
                          ? r.email
                          : r.customer_name
                        : r.field_values[id];
                      return (
                        <RecordCardField
                          key={id}
                          fieldId={id}
                          label={names[id]}
                          kind={field?.kind}
                          value={value}
                        >
                          {Object.hasOwn(baseNames, id)
                            ? id === 'email'
                              ? r.email || '—'
                              : r.customer_name
                            : fieldValue(r, field!)}
                        </RecordCardField>
                      );
                    })}
                </div>
                {groupField && (
                  <div className="kanban-card-footer">
                    <ValueEditor
                      field={groupField}
                      value={r.field_values[groupField.id] || ''}
                      members={members}
                      disabled={!r.can_edit || busy || loading}
                      label={`更新${r.name}的${groupField.name}`}
                      onSave={(v) => void saveValue(r, groupField, v)}
                    />
                  </div>
                )}
              </KanbanCard>
            ))}
            {!loading && !result?.items.length && (
              <div className="kanban-empty">
                <span>
                  {query || config.filters.rules.length ? '没有符合条件的记录' : '还没有清单记录'}
                </span>
                {query || config.filters.rules.length ? (
                  <small>调整筛选条件或搜索内容。</small>
                ) : (
                  <button className="text-button" onClick={() => setDialog('add')}>
                    <Plus size={14} />
                    添加到清单
                  </button>
                )}
              </div>
            )}
          </KanbanBoard>
        )}
      </div>
      <footer className="wf-footer">
        <span>
          {loading ? '正在加载…' : `${result?.total || 0} 条记录`}
          {layout === 'board' && result && result.total > result.page_size
            ? ' · 卡片显示当前页'
            : ''}
          {busy ? ' · 正在保存…' : ''}
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="上一页"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            {page} / {Math.max(1, Math.ceil((result?.total || 0) / 50))}
          </span>
          <button
            className="icon-button"
            aria-label="下一页"
            disabled={page * 50 >= (result?.total || 0) || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </footer>
      {dialog === 'add' && (
        <Dialog title={`添加到清单 · ${list.name}`} onClose={() => setDialog(null)}>
          <ListRecordPicker
            list={list}
            workspace={workspace}
            onClose={() => setDialog(null)}
            onDone={() => {
              setDialog(null);
              setRevision((n) => n + 1);
              onChanged();
            }}
          />
        </Dialog>
      )}
      {dialog === 'field' && (
        <FieldDialog
          field={editField}
          workspace={workspace}
          listId={list.id}
          onClose={() => setDialog(null)}
          onSaved={(f) => {
            const fs = fields.some((old) => old.id === f.id)
              ? fields.map((old) => (old.id === f.id ? f : old))
              : [...fields, f];
            setFields(fs);
            setConfig((c) =>
              c
                ? {
                    ...cleanConfig(c, fs),
                    columns: c.columns.includes(f.id) ? c.columns : [...c.columns, f.id],
                  }
                : c,
            );
            setDialog(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
      {dialog === 'filters' && (
        <Dialog title="筛选清单记录" className="wf-filter-dialog" onClose={() => setDialog(null)}>
          <div className="wf-filter-body">
            <label>
              匹配
              <select
                aria-label="筛选条件关系"
                value={draftFilters.match}
                onChange={(e) =>
                  setDraftFilters((d) => ({ ...d, match: e.target.value as 'all' | 'any' }))
                }
              >
                <option value="all">全部条件</option>
                <option value="any">任一条件</option>
              </select>
            </label>
            {draftFilters.rules.map((rule, i) => {
              const field = active.find((f) => f.id === rule.field);
              const patch = (p: Partial<ListRule>) =>
                setDraftFilters((d) => ({
                  ...d,
                  rules: d.rules.map((r, j) => (i === j ? { ...r, ...p } : r)),
                }));
              const ops = [
                'eq',
                'not_eq',
                ...(!field || field.kind === 'text' ? ['contains'] : []),
                ...(field && ['date', 'currency'].includes(field.kind) ? ['gt', 'lt'] : []),
                'is_set',
                'is_not_set',
              ];
              return (
                <div className="wf-filter-rule" key={i}>
                  <select
                    aria-label={`条件${i + 1}字段`}
                    value={rule.field}
                    onChange={(e) => patch({ field: e.target.value, operator: 'eq', value: '' })}
                  >
                    <option value="name">记录名称</option>
                    {active.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`条件${i + 1}运算符`}
                    value={rule.operator}
                    onChange={(e) => patch({ operator: e.target.value as ListRule['operator'] })}
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {listOperators[op as keyof typeof listOperators]}
                      </option>
                    ))}
                  </select>
                  {!['is_set', 'is_not_set'].includes(rule.operator) &&
                    (field?.kind === 'stage' || field?.kind === 'member' ? (
                      <select
                        aria-label={`条件${i + 1}值`}
                        value={rule.value}
                        onChange={(e) => patch({ value: e.target.value })}
                      >
                        <option value="">选择…</option>
                        {field.kind === 'stage'
                          ? field.options.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))
                          : members
                              .filter((m) => m.active)
                              .map((m) => (
                                <option key={m.actor_id} value={m.actor_id}>
                                  {m.display_name}
                                </option>
                              ))}
                      </select>
                    ) : (
                      <input
                        aria-label={`条件${i + 1}值`}
                        type={
                          field?.kind === 'date'
                            ? 'date'
                            : field?.kind === 'currency'
                              ? 'number'
                              : 'text'
                        }
                        min={0}
                        step="0.01"
                        value={rule.value}
                        onChange={(e) => patch({ value: e.target.value })}
                      />
                    ))}
                  <button
                    className="icon-button"
                    aria-label={`删除条件${i + 1}`}
                    onClick={() =>
                      setDraftFilters((d) => ({ ...d, rules: d.rules.filter((_, j) => j !== i) }))
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
            <button
              disabled={draftFilters.rules.length >= 15}
              onClick={() =>
                setDraftFilters((d) => ({
                  ...d,
                  rules: [...d.rules, { field: 'name', operator: 'contains', value: '' }],
                }))
              }
            >
              <Plus size={14} />
              添加条件
            </button>
          </div>
          <footer className="form-footer">
            <button onClick={() => setDraftFilters({ match: 'all', rules: [] })}>清空</button>
            <button
              className="primary"
              disabled={draftFilters.rules.some(
                (r) => !['is_set', 'is_not_set'].includes(r.operator) && !r.value.trim(),
              )}
              onClick={() => {
                change({ filters: draftFilters });
                setDialog(null);
              }}
            >
              应用筛选
            </button>
          </footer>
        </Dialog>
      )}
      {(dialog === 'save' || dialog === 'rename') && (
        <Dialog
          title={dialog === 'save' ? '保存新视图' : '重命名视图'}
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (dialog === 'save' ? saveView(true) : mutateView());
            }}
          >
            <label className="wf-form-label">
              视图名称
              <input
                required
                maxLength={80}
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
              />
            </label>
            <p className="dialog-copy">保存表格或卡片视图、显示字段、筛选与排序，方便下次继续。</p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <footer className="form-footer">
              <button type="button" disabled={busy} onClick={() => setDialog(null)}>
                取消
              </button>
              <button className="primary" disabled={busy || !viewName.trim()}>
                保存
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {dialog === 'remove' && (
        <Dialog title="从此清单移除记录" onClose={() => setDialog(null)}>
          <p className="dialog-copy">
            移除选中的 {checked.length} 条记录及其在此清单内的进度；客户主档案和其他清单保持不变。
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <footer className="form-footer">
            <button disabled={busy} onClick={() => setDialog(null)}>
              取消
            </button>
            <button disabled={busy} onClick={() => void removeEntries()}>
              移除记录
            </button>
          </footer>
        </Dialog>
      )}
      {pending && (
        <Dialog title="当前视图有未保存的更改" onClose={() => setPending(null)}>
          <p className="dialog-copy">切换视图会放弃当前显示设置。已填写的清单字段已实时保存。</p>
          <footer className="form-footer">
            <button onClick={() => setPending(null)}>继续编辑</button>
            <button
              onClick={() => {
                const next = pending;
                setPending(null);
                next();
              }}
            >
              放弃设置并继续
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
function FieldIcon({ field }: { field: ListField }) {
  return field.kind === 'stage' ? (
    <Columns3 size={13} />
  ) : field.kind === 'member' ? (
    <UserRound size={13} />
  ) : (
    <Settings2 size={13} />
  );
}
function ValueEditor({
  field,
  value,
  members,
  disabled,
  label,
  onSave,
}: {
  field: ListField;
  value: string;
  members: Member[];
  disabled: boolean;
  label: string;
  onSave: (v: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const cancel = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const color =
    field.kind === 'stage'
      ? stageColors[field.options.find((o) => o.id === value)?.color || 'gray']
      : undefined;
  if (field.kind === 'stage' || field.kind === 'member')
    return (
      <select
        className={`wf-cell-select ${!value ? 'wf-empty-value' : ''}`}
        style={color ? { color } : undefined}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onSave(e.target.value || null)}
      >
        <option value="">未填写</option>
        {field.kind === 'stage' ? (
          field.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))
        ) : (
          <>
            {value && !members.some((m) => m.actor_id === value && m.active) && (
              <option value={value}>已停用成员</option>
            )}
            {members
              .filter((m) => m.active)
              .map((m) => (
                <option key={m.actor_id} value={m.actor_id}>
                  {m.display_name}
                </option>
              ))}
          </>
        )}
      </select>
    );
  return (
    <div className="wf-cell-input">
      {field.kind === 'currency' && (
        <span>{field.currency === 'CNY' ? '¥' : field.currency === 'USD' ? '$' : '€'}</span>
      )}
      <input
        aria-label={label}
        value={draft}
        disabled={disabled}
        placeholder="未填写"
        type={field.kind === 'date' ? 'date' : field.kind === 'currency' ? 'number' : 'text'}
        min={0}
        step="0.01"
        maxLength={2000}
        onChange={(e) => setDraft(e.target.value)}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={(e) => {
          if (cancel.current) {
            cancel.current = false;
            return;
          }
          const next = e.currentTarget.value;
          if (next !== value) onSave(next.trim() || null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            cancel.current = true;
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
function FieldDialog({
  field,
  workspace,
  listId,
  onSaved,
  onClose,
}: {
  field?: ListField;
  workspace: string;
  listId: string;
  onSaved: (f: ListField) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(field?.name || ''),
    [kind, setKind] = useState<FieldKind>(field?.kind || 'text'),
    [currency, setCurrency] = useState(field?.currency || 'CNY');
  const [options, setOptions] = useState<StageOption[]>(
    field?.options || [
      { id: crypto.randomUUID(), label: '待开始', color: 'gray' },
      { id: crypto.randomUUID(), label: '进行中', color: 'blue' },
      { id: crypto.randomUUID(), label: '已完成', color: 'green' },
    ],
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const f = await api<ListField>(`/lists/${listId}/fields${field ? `/${field.id}` : ''}`, {
        workspace,
        method: field ? 'PATCH' : 'POST',
        body: field
          ? { name, options: kind === 'stage' ? options : [], version: field.version }
          : { name, kind, currency, options: kind === 'stage' ? options : [] },
      });
      onSaved(f);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={field ? '编辑清单字段' : '创建清单字段'}
      className="wf-field-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy}>
          <label className="wf-form-label">
            字段名称
            <input
              required
              maxLength={60}
              value={name}
              placeholder="例如：打样进度、报价金额"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="wf-form-label">
            字段类型
            <select
              disabled={Boolean(field)}
              value={kind}
              onChange={(e) => setKind(e.target.value as FieldKind)}
            >
              {Object.entries(fieldTypes).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {kind === 'currency' && (
            <label className="wf-form-label">
              币种
              <select
                disabled={Boolean(field)}
                value={currency}
                onChange={(e) => setCurrency(e.target.value as typeof currency)}
              >
                <option value="CNY">人民币（¥）</option>
                <option value="USD">美元（$）</option>
                <option value="EUR">欧元（€）</option>
              </select>
            </label>
          )}
          {kind === 'member' && (
            <p className="dialog-copy">
              从本工作空间的成员中选择负责人。指定负责人不会改变客户访问权限。
            </p>
          )}
          {kind === 'stage' && (
            <div className="wf-stage-editor">
              <p>阶段顺序</p>
              {options.map((o, i) => (
                <div key={o.id}>
                  <select
                    aria-label={`阶段${i + 1}颜色`}
                    value={o.color}
                    style={{ color: stageColors[o.color] }}
                    onChange={(e) =>
                      setOptions((prev) =>
                        prev.map((v, j) =>
                          j === i ? { ...v, color: e.target.value as StageOption['color'] } : v,
                        ),
                      )
                    }
                  >
                    {Object.keys(stageColors).map((c, j) => (
                      <option key={c} value={c}>
                        {['灰色', '蓝色', '青色', '紫色', '橙色', '绿色'][j]}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`阶段${i + 1}名称`}
                    required
                    maxLength={40}
                    value={o.label}
                    onChange={(e) =>
                      setOptions((prev) =>
                        prev.map((v, j) => (j === i ? { ...v, label: e.target.value } : v)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    disabled={i === 0}
                    aria-label={`上移阶段${i + 1}`}
                    onClick={() => {
                      const next = [...options];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      setOptions(next);
                    }}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={i === options.length - 1}
                    aria-label={`下移阶段${i + 1}`}
                    onClick={() => {
                      const next = [...options];
                      [next[i + 1], next[i]] = [next[i], next[i + 1]];
                      setOptions(next);
                    }}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`移除新阶段${i + 1}`}
                    disabled={
                      Boolean(field?.options.some((old) => old.id === o.id)) || options.length === 1
                    }
                    onClick={() => setOptions(options.filter((_, j) => j !== i))}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={options.length >= 40}
                onClick={() =>
                  setOptions((p) => [...p, { id: crypto.randomUUID(), label: '', color: 'purple' }])
                }
              >
                <Plus size={14} />
                添加阶段
              </button>
              <small>已有阶段可改名、换色和调整顺序，历史进度会保留。</small>
            </div>
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? '保存中…' : '保存字段'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
