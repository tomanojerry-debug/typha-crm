import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BarChart3,
  CalendarDays,
  Check,
  ChartNoAxesCombined,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  Ellipsis,
  Layers3,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { api } from './api';
import { Dialog, Popover, closeMenus } from './WorkspaceUI';
import { WorkspacePageHeader } from './WorkspacePage';
import type { Selection } from './Workbench';
import type { ActivityAnalysisConfig } from '../shared/activity-analysis';
import { ActivityAnalysisConfigDialog, ActivityFeedbackReport } from './ActivityFeedbackReport';
import {
  reportMetricLabels,
  type ReportCatalog,
  type ReportDashboard,
  type ReportQuery,
  type ReportQueryResult,
  type ReportWidget,
} from '../shared/reports';
import {
  instantiateReportWidgets,
  activityFeedbackReportTemplate,
  reportCsvCell,
  reportTemplates,
  type ReportTemplate,
} from './report-templates';
import './reports.css';

type Filters = Pick<ReportQuery, 'startDate' | 'endDate' | 'customerId' | 'customerType'>;
type Board = ReportDashboard & { preview?: boolean };
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
const number = (value: number | null) =>
  value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
const date = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const colors = [
  '#5e7bda',
  '#65aaa2',
  '#d7ac68',
  '#9a91bf',
  '#82a9cc',
  '#b9bdc8',
  '#b8838f',
  '#89a57c',
];
function queryFor(widget: ReportWidget, filters: Filters): ReportQuery {
  return {
    source: widget.source,
    metric: widget.metric,
    ...(widget.metricField ? { metricField: widget.metricField } : {}),
    groupBy: widget.groupBy,
    ...filters,
  };
}
function useQuery(workspace: string, query: ReportQuery) {
  const [result, setResult] = useState<ReportQueryResult | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify(query);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError('');
    void api<ReportQueryResult>('/reports/query', {
      workspace,
      method: 'POST',
      body: JSON.parse(key),
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setResult(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [workspace, key, retry]);
  return { result, error, retry: () => setRetry((n) => n + 1) };
}
function EmptyChart({ loading = false }: { loading?: boolean }) {
  return (
    <div className={`report-chart-empty ${loading ? 'is-loading' : ''}`} aria-live="polite">
      <ChartNoAxesCombined size={27} strokeWidth={1.25} />
      <span>{loading ? '正在读取当前数据…' : '这个范围还没有可统计的数据'}</span>
      {!loading && <small>调整筛选，或先在资料库中积累记录</small>}
    </div>
  );
}
function Chart({
  widget,
  result,
  onBucket,
}: {
  widget: ReportWidget;
  result: ReportQueryResult;
  onBucket?: (key?: string) => void;
}) {
  const buckets = result.buckets;
  if (result.value === null)
    return (
      <div className="report-chart-empty">
        <ChartNoAxesCombined size={27} strokeWidth={1.25} />
        <span>这个范围没有可统计的数值</span>
        <small>空属性不会作为0参与合计或平均</small>
      </div>
    );
  if (widget.visualization === 'number' || widget.groupBy === 'none')
    return (
      <button className="report-number" disabled={!onBucket} onClick={() => onBucket?.()}>
        <strong>{number(result.value)}</strong>
        <span>
          {reportMetricLabels[widget.metric]}
          <ArrowRight size={14} />
        </span>
        <small>
          涉及 {number(result.customerCount)} 家公司
          {['sum', 'average'].includes(widget.metric)
            ? ` · ${number(result.valueCount)} 个有效数值`
            : ''}
        </small>
      </button>
    );
  if (!result.total || !buckets.length) return <EmptyChart />;
  const max = Math.max(...buckets.map((b) => Math.abs(b.value || 0)), 1);
  if (widget.visualization === 'donut') {
    if (widget.metric === 'average' || widget.metric === 'distinct_customers')
      return (
        <div className="report-chart-message">均值与跨分组去重数不适合表示构成，请改用条形图。</div>
      );
    const sum = buckets.reduce((n, b) => n + Math.max(0, b.value || 0), 0);
    if (!sum || buckets.some((b) => (b.value || 0) < 0))
      return (
        <div className="report-chart-message">环形图需要非负且合计大于0的数值，请改用条形图。</div>
      );
    let accumulated = 0;
    return (
      <div className="report-donut-layout">
        <div className="report-donut">
          <svg viewBox="0 0 160 160" aria-label={`${widget.title}环形图`} role="img">
            <circle cx="80" cy="80" r="59" fill="none" stroke="#f0f1f4" strokeWidth="18" />
            {buckets.map((b, i) => {
              const start = accumulated;
              accumulated += (Math.max(0, b.value || 0) / sum) * 100;
              return (
                <circle
                  key={b.key}
                  cx="80"
                  cy="80"
                  r="59"
                  fill="none"
                  stroke={colors[i % colors.length]}
                  strokeWidth="18"
                  pathLength="100"
                  strokeDasharray={`${accumulated - start} ${100 - (accumulated - start)}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 80 80)"
                >
                  <title>
                    {b.label}：{number(b.value)}
                  </title>
                </circle>
              );
            })}
          </svg>
          <div>
            <strong>{number(result.value)}</strong>
            <span>{widget.metric === 'count' ? '条记录' : reportMetricLabels[widget.metric]}</span>
          </div>
        </div>
        <div className="report-legend">
          {buckets.map((b, i) => (
            <button key={b.key} onClick={() => onBucket?.(b.key)} disabled={!onBucket}>
              <i style={{ background: colors[i % colors.length] }} />
              <span title={b.label}>{b.label}</span>
              <strong>{number(b.value)}</strong>
              <small>{Math.round(((b.value || 0) / sum) * 100)}%</small>
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (widget.visualization === 'line') {
    if (widget.groupBy !== 'month')
      return <div className="report-chart-message">折线图用于时间变化，请选择月份分组。</div>;
    const min = Math.min(0, ...buckets.map((b) => b.value || 0));
    const span = max - min || 1;
    const points = buckets.map((b, i) => ({
      x: 28 + (i * 420) / Math.max(1, buckets.length - 1),
      y: 142 - (((b.value || 0) - min) / span) * 110,
      b,
    }));
    return (
      <div className="report-line">
        <svg viewBox="0 0 478 184" role="img" aria-label={widget.title}>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <line
                x1="28"
                y1={32 + i * 55}
                x2="448"
                y2={32 + i * 55}
                stroke="#edf0f4"
                strokeDasharray="3 4"
              />
              <text x="20" y={36 + i * 55} textAnchor="end">
                {number(max - (i * span) / 2)}
              </text>
            </g>
          ))}
          <path
            d={points
              .map((p, i) =>
                p.b.value === null
                  ? ''
                  : `${i === 0 || points[i - 1].b.value === null ? 'M' : 'L'} ${p.x} ${p.y}`,
              )
              .join(' ')}
            fill="none"
            stroke={colors[0]}
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          {points.map(({ x, y, b }, i) => (
            <g key={b.key}>
              {b.value !== null && (
                <circle cx={x} cy={y} r="4" fill="white" stroke={colors[0]} strokeWidth="2">
                  <title>
                    {b.label}：{number(b.value)}
                  </title>
                </circle>
              )}
              {(buckets.length <= 8 || i === 0 || i === buckets.length - 1) && (
                <text x={x} y="172" textAnchor="middle">
                  {b.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        <div className="report-line-values">
          {buckets.map((b) => (
            <button key={b.key} disabled={!onBucket} onClick={() => onBucket?.(b.key)}>
              {b.label}
              <strong>{number(b.value)}</strong>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="report-bars">
      {buckets.map((b, i) => (
        <button
          className="report-bar-row"
          key={b.key}
          disabled={!onBucket}
          onClick={() => onBucket?.(b.key)}
        >
          <span className="report-bar-label" title={b.label}>
            {b.label}
          </span>
          <span
            className={`report-bar-track ${buckets.some((b) => (b.value || 0) < 0) ? 'has-negative' : ''}`}
          >
            <i
              style={{
                width: `${Math.max(0, (Math.abs(b.value || 0) / max) * (buckets.some((b) => (b.value || 0) < 0) ? 50 : 100))}%`,
                ...(buckets.some((b) => (b.value || 0) < 0)
                  ? {
                      left:
                        (b.value || 0) < 0 ? `${50 - (Math.abs(b.value || 0) / max) * 50}%` : '50%',
                    }
                  : {}),
                background: colors[i % colors.length],
              }}
            />
          </span>
          <strong>{number(b.value)}</strong>
        </button>
      ))}
    </div>
  );
}

function ReportCard({
  workspace,
  widget,
  catalog,
  filters,
  revision,
  onDrill,
  onEdit,
  onRemove,
  onMove,
  index,
  count,
  busy,
}: {
  workspace: string;
  widget: ReportWidget;
  catalog: ReportCatalog;
  filters: Filters;
  revision: number;
  onDrill: (widget: ReportWidget, key?: string) => void;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (direction: number) => void;
  index: number;
  count: number;
  busy: boolean;
}) {
  const { result, error, retry } = useQuery(workspace, queryFor(widget, filters));
  const source = catalog.sources.find((s) => s.id === widget.source);
  // revision remounts the card when the user explicitly refreshes.
  return (
    <article
      className={`report-card ${widget.visualization === 'number' ? 'report-card-stat' : ''}`}
      data-revision={revision}
    >
      <header>
        <div>
          <span className="report-source-label">
            {source?.label || '原数据源已不可用'}
            <span>·</span>
            {reportMetricLabels[widget.metric]}
            {widget.metricField && (
              <>
                <span>·</span>
                {source?.fields.find((f) => f.id === widget.metricField)?.label}
                {source?.fields.find((f) => f.id === widget.metricField)?.unit
                  ? `（${source?.fields.find((f) => f.id === widget.metricField)?.unit}）`
                  : ''}
              </>
            )}
          </span>
          <h3>{widget.title}</h3>
        </div>
        <Popover label="图表操作" icon={<Ellipsis size={17} />} className="report-card-menu">
          <button
            onClick={() => {
              closeMenus();
              onEdit();
            }}
            disabled={busy}
          >
            <Pencil size={14} />
            编辑图表
          </button>
          <button
            onClick={() => {
              closeMenus();
              onMove(-1);
            }}
            disabled={busy || index === 0}
          >
            <ArrowUp size={14} />
            向前移动
          </button>
          <button
            onClick={() => {
              closeMenus();
              onMove(1);
            }}
            disabled={busy || index === count - 1}
          >
            <ArrowDown size={14} />
            向后移动
          </button>
          <button
            className="report-danger"
            onClick={() => {
              closeMenus();
              onRemove();
            }}
            disabled={busy}
          >
            <Trash2 size={14} />
            移除图表
          </button>
        </Popover>
      </header>
      <div className="report-chart-body">
        {error ? (
          <div className="report-inline-error" role="alert">
            {error}
            <button onClick={retry}>重新读取</button>
          </div>
        ) : result ? (
          <Chart widget={widget} result={result} onBucket={(key) => onDrill(widget, key)} />
        ) : (
          <EmptyChart loading />
        )}
      </div>
      <footer>
        <span>
          {result?.dateLabel || source?.dateLabel || '当前授权数据'}
          {filters.startDate || filters.endDate ? ' · 期间筛选' : ' · 全部时间'}
        </span>
        <button disabled={!result || !result.total} onClick={() => onDrill(widget)}>
          查看明细
          <ChevronRight size={12} />
        </button>
      </footer>
    </article>
  );
}
function Drilldown({
  workspace,
  widget,
  filters,
  bucket,
  onClose,
  onSelect,
}: {
  workspace: string;
  widget: ReportWidget;
  filters: Filters;
  bucket?: string;
  onClose: () => void;
  onSelect: (selection: Selection | null) => void;
}) {
  const [offset, setOffset] = useState(0);
  const { result, error, retry } = useQuery(workspace, {
    ...queryFor(widget, filters),
    ...(bucket !== undefined ? { bucketKey: bucket } : {}),
    offset,
    limit: 20,
  });
  return (
    <Dialog title={widget.title} className="report-drill-dialog" onClose={onClose}>
      <div className="report-dialog-body">
        <div className="report-drill-meta">
          <span>统计对应的业务记录</span>
          <span>
            {result
              ? `${number(result.total)} 条 · ${number(result.customerCount)} 家公司`
              : '正在读取…'}
          </span>
        </div>
        {error ? (
          <div role="alert" className="report-inline-error">
            {error}
            <button onClick={retry}>重试</button>
          </div>
        ) : !result ? (
          <EmptyChart loading />
        ) : (
          <>
            <div className="report-drill-table">
              <table>
                <thead>
                  <tr>
                    <th>记录</th>
                    <th>所属公司</th>
                    <th>{result.dateLabel}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>{row.customer_name}</td>
                      <td>{date(row.date)}</td>
                      <td>
                        <button
                          aria-label={`打开${row.name}`}
                          onClick={() => {
                            onClose();
                            onSelect({
                              customerId: row.customer_id,
                              ...(row.project_id ? { projectId: row.project_id } : {}),
                              ...(row.person_id ? { personId: row.person_id } : {}),
                              ...(widget.source === 'records' || widget.source === 'activities'
                                ? { customerTab: 'records' as const }
                                : {}),
                              full: true,
                            });
                          }}
                        >
                          查看
                          <ArrowRight size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!result.rows.length && <p className="report-muted">当前没有可见的记录。</p>}
            </div>
            <div className="report-pagination">
              <span>
                第 {offset + (result.rows.length ? 1 : 0)}–{offset + result.rows.length} 条
              </span>
              <div>
                <button disabled={!offset} onClick={() => setOffset((n) => Math.max(0, n - 20))}>
                  上一页
                </button>
                <button disabled={!result.hasMore} onClick={() => setOffset((n) => n + 20)}>
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
        <p className="report-footnote">
          明细按你当前的访问权限重新读取。点击记录进入对应档案核对资料。
        </p>
      </div>
    </Dialog>
  );
}
function WidgetEditor({
  workspace,
  catalog,
  initial,
  filters,
  onSave,
  onClose,
  busy,
}: {
  workspace: string;
  catalog: ReportCatalog;
  initial?: ReportWidget;
  filters: Filters;
  onSave: (widget: ReportWidget) => Promise<void>;
  onClose: () => void;
  busy: boolean;
}) {
  const [widget, setWidget] = useState<ReportWidget>(
    initial || {
      id: crypto.randomUUID(),
      title: '客户类型分布',
      source: 'companies',
      metric: 'count',
      groupBy: 'type',
      visualization: 'bar',
    },
  );
  const [error, setError] = useState('');
  const source = catalog.sources.find((s) => s.id === widget.source);
  const { result, error: queryError } = useQuery(workspace, queryFor(widget, filters));
  const numeric = source?.fields.filter((f) => f.kind === 'number') || [];
  const set = (patch: Partial<ReportWidget>) => {
    setError('');
    setWidget((w) => ({ ...w, ...patch }));
  };
  return (
    <Dialog
      title={initial ? '编辑图表' : '添加图表'}
      className="report-editor-dialog"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(widget).catch((e) => setError(errorText(e)));
        }}
      >
        <div className="report-editor-layout">
          <div className="report-editor-fields">
            <label>
              图表名称
              <input
                required
                maxLength={100}
                value={widget.title}
                onChange={(e) => set({ title: e.target.value })}
              />
            </label>
            <label>
              数据源
              <select
                aria-label="数据源"
                value={widget.source}
                onChange={(e) =>
                  set({
                    source: e.target.value,
                    groupBy: 'none',
                    metric: 'count',
                    metricField: undefined,
                    visualization: 'number',
                  })
                }
              >
                {catalog.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              统计指标
              <select
                aria-label="统计指标"
                value={widget.metric}
                onChange={(e) =>
                  set({
                    metric: e.target.value as ReportWidget['metric'],
                    metricField: ['sum', 'average'].includes(e.target.value)
                      ? numeric[0]?.id
                      : undefined,
                    visualization:
                      widget.visualization === 'donut' &&
                      ['average', 'distinct_customers'].includes(e.target.value)
                        ? 'bar'
                        : widget.visualization,
                  })
                }
              >
                <option value="count">记录数量</option>
                <option value="distinct_customers">去重公司数</option>
                {numeric.length > 0 && (
                  <>
                    <option value="sum">数值合计</option>
                    <option value="average">数值平均</option>
                  </>
                )}
              </select>
            </label>
            {['sum', 'average'].includes(widget.metric) && (
              <label>
                数值属性
                <select
                  required
                  aria-label="数值属性"
                  value={widget.metricField || ''}
                  onChange={(e) => set({ metricField: e.target.value })}
                >
                  {numeric.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                      {f.unit ? `（${f.unit}）` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              分组依据
              <select
                aria-label="分组依据"
                value={widget.groupBy}
                onChange={(e) =>
                  set({
                    groupBy: e.target.value,
                    visualization:
                      e.target.value === 'none'
                        ? 'number'
                        : widget.visualization === 'number' ||
                            (widget.visualization === 'line' && e.target.value !== 'month')
                          ? 'bar'
                          : widget.visualization,
                  })
                }
              >
                <option value="none">不分组 · 单个指标</option>
                {source?.fields
                  .filter((f) => f.kind !== 'number')
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              呈现方式
              <select
                aria-label="呈现方式"
                value={widget.visualization}
                onChange={(e) =>
                  set({
                    visualization: e.target.value as ReportWidget['visualization'],
                    ...(e.target.value === 'number' ? { groupBy: 'none' } : {}),
                  })
                }
              >
                <option value="number">数字</option>
                {widget.groupBy !== 'none' && (
                  <>
                    <option value="bar">条形图</option>
                    {['count', 'sum'].includes(widget.metric) && (
                      <option value="donut">环形图</option>
                    )}
                    {widget.groupBy === 'month' && <option value="line">折线图</option>}
                  </>
                )}
              </select>
            </label>
            <p className="report-footnote">只提供资料库中已存在的字段。统计会遵循当前看板筛选。</p>
          </div>
          <div className="report-editor-preview">
            <span className="report-eyebrow">LIVE PREVIEW</span>
            <h3>{widget.title || '未命名图表'}</h3>
            {queryError ? (
              <div className="report-inline-error">{queryError}</div>
            ) : result ? (
              <Chart widget={widget} result={result} />
            ) : (
              <EmptyChart loading />
            )}
            <p className="report-footnote">{source?.dateLabel} · 当前数据预览</p>
          </div>
        </div>
        {error && (
          <p className="report-form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="report-dialog-footer">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="report-primary"
            disabled={busy || !widget.title.trim() || !!queryError || !result}
          >
            {busy ? '保存中…' : '保存图表'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function BoardDialog({
  initial,
  template,
  busy,
  onSave,
  onClose,
}: {
  initial?: Board;
  template?: ReportTemplate;
  busy: boolean;
  onSave: (name: string, description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name || template?.name || '新的客户研究');
  const [description, setDescription] = useState(
    initial?.description || template?.description || '',
  );
  const [error, setError] = useState('');
  return (
    <Dialog
      title={initial && !initial.preview ? '看板设置' : '创建看板'}
      className="report-board-dialog"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(name.trim(), description.trim()).catch((e) => setError(errorText(e)));
        }}
      >
        <div className="report-dialog-body">
          <label>
            看板名称
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            描述
            <textarea
              rows={3}
              maxLength={1000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="这个看板帮助你回答什么问题？"
            />
          </label>
          <p className="report-privacy">
            <LockKeyhole size={14} />
            仅本人可见，按当前权限读取资料
          </p>
          {error && (
            <p className="report-form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="report-dialog-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="report-primary" disabled={busy || !name.trim()}>
            {busy ? '保存中…' : initial && !initial.preview ? '保存修改' : '创建看板'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function TemplateArt({ template }: { template: ReportTemplate }) {
  const customers = template.id === 'customers';
  const projects = template.id === 'projects';
  return (
    <div
      className={`report-template-art tone-${template.color}`}
      data-art={template.id}
      aria-hidden="true"
    >
      <svg className="report-art-wide" viewBox="0 0 300 100" fill="none" focusable="false">
        {customers ? (
          <>
            <circle cx="98" cy="50" r="29" stroke="currentColor" strokeWidth="9" opacity=".13" />
            <circle
              cx="98"
              cy="50"
              r="29"
              stroke="currentColor"
              strokeWidth="9"
              pathLength="100"
              strokeDasharray="42 58"
              transform="rotate(-90 98 50)"
              opacity=".75"
            />
            <circle
              cx="98"
              cy="50"
              r="29"
              stroke="currentColor"
              strokeWidth="9"
              pathLength="100"
              strokeDasharray="23 77"
              strokeDashoffset="-46"
              transform="rotate(-90 98 50)"
              opacity=".42"
            />
            <circle cx="98" cy="44" r="6" fill="currentColor" opacity=".5" />
            <path d="M86 63c0-9 5-12 12-12s12 3 12 12" fill="currentColor" opacity=".3" />
            {[29, 49, 69].map((y, i) => (
              <g key={y} opacity={[0.65, 0.4, 0.24][i]}>
                <circle cx="157" cy={y} r="3" fill="currentColor" />
                <rect
                  x="169"
                  y={y - 2}
                  width={[66, 47, 57][i]}
                  height="4"
                  rx="2"
                  fill="currentColor"
                />
              </g>
            ))}
          </>
        ) : projects ? (
          <>
            <path d="M73 25h154" stroke="currentColor" strokeWidth="2" opacity=".22" />
            <path d="M73 25h77" stroke="currentColor" strokeWidth="2" opacity=".6" />
            {[73, 150, 227].map((x, i) => (
              <g key={x}>
                <circle cx={x} cy="25" r="7" fill="currentColor" opacity={[0.8, 0.5, 0.2][i]} />
                <rect x={x - 28} y="44" width="56" height="38" rx="6" fill="white" opacity=".8" />
                <rect
                  x={x - 28}
                  y="44"
                  width="56"
                  height="38"
                  rx="6"
                  stroke="currentColor"
                  opacity=".22"
                />
                <rect
                  x={x - 18}
                  y="55"
                  width="21"
                  height="3"
                  rx="1.5"
                  fill="currentColor"
                  opacity=".3"
                />
                <rect
                  x={x - 18}
                  y="66"
                  width="36"
                  height="5"
                  rx="2.5"
                  fill="currentColor"
                  opacity=".13"
                />
                <rect
                  x={x - 18}
                  y="66"
                  width={[29, 19, 10][i]}
                  height="5"
                  rx="2.5"
                  fill="currentColor"
                  opacity=".65"
                />
              </g>
            ))}
            <path
              d="m70 25 2 2 4-4"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <path
              d="M66 20v61"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="3 4"
              opacity=".3"
            />
            {[22, 50, 79].map((y, i) => (
              <circle
                key={y}
                cx="66"
                cy={y}
                r="3"
                fill="currentColor"
                opacity={[0.65, 0.4, 0.25][i]}
              />
            ))}
            <path
              d="M93 13h106a6 6 0 0 1 6 6v17a6 6 0 0 1-6 6h-91l-12 6v-6h-3a6 6 0 0 1-6-6V19a6 6 0 0 1 6-6Z"
              fill="currentColor"
              opacity=".18"
            />
            <path
              d="M126 52h99a6 6 0 0 1 6 6v17a6 6 0 0 1-6 6h-5v6l-12-6h-82a6 6 0 0 1-6-6V58a6 6 0 0 1 6-6Z"
              fill="white"
              opacity=".8"
            />
            <path
              d="M126 52h99a6 6 0 0 1 6 6v17a6 6 0 0 1-6 6h-5v6l-12-6h-82a6 6 0 0 1-6-6V58a6 6 0 0 1 6-6Z"
              stroke="currentColor"
              opacity=".35"
            />
            <path
              d="M102 24h60m-60 8h83m-50 31h66m-66 8h45"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              opacity=".45"
            />
          </>
        )}
      </svg>
      <svg className="report-art-compact" viewBox="0 0 100 150" fill="none" focusable="false">
        {customers ? (
          <>
            <circle cx="50" cy="46" r="25" stroke="currentColor" strokeWidth="8" opacity=".15" />
            <circle
              cx="50"
              cy="46"
              r="25"
              stroke="currentColor"
              strokeWidth="8"
              pathLength="100"
              strokeDasharray="45 55"
              transform="rotate(-90 50 46)"
              opacity=".72"
            />
            <circle
              cx="50"
              cy="46"
              r="25"
              stroke="currentColor"
              strokeWidth="8"
              pathLength="100"
              strokeDasharray="23 77"
              strokeDashoffset="-49"
              transform="rotate(-90 50 46)"
              opacity=".4"
            />
            <circle cx="50" cy="41" r="5" fill="currentColor" opacity=".5" />
            <path d="M40 58c0-8 4-11 10-11s10 3 10 11" fill="currentColor" opacity=".3" />
            {[94, 111, 128].map((y, i) => (
              <g key={y} opacity={[0.6, 0.4, 0.25][i]}>
                <circle cx="25" cy={y} r="2.5" fill="currentColor" />
                <rect
                  x="35"
                  y={y - 1.5}
                  width={[38, 29, 34][i]}
                  height="3"
                  rx="1.5"
                  fill="currentColor"
                />
              </g>
            ))}
          </>
        ) : projects ? (
          <>
            <path d="M25 26v98" stroke="currentColor" strokeWidth="2" opacity=".22" />
            <path d="M25 26v49" stroke="currentColor" strokeWidth="2" opacity=".6" />
            {[26, 75, 124].map((y, i) => (
              <g key={y}>
                <circle cx="25" cy={y} r="6" fill="currentColor" opacity={[0.8, 0.5, 0.22][i]} />
                <rect
                  x="41"
                  y={y - 9}
                  width="24"
                  height="3"
                  rx="1.5"
                  fill="currentColor"
                  opacity=".3"
                />
                <rect
                  x="41"
                  y={y + 1}
                  width="38"
                  height="6"
                  rx="3"
                  fill="currentColor"
                  opacity=".13"
                />
                <rect
                  x="41"
                  y={y + 1}
                  width={[32, 22, 12][i]}
                  height="6"
                  rx="3"
                  fill="currentColor"
                  opacity=".65"
                />
              </g>
            ))}
            <path
              d="m22 26 2 2 4-4"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <path
              d="M20 24v101"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="3 4"
              opacity=".3"
            />
            {[29, 76, 122].map((y, i) => (
              <g key={y}>
                <circle cx="20" cy={y} r="3" fill="currentColor" opacity={[0.65, 0.4, 0.25][i]} />
                <path
                  d={`M39 ${y - 13}h39a5 5 0 0 1 5 5v15a5 5 0 0 1-5 5H48l-9 5v-5a5 5 0 0 1-5-5v-15a5 5 0 0 1 5-5Z`}
                  fill="currentColor"
                  opacity={[0.2, 0.12, 0.18][i]}
                />
                <path
                  d={`M43 ${y - 3}h29m-29 8h${i === 1 ? 16 : 22}`}
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  opacity=".5"
                />
              </g>
            ))}
          </>
        )}
      </svg>
    </div>
  );
}

export function ReportsWorkspace({
  workspace,
  actorId,
  onSelect,
  notify,
}: {
  workspace: string;
  actorId: string;
  onSelect: (selection: Selection | null) => void;
  notify: (message: string) => void;
}) {
  const [catalog, setCatalog] = useState<ReportCatalog | null>(null);
  const [boards, setBoards] = useState<ReportDashboard[]>([]);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const [filters, setFilters] = useState<Filters>({});
  const [period, setPeriod] = useState('all');
  const [editor, setEditor] = useState<ReportWidget | 'new' | null>(null);
  const [boardDialog, setBoardDialog] = useState<{
    template?: ReportTemplate;
    initial?: Board;
  } | null>(null);
  const [activityMapping, setActivityMapping] = useState<{
    template?: ReportTemplate;
    initial?: ActivityAnalysisConfig;
  } | null>(null);
  const [drill, setDrill] = useState<{ widget: ReportWidget; bucket?: string } | null>(null);
  const [guide, setGuide] = useState(false);
  const [deleteBoard, setDeleteBoard] = useState(false);
  const [exporting, setExporting] = useState(false);
  const restore = useRef(false);
  const preferenceKey = `typha:reports:${workspace}:${actorId}`;
  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [c, b] = await Promise.all([
        api<ReportCatalog>('/reports/catalog', { workspace }),
        api<ReportDashboard[]>('/reports/dashboards', { workspace }),
      ]);
      setCatalog(c);
      setBoards(b);
      if (!restore.current) {
        restore.current = true;
        try {
          const id = localStorage.getItem(preferenceKey);
          setBoard(b.find((v) => v.id === id) || null);
        } catch {
          /* Server remains authoritative. */
        }
      } else {
        setBoard((current) =>
          current?.preview ? current : b.find((value) => value.id === current?.id) || null,
        );
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [workspace, preferenceKey]);
  useEffect(() => {
    void load();
  }, [load]);
  const open = (value: Board | null) => {
    setBoard(value);
    setFilters({});
    setPeriod('all');
    setError('');
    try {
      value && !value.preview
        ? localStorage.setItem(preferenceKey, value.id)
        : localStorage.removeItem(preferenceKey);
    } catch {
      /* Optional navigation preference. */
    }
  };
  const preview = (template: ReportTemplate) => {
    if (template.requiresActivityMapping) {
      setActivityMapping({ template });
      return;
    }
    open({
      id: template.id,
      name: template.name,
      description: template.description,
      widgets: instantiateReportWidgets(template.widgets),
      activity_analysis: template.activity_analysis || null,
      version: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      preview: true,
    });
  };
  const save = async (
    patch: Partial<Pick<ReportDashboard, 'name' | 'description' | 'widgets' | 'activity_analysis'>>,
  ) => {
    if (!board) return;
    if (board.preview) {
      setBoard({ ...board, ...patch });
      return;
    }
    setBusy(true);
    setError('');
    try {
      const value = await api<ReportDashboard>(`/reports/dashboards/${board.id}`, {
        workspace,
        method: 'PATCH',
        body: {
          name: board.name,
          description: board.description,
          widgets: board.widgets,
          activity_analysis: board.activity_analysis || null,
          ...patch,
          version: board.version,
        },
      });
      setBoard(value);
      setBoards((items) => items.map((item) => (item.id === value.id ? value : item)));
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const create = async (name: string, description: string) => {
    setBusy(true);
    try {
      const value = await api<ReportDashboard>('/reports/dashboards', {
        workspace,
        method: 'POST',
        body: {
          name,
          description,
          widgets: instantiateReportWidgets(
            boardDialog?.initial?.widgets || boardDialog?.template?.widgets || [],
          ),
          activity_analysis:
            boardDialog?.initial?.activity_analysis ||
            boardDialog?.template?.activity_analysis ||
            null,
        },
      });
      setBoards((current) => [value, ...current]);
      open(value);
      setBoardDialog(null);
      notify('看板已保存');
    } finally {
      setBusy(false);
    }
  };
  const changePeriod = (value: string) => {
    setPeriod(value);
    if (value === 'custom') return;
    if (value === 'all') {
      setFilters((f) => ({ ...f, startDate: undefined, endDate: undefined }));
      return;
    }
    const end = today();
    const start = new Date(`${end}T00:00:00+08:00`);
    start.setUTCDate(start.getUTCDate() - Number(value) + 1);
    const startDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(start);
    setFilters((f) => ({ ...f, startDate, endDate: end }));
  };
  const exportCsv = async () => {
    if (!board) return;
    setExporting(true);
    setError('');
    try {
      const lines: unknown[][] = [
        ['看板', board.name],
        ['导出时间（北京时间）', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })],
        ['开始日期', filters.startDate || '不限'],
        ['结束日期', filters.endDate || '不限'],
        [
          '公司',
          catalog?.customers.find((c) => c.id === filters.customerId)?.name || '全部可访问公司',
        ],
        [
          '客户类型',
          catalog?.customerTypes.find((t) => t.value === filters.customerType)?.label || '全部',
        ],
        [],
        [
          '图表',
          '数据源',
          '时间口径',
          '指标',
          '属性',
          '单位',
          '分组',
          '值',
          '记录数',
          '去重公司数',
        ],
      ];
      for (const w of board.widgets) {
        const r = await api<ReportQueryResult>('/reports/query', {
          workspace,
          method: 'POST',
          body: queryFor(w, filters),
        });
        const prefix = [
          w.title,
          catalog?.sources.find((s) => s.id === w.source)?.label || w.source,
          r.dateLabel,
          reportMetricLabels[w.metric],
          catalog?.sources
            .find((s) => s.id === w.source)
            ?.fields.find((f) => f.id === w.metricField)?.label || '',
          catalog?.sources
            .find((s) => s.id === w.source)
            ?.fields.find((f) => f.id === w.metricField)?.unit || '',
        ];
        if (r.buckets.length)
          r.buckets.forEach((b) =>
            lines.push([...prefix, b.label, b.value, b.count, b.customerCount]),
          );
        else lines.push([...prefix, '全部', r.value, r.total, r.customerCount]);
      }
      const blob = new Blob(
        ['\uFEFF' + lines.map((row) => row.map(reportCsvCell).join(',')).join('\r\n')],
        { type: 'text/csv;charset=utf-8' },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${board.name.replace(/[\\/:*?"<>|]/g, '_')}-${today()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('当前筛选的统计已导出');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting(false);
    }
  };
  const filtered = useMemo(
    () =>
      boards.filter((b) =>
        `${b.name} ${b.description}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [boards, search],
  );
  const dateInvalid = !!(
    filters.startDate &&
    filters.endDate &&
    filters.startDate > filters.endDate
  );
  return (
    <section className="reports-workspace workspace-page" aria-label="报告工作区">
      <div className="reports-inner">
        {board ? (
          <>
            <div className="report-detail-nav">
              <button className="report-text-button" onClick={() => open(null)}>
                <ArrowLeft size={14} />
                所有看板
              </button>
              <span>/</span>
              <span>{board.preview ? '模板预览' : '我的看板'}</span>
              <span className="report-privacy">
                <LockKeyhole size={12} />
                仅本人
              </span>
            </div>
            <WorkspacePageHeader
              title={board.name}
              description={board.description || '从真实的客户资料中，找到下一步。'}
              actions={
                <div className="report-page-actions">
                  {board.preview ? (
                    <button
                      className="report-primary"
                      onClick={() => setBoardDialog({ initial: board })}
                    >
                      <Plus size={14} />
                      保存为我的看板
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => setBoardDialog({ initial: board })}
                        aria-label="看板设置"
                      >
                        <Pencil size={14} />
                      </button>
                      <Popover label="更多操作" icon={<Ellipsis size={16} />}>
                        <button
                          onClick={() => {
                            closeMenus();
                            setBoardDialog({
                              template: {
                                id: '',
                                name: `${board.name} 副本`,
                                description: board.description,
                                widgets: board.widgets,
                                activity_analysis: board.activity_analysis || null,
                                color: 'blue',
                                eyebrow: '',
                              },
                            });
                          }}
                        >
                          <Copy size={14} />
                          复制看板
                        </button>
                        <button
                          className="report-danger"
                          onClick={() => {
                            closeMenus();
                            setDeleteBoard(true);
                          }}
                        >
                          <Trash2 size={14} />
                          删除看板
                        </button>
                      </Popover>
                    </>
                  )}
                  {(!board.activity_analysis || board.widgets.length > 0) && (
                    <button
                      onClick={() => void exportCsv()}
                      disabled={exporting || dateInvalid || !board.widgets.length}
                    >
                      <Download size={14} />
                      {exporting ? '导出中…' : '导出'}
                    </button>
                  )}
                </div>
              }
            />
            <div className="report-filterbar">
              <div className="report-filter-controls">
                <label className="report-period">
                  <CalendarDays size={14} />
                  <select
                    aria-label="统计时间"
                    value={period}
                    onChange={(e) => changePeriod(e.target.value)}
                  >
                    <option value="all">全部时间</option>
                    <option value="30">近30天</option>
                    <option value="90">近90天</option>
                    <option value="custom">自定义时间</option>
                  </select>
                </label>
                {period === 'custom' && (
                  <div className="report-date-inputs">
                    <input
                      type="date"
                      aria-label="开始日期"
                      value={filters.startDate || ''}
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, startDate: e.target.value || undefined }))
                      }
                    />
                    <span>至</span>
                    <input
                      type="date"
                      aria-label="结束日期"
                      value={filters.endDate || ''}
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, endDate: e.target.value || undefined }))
                      }
                    />
                  </div>
                )}
                <select
                  aria-label="筛选公司"
                  value={filters.customerId || ''}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, customerId: e.target.value || undefined }))
                  }
                >
                  <option value="">全部可访问公司</option>
                  {catalog?.customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="客户类型"
                  value={filters.customerType || ''}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, customerType: e.target.value || undefined }))
                  }
                >
                  <option value="">全部客户类型</option>
                  {catalog?.customerTypes.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="report-filter-actions">
                <button
                  aria-label="刷新报告"
                  disabled={busy}
                  onClick={() => {
                    void load();
                    setRevision((n) => n + 1);
                  }}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={() => setEditor('new')}
                  disabled={busy || board.widgets.length >= 24}
                >
                  <Plus size={14} />
                  添加图表
                </button>
              </div>
            </div>
            <div className="report-context-line">
              <span>
                <i />
                实时读取授权资料 ·{' '}
                {board.activity_analysis
                  ? '反馈按实际发生日期筛选，日期不详单列'
                  : filters.startDate || filters.endDate
                    ? '按各图时间口径筛选'
                    : '当前属性快照'}
              </span>
              <button onClick={() => setGuide(true)}>
                <CircleHelp size={13} />
                统计口径
              </button>
            </div>
            {board.preview && (
              <div className="report-preview-notice">
                <Layers3 size={14} />
                <span>正在用你的真实数据预览模板。保存后可随时回来查看。</span>
              </div>
            )}
            {error && (
              <div className="report-inline-error" role="alert">
                {error}
                <button
                  onClick={() => {
                    void load();
                  }}
                >
                  重新加载
                </button>
              </div>
            )}
            {dateInvalid ? (
              <div className="report-inline-error" role="alert">
                开始日期不能晚于结束日期。
              </div>
            ) : (
              catalog && (
                <>
                  {board.activity_analysis && (
                    <ActivityFeedbackReport
                      key={`${workspace}:${board.id}`}
                      workspace={workspace}
                      config={board.activity_analysis}
                      filters={filters}
                      revision={revision}
                      onEditConfig={() => setActivityMapping({ initial: board.activity_analysis! })}
                    />
                  )}
                  <div className="report-chart-grid">
                    {board.widgets.map((widget, index) => (
                      <ReportCard
                        key={`${widget.id}:${revision}`}
                        workspace={workspace}
                        widget={widget}
                        catalog={catalog}
                        filters={filters}
                        revision={revision}
                        onDrill={(w, bucket) => setDrill({ widget: w, bucket })}
                        onEdit={() => setEditor(widget)}
                        onRemove={() => {
                          void save({
                            widgets: board.widgets.filter((w) => w.id !== widget.id),
                          }).catch((e) => setError(errorText(e)));
                        }}
                        onMove={(direction) => {
                          const widgets = [...board.widgets];
                          [widgets[index], widgets[index + direction]] = [
                            widgets[index + direction],
                            widgets[index],
                          ];
                          void save({ widgets }).catch((e) => setError(errorText(e)));
                        }}
                        index={index}
                        count={board.widgets.length}
                        busy={busy}
                      />
                    ))}
                    {!board.widgets.length && !board.activity_analysis && (
                      <div className="report-no-widgets">
                        <BarChart3 size={30} strokeWidth={1.3} />
                        <h3>从一个好问题开始</h3>
                        <p>选择数据源和指标，添加你的第一张图表。</p>
                        <button onClick={() => setEditor('new')}>
                          <Plus size={14} />
                          添加图表
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )
            )}
            <div className="report-page-footnote">
              仅统计当前可访问且未归档的资料。日期范围按各图标注筛选，属性分布表示这些记录的当前状态。
            </div>
          </>
        ) : (
          <>
            <WorkspacePageHeader
              title="报告"
              description="把散落的客户信息，变成看得清的业务线索。"
              actions={
                <div className="report-page-actions">
                  <button className="report-text-button" onClick={() => setGuide(true)}>
                    <CircleHelp size={15} />
                    报告指南
                  </button>
                  <button className="report-primary" onClick={() => setBoardDialog({})}>
                    <Plus size={15} />
                    新建看板
                  </button>
                </div>
              }
            />
            <div className="report-section-heading report-template-heading">
              <h2>模板推荐</h2>
            </div>
            <div className="report-template-grid">
              {[...reportTemplates, activityFeedbackReportTemplate].map((template, index) => (
                <article className={`report-template tone-${template.color}`} key={template.id}>
                  <TemplateArt template={template} />
                  <div className="report-template-copy">
                    <span className="report-template-index">
                      0{index + 1}
                      <span>{template.eyebrow}</span>
                    </span>
                    <h3>{template.name}</h3>
                    <p>{template.description}</p>
                    <button onClick={() => preview(template)} disabled={!catalog}>
                      {template.requiresActivityMapping ? '选择活动与字段' : '预览模板'}
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="report-section-heading report-my-heading">
              <div>
                <h2>
                  我的看板<span>{boards.length}</span>
                </h2>
                <p>保存你关心的问题，随时回来查看最新变化。</p>
              </div>
              <label className="report-search">
                <Search size={14} />
                <input
                  aria-label="搜索看板"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索看板"
                />
              </label>
            </div>
            {loading ? (
              <EmptyChart loading />
            ) : error ? (
              <div className="report-inline-error" role="alert">
                {error}
                <button onClick={() => void load()}>重试</button>
              </div>
            ) : filtered.length ? (
              <div className="report-saved-grid">
                {filtered.map((b) => (
                  <button className="report-saved-card" key={b.id} onClick={() => open(b)}>
                    <span className="report-saved-icon">
                      <BarChart3 size={19} strokeWidth={1.5} />
                    </span>
                    <span className="report-saved-copy">
                      <strong>{b.name}</strong>
                      <span>{b.description || '自定义客户研究看板'}</span>
                      <small>
                        {b.activity_analysis ? '反馈分析' : `${b.widgets.length} 张图表`}
                        {b.activity_analysis && b.widgets.length > 0
                          ? ` · ${b.widgets.length} 张图表`
                          : ''}
                        <span>·</span>
                        {date(b.updated_at)} 更新
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="report-library-empty">
                <div className="report-empty-icon">
                  <Layers3 size={24} strokeWidth={1.4} />
                </div>
                <h3>{search ? '没有找到这个看板' : '给重要的问题，留一个位置'}</h3>
                <p>
                  {search ? '试试其他名称或关键词。' : '从上方模板开始，或创建一个属于你的看板。'}
                </p>
                {!search && (
                  <button onClick={() => setBoardDialog({})}>
                    <Plus size={14} />
                    创建第一个看板
                  </button>
                )}
              </div>
            )}
            <div className="report-library-note">
              <LockKeyhole size={14} />
              <span>看板仅本人可见，始终遵循你在资料库中的访问权限。</span>
              <button onClick={() => setGuide(true)}>
                了解数据范围
                <ArrowRight size={12} />
              </button>
            </div>
          </>
        )}
      </div>
      {editor && catalog && (
        <WidgetEditor
          workspace={workspace}
          catalog={catalog}
          filters={filters}
          initial={editor === 'new' ? undefined : editor}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={async (widget) => {
            if (!board) return;
            await save({
              widgets:
                editor === 'new'
                  ? [...board.widgets, widget]
                  : board.widgets.map((w) => (w.id === widget.id ? widget : w)),
            });
            setEditor(null);
          }}
        />
      )}
      {boardDialog && (
        <BoardDialog
          initial={boardDialog.initial}
          template={boardDialog.template}
          busy={busy}
          onClose={() => setBoardDialog(null)}
          onSave={async (name, description) => {
            if (boardDialog.initial && !boardDialog.initial.preview) {
              await save({ name, description });
              setBoardDialog(null);
            } else await create(name, description);
          }}
        />
      )}
      {activityMapping && (
        <ActivityAnalysisConfigDialog
          key={`${workspace}:${activityMapping.initial?.typeId || 'new'}:${board?.id || 'none'}`}
          workspace={workspace}
          initial={activityMapping.initial}
          busy={busy}
          onClose={() => setActivityMapping(null)}
          onSave={async (config) => {
            if (activityMapping.template) {
              const template = activityMapping.template;
              open({
                id: template.id,
                name: template.name,
                description: template.description,
                widgets: [],
                activity_analysis: config,
                version: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                preview: true,
              });
            } else await save({ activity_analysis: config });
            setActivityMapping(null);
          }}
        />
      )}
      {drill && (
        <Drilldown
          workspace={workspace}
          widget={drill.widget}
          filters={filters}
          bucket={drill.bucket}
          onClose={() => setDrill(null)}
          onSelect={onSelect}
        />
      )}
      {deleteBoard && board && (
        <Dialog
          title="删除看板"
          onClose={() => setDeleteBoard(false)}
          className="report-board-dialog"
        >
          <div className="report-dialog-body">
            <p>删除「{board.name}」及其中的图表配置？客户、项目和原始资料会保留。</p>
            {error && <p role="alert">{error}</p>}
          </div>
          <footer className="report-dialog-footer">
            <button onClick={() => setDeleteBoard(false)} disabled={busy}>
              保留看板
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api(`/reports/dashboards/${board.id}`, {
                  workspace,
                  method: 'DELETE',
                  body: { version: board.version },
                })
                  .then(() => {
                    setBoards((items) => items.filter((b) => b.id !== board.id));
                    setDeleteBoard(false);
                    open(null);
                    notify('看板已删除');
                  })
                  .catch((e) => setError(errorText(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? '删除中…' : '删除看板'}
            </button>
          </footer>
        </Dialog>
      )}
      {guide && (
        <Dialog
          title="让每一个数字都有依据"
          onClose={() => setGuide(false)}
          className="report-guide-dialog"
        >
          <div className="report-dialog-body">
            <span className="report-eyebrow">READ THE DATA, WITH CONTEXT</span>
            <h3>先看关系，再看下一步</h3>
            <p>
              这里的报告来自当前 CRM
              中的公司、联系人、项目、业务活动、归档记录，以及你配置的自定义表。它适合了解客户构成、业务覆盖和项目进展。
            </p>
            <div className="report-guide-item">
              <Check size={16} />
              <div>
                <strong>当前属性与期间新增分开理解</strong>
                <p>
                  类型与阶段是记录当前的属性。选择日期后，仅统计在对应日期创建或发生的记录；这不表示历史客户存量、阶段流转或真实销售转化。
                </p>
              </div>
            </div>
            <div className="report-guide-item">
              <Check size={16} />
              <div>
                <strong>从图表回到具体客户</strong>
                <p>
                  点击分类查看明细，进入对应档案核对来源。去重公司数按公司ID统计；同一客户的多条记录不重复计为多家公司。
                </p>
              </div>
            </div>
            <div className="report-guide-item">
              <Check size={16} />
              <div>
                <strong>样衣反馈，先有结构化字段</strong>
                <p>
                  在已有的公司或自定义表属性中配置款式、版本及反馈分类，再选择去重公司数衡量覆盖。活动当前可按类型、经手人与发生时间统计，Schema业务属性尚未进入此报告。客户意见需回到原始依据核对，再由公司决定是否调整。
                </p>
              </div>
            </div>
            <div className="report-guide-boundary">
              <strong>交易研究需要订单数据</strong>
              <p>
                复购率、客单价、RFM、退货率与收入需要完整订单和退款记录。当前未连接交易系统，这些指标不在此推算；项目数和沟通量也不代表订单数或购买次数。
              </p>
            </div>
            <p className="report-footnote">
              时间边界采用
              Asia/Shanghai。看板配置只属于本人，统计每次按照最新权限计算；空值不当作已有业务事实。
            </p>
          </div>
        </Dialog>
      )}
    </section>
  );
}
