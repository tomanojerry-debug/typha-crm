import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, Pencil, RefreshCw, X } from 'lucide-react';
import type {
  ActivityAnalysisBucket,
  ActivityAnalysisCatalog,
  ActivityAnalysisConfig,
  ActivityAnalysisDimension,
  ActivityAnalysisInput,
  ActivityAnalysisResult,
  ActivityAnalysisRow,
} from '../shared/activity-analysis';
import type { ActivityDetail, ActivityField } from '../shared/business-activities';
import type { ReportQuery } from '../shared/reports';
import { api, HttpError } from './api';
import { ActivityDetailDialog, useActivitiesChanged } from './BusinessActivities';
import { reportCsvCell } from './report-templates';
import { Dialog } from './WorkspaceUI';
import './activity-feedback-report.css';

type ReportFilters = Pick<ReportQuery, 'startDate' | 'endDate' | 'customerId' | 'customerType'>;
type FieldRole = keyof ActivityAnalysisConfig['fields'];
type DimensionFilters = Partial<Record<ActivityAnalysisDimension, string>>;
const dimensions: { id: ActivityAnalysisDimension; label: string }[] = [
  { id: 'product', label: '款式／产品' },
  { id: 'issue', label: '问题分类' },
  { id: 'version', label: '版本' },
  { id: 'size', label: '尺码' },
  { id: 'color', label: '颜色' },
  { id: 'stage', label: '反馈阶段' },
];
const mappings: { id: FieldRole; label: string; required?: boolean; help: string }[] = [
  { id: 'product', label: '款式／产品', required: true, help: '选择记录真实款式或产品的字段。' },
  {
    id: 'issue',
    label: '问题分类',
    required: true,
    help: '可选文本、单选或多选；按已保存值统计。',
  },
  { id: 'version', label: '版本', help: '未配置时不区分产品版本。' },
  { id: 'size', label: '尺码', help: '只采用活动中实际记录的尺码。' },
  { id: 'color', label: '颜色', help: '只采用活动中实际记录的颜色。' },
  { id: 'stage', label: '反馈阶段', help: '可用实际选项区分样衣、售后等范围。' },
  {
    id: 'case',
    label: '独立事项编号',
    help: '可选；仅在明确编号及内容一致时合并同客户的重复活动。',
  },
];
const message = (error: unknown) => (error instanceof Error ? error.message : '读取失败，请重试');
const inaccessible = (error: unknown): error is HttpError =>
  error instanceof HttpError && [401, 403, 404].includes(error.status);
const count = (value: number) => new Intl.NumberFormat('zh-CN').format(value);

export function feedbackMappingFields(fields: ActivityField[], role: FieldRole) {
  return fields.filter((field) =>
    (role === 'issue' ? ['text', 'select', 'multi_select'] : ['text', 'select']).includes(
      field.kind,
    ),
  );
}

export function feedbackDate(value: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '日期不详';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

export function feedbackActivityIds(row: ActivityAnalysisRow) {
  return [...new Set([row.id, ...row.merged_ids])];
}

/** Export only the freshly revalidated page, with its coverage and denominator stated. */
export function activityFeedbackCsv(
  result: ActivityAnalysisResult,
  input: ActivityAnalysisInput,
  typeName: string,
) {
  const rows: unknown[][] = [
    ['导出范围', '当前页活动明细；不是全部明细'],
    ['活动类型', typeName],
    ['开始日期', input.startDate || '不限'],
    ['结束日期', input.endDate || '不限'],
    ['客户筛选', input.customerId || '全部当前授权客户'],
    ['客户类型', input.customerType || '全部'],
    ...dimensions.map((dimension) => [dimension.label, input[dimension.id] ?? '全部']),
    ['符合筛选的明细总数（含待核实）', result.total],
    ['本页起始序号', result.rows.length ? result.offset + 1 : 0],
    ['本页明细行数', result.rows.length],
    ['计入统计的独立反馈', result.summary.feedback_count],
    ['去重客户数', result.summary.customer_count],
    ['重复活动数', result.coverage.duplicate_activity_count],
    ['待核实事项数（未计入统计）', result.coverage.pending_review_count],
    [
      '读取覆盖口径',
      '以下来源失效与日期不详数量按所选活动类型及客户范围读取，未按日期或问题筛选缩小',
    ],
    ['来源失效或变化而排除的活动数', result.coverage.invalid_source_count],
    ['发生日期不详活动数', result.coverage.unknown_date_count],
    ['因日期不详被期间筛选排除的活动数', result.coverage.unknown_date_excluded_count],
    ['去重口径', result.coverage.deduplication],
    ['统计边界', '仅当前授权及所选活动类型中的已记录反馈；不是退货率或次品率'],
    [],
    [
      '活动',
      '客户',
      '发生日期',
      '款式／产品',
      '问题分类',
      '版本',
      '尺码',
      '颜色',
      '反馈阶段',
      '独立事项编号',
      '来源数',
      '统计状态',
      '关联活动编号',
    ],
    ...result.rows.map((row) => [
      row.title,
      row.customer_name,
      feedbackDate(row.occurred_at),
      row.product ?? '待确认',
      row.issues.join('、') || '待确认',
      row.version ?? '未填写',
      row.size ?? '未填写',
      row.color ?? '未填写',
      row.stage ?? '未填写',
      row.case_id ?? '',
      row.source_count,
      row.review_required ? '待核实，未计入统计' : '已计入统计',
      feedbackActivityIds(row).join('、'),
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(reportCsvCell).join(',')).join('\r\n');
}

function useAnalysisCatalog(workspace: string, revision: number) {
  const key = `${workspace}:${revision}`;
  const [state, setState] = useState<{
    key: string;
    catalog?: ActivityAnalysisCatalog;
    error?: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<ActivityAnalysisCatalog>('/reports/activity-analysis/catalog', {
      workspace,
      signal: controller.signal,
    })
      .then((catalog) => {
        if (!controller.signal.aborted) setState({ key, catalog });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ key, error: message(error) });
      });
    return () => controller.abort();
  }, [workspace, revision, key]);
  return state?.key === key ? state : null;
}

export function ActivityAnalysisConfigDialog({
  workspace,
  initial,
  busy,
  onSave,
  onClose,
}: {
  workspace: string;
  initial?: ActivityAnalysisConfig;
  busy: boolean;
  onSave: (config: ActivityAnalysisConfig) => Promise<void>;
  onClose: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const state = useAnalysisCatalog(workspace, revision);
  const [value, setValue] = useState<ActivityAnalysisConfig>(
    initial || { typeId: '', fields: { product: '', issue: '' } },
  );
  const [error, setError] = useState('');
  const type = state?.catalog?.types.find((item) => item.id === value.typeId);
  const chosen = Object.values(value.fields).filter(Boolean);
  const valid = Boolean(
    type &&
    value.fields.product &&
    value.fields.issue &&
    new Set(chosen).size === chosen.length &&
    mappings.every((mapping) => {
      const id = value.fields[mapping.id];
      return (
        (!id && !mapping.required) ||
        feedbackMappingFields(type.fields, mapping.id).some((field) => field.id === id)
      );
    }),
  );
  return (
    <Dialog
      title={initial ? '编辑反馈报告字段映射' : '选择反馈活动与字段'}
      className="feedback-config-dialog"
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || busy) return;
          setError('');
          void onSave(value).catch((problem) => setError(message(problem)));
        }}
      >
        <div className="report-dialog-body">
          <p>
            选择已有的活动类型，再明确哪些实际字段记录款式、问题等信息。此处只保存报告的读取方式。
          </p>
          {!state ? (
            <p role="status">正在读取活动配置…</p>
          ) : state.error ? (
            <div className="report-inline-error" role="alert">
              {state.error}
              <button type="button" onClick={() => setRevision((current) => current + 1)}>
                重新读取配置
              </button>
            </div>
          ) : !state.catalog?.types.length ? (
            <div className="feedback-config-empty">
              <strong>还没有可用的活动类型</strong>
              <p>
                请先到“设置 → 活动与
                Schema”配置需要的活动表单和字段，再回来选择；报告不会自动创建业务字段。
              </p>
              <button type="button" onClick={() => setRevision((current) => current + 1)}>
                刷新活动配置
              </button>
            </div>
          ) : (
            <>
              <label>
                活动类型
                <select
                  required
                  aria-label="反馈报告活动类型"
                  value={value.typeId}
                  disabled={busy}
                  onChange={(event) =>
                    setValue({ typeId: event.target.value, fields: { product: '', issue: '' } })
                  }
                >
                  <option value="">请选择实际活动类型</option>
                  {value.typeId && !type && (
                    <option value={value.typeId} disabled>
                      原活动类型已停用或不可用
                    </option>
                  )}
                  {state.catalog.types.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.schema_name}
                    </option>
                  ))}
                </select>
              </label>
              {type && (
                <div className="feedback-mapping-grid">
                  {mappings.map((mapping) => {
                    const fields = feedbackMappingFields(type.fields, mapping.id);
                    const selected = value.fields[mapping.id] || '';
                    return (
                      <label key={mapping.id}>
                        <span>
                          {mapping.label}
                          <small>{mapping.required ? '必选' : '可空'}</small>
                        </span>
                        <select
                          aria-label={`${mapping.label}对应字段`}
                          value={selected}
                          required={mapping.required}
                          disabled={busy}
                          onChange={(event) => {
                            const fields = { ...value.fields };
                            if (event.target.value) fields[mapping.id] = event.target.value;
                            else if (mapping.id === 'product' || mapping.id === 'issue')
                              fields[mapping.id] = '';
                            else delete fields[mapping.id];
                            setValue({ ...value, fields });
                          }}
                        >
                          <option value="">{mapping.required ? '请选择字段' : '不配置'}</option>
                          {selected && !fields.some((field) => field.id === selected) && (
                            <option value={selected} disabled>
                              原字段已不可用，请重新选择
                            </option>
                          )}
                          {fields.map((field) => (
                            <option
                              key={field.id}
                              value={field.id}
                              disabled={mappings.some(
                                (other) =>
                                  other.id !== mapping.id && value.fields[other.id] === field.id,
                              )}
                            >
                              {field.name}
                            </option>
                          ))}
                        </select>
                        <small>{mapping.help}</small>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="report-footnote">
                没有合适字段时，请到“设置 → 活动与
                Schema”明确配置。未知款式、版本或问题会保留为待确认，不由报告补造。
              </p>
            </>
          )}
          {error && (
            <p className="report-form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="report-dialog-footer">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="report-primary" disabled={!valid || busy}>
            {busy ? '保存中…' : initial ? '保存字段映射' : '应用并预览报告'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function Distribution({
  label,
  buckets,
  onChoose,
}: {
  label: string;
  buckets: ActivityAnalysisBucket[];
  onChoose: (key: string) => void;
}) {
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.feedback_count));
  return (
    <article className="report-card feedback-distribution">
      <header>
        <div>
          <span className="report-source-label">去重独立反馈 · 可点击筛选</span>
          <h3>{label}</h3>
        </div>
      </header>
      {buckets.length ? (
        <div className="feedback-bars">
          {buckets.map((bucket) => (
            <button
              key={bucket.key === null ? 'missing' : `value:${bucket.key}`}
              className="feedback-bar"
              disabled={bucket.key === null}
              onClick={() => bucket.key !== null && onChoose(bucket.key)}
              aria-label={`${label}：${bucket.label}，${bucket.feedback_count}项，${bucket.customer_count}位客户`}
            >
              <span title={bucket.label}>{bucket.label}</span>
              <i>
                <b style={{ width: `${(bucket.feedback_count / maximum) * 100}%` }} />
              </i>
              <strong>{count(bucket.feedback_count)}</strong>
              <small>{count(bucket.customer_count)} 位客户</small>
            </button>
          ))}
        </div>
      ) : (
        <p className="feedback-empty">当前范围没有可统计的分布。</p>
      )}
    </article>
  );
}

export function ActivityFeedbackReport({
  workspace,
  config,
  filters,
  revision,
  onEditConfig,
}: {
  workspace: string;
  config: ActivityAnalysisConfig;
  filters: ReportFilters;
  revision: number;
  onEditConfig: () => void;
}) {
  const scope = JSON.stringify({ workspace, config, filters });
  const [view, setView] = useState<{ scope: string; dimensions: DimensionFilters; offset: number }>(
    { scope, dimensions: {}, offset: 0 },
  );
  const currentView = view.scope === scope ? view : { scope, dimensions: {}, offset: 0 };
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useActivitiesChanged(workspace, refresh);
  const catalogState = useAnalysisCatalog(workspace, revision);
  const selectedType = catalogState?.catalog?.types.find((type) => type.id === config.typeId);
  const input: ActivityAnalysisInput = {
    config,
    ...filters,
    customerType: filters.customerType as ActivityAnalysisInput['customerType'],
    ...currentView.dimensions,
    offset: currentView.offset,
    limit: 20,
  };
  const inputKey = JSON.stringify(input);
  const key = JSON.stringify({ workspace, inputKey, revision, reload });
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState<{
    key: string;
    result?: ActivityAnalysisResult;
    error?: string;
  } | null>(null);
  const [selected, setSelected] = useState<{ workspace: string; id: string } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectedId = selected?.workspace === workspace ? selected.id : null;
  const [sourceWarning, setSourceWarning] = useState('');
  const [exporting, setExporting] = useState(false);
  const exportRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    exportRequest.current?.abort();
    void api<ActivityAnalysisResult>('/reports/activity-analysis/query', {
      workspace,
      method: 'POST',
      body: JSON.parse(inputKey),
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted || currentKey.current !== key) return;
        if (result.offset > 0 && result.offset >= result.total) {
          setView({
            ...currentView,
            offset: Math.max(0, Math.ceil(result.total / result.limit) - 1) * result.limit,
          });
          return;
        }
        setState({ key, result });
      })
      .catch((error) => {
        if (controller.signal.aborted || currentKey.current !== key) return;
        setState({ key, error: message(error) });
        if (inaccessible(error)) setSelected(null);
      });
    return () => {
      controller.abort();
      exportRequest.current?.abort();
    };
  }, [workspace, inputKey, key]);

  useEffect(() => {
    const visibleRefresh = () => {
      if (!document.hidden) refresh();
    };
    const timer = window.setInterval(visibleRefresh, 30000);
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', visibleRefresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedId || document.hidden) return;
    const controller = new AbortController();
    void api<ActivityDetail>(`/activities/${selectedId}`, {
      workspace,
      signal: controller.signal,
    })
      .then((detail) => {
        if (
          controller.signal.aborted ||
          selectedRef.current?.workspace !== workspace ||
          selectedRef.current.id !== selectedId
        )
          return;
        if (detail.archived) {
          setSelected(null);
          setState(null);
          setSourceWarning('所选活动已归档，请刷新报告。');
          refresh();
        } else setSourceWarning('');
      })
      .catch((error) => {
        if (
          controller.signal.aborted ||
          selectedRef.current?.workspace !== workspace ||
          selectedRef.current.id !== selectedId
        )
          return;
        setState(null);
        if (inaccessible(error)) {
          setSelected(null);
          setSourceWarning(message(error));
          refresh();
        } else {
          const warning = '暂时无法复验所选活动，已保留当前查看状态。请稍后刷新重试。';
          setSourceWarning(warning);
          setState({ key: currentKey.current, error: warning });
        }
      });
    return () => controller.abort();
  }, [workspace, selectedId, revision, reload, refresh]);

  function openActivity(id: string) {
    setSourceWarning('');
    setSelected({ workspace, id });
  }

  function choose(dimension: ActivityAnalysisDimension, value: string) {
    const next = { ...currentView.dimensions };
    if (value) next[dimension] = value;
    else delete next[dimension];
    setView({ scope, dimensions: next, offset: 0 });
  }

  async function exportPage() {
    if (exportRequest.current) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExporting(true);
    try {
      const result = await api<ActivityAnalysisResult>('/reports/activity-analysis/query', {
        workspace,
        method: 'POST',
        body: JSON.parse(inputKey),
        signal: controller.signal,
      });
      if (controller.signal.aborted || currentKey.current !== key) return;
      setState({ key, result });
      const blob = new Blob(
        [activityFeedbackCsv(result, input, selectedType?.name || '所选活动类型')],
        { type: 'text/csv;charset=utf-8' },
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `售后反馈-当前页明细-第${Math.floor(result.offset / result.limit) + 1}页.csv`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (controller.signal.aborted || currentKey.current !== key) return;
      setState({ key, error: message(error) });
      if (inaccessible(error)) setSelected(null);
    } finally {
      if (exportRequest.current === controller) {
        exportRequest.current = null;
        setExporting(false);
      }
    }
  }

  const visible = state?.key === key ? state : null;
  const result = visible?.result;
  const activeDimensions = dimensions.filter((dimension) => config.fields[dimension.id]);
  return (
    <section className="feedback-report" aria-label="售后反馈与产品改进报告">
      <div className="feedback-heading">
        <div>
          <span className="report-eyebrow">PRODUCT FEEDBACK</span>
          <h2>反馈概况</h2>
          <p>
            {selectedType ? `活动类型：${selectedType.name}` : '按已配置的活动类型读取'}
            {!config.fields.stage && ' · 未配置反馈阶段，覆盖本活动类型中的全部阶段'}
          </p>
        </div>
        <button onClick={onEditConfig}>
          <Pencil size={13} />
          字段映射
        </button>
      </div>
      {sourceWarning && (
        <p className="feedback-warning" role="alert">
          {sourceWarning}
        </p>
      )}
      <div className="feedback-filters">
        {activeDimensions.map((dimension) => {
          const value = currentView.dimensions[dimension.id] || '';
          const buckets = result?.groups[dimension.id] || [];
          return (
            <label key={dimension.id}>
              {dimension.label}
              <select
                aria-label={`筛选${dimension.label}`}
                value={value}
                onChange={(event) => choose(dimension.id, event.target.value)}
              >
                <option value="">全部</option>
                {value && !buckets.some((bucket) => bucket.key === value) && (
                  <option value={value}>{value}</option>
                )}
                {buckets
                  .filter((bucket) => bucket.key !== null)
                  .map((bucket) => (
                    <option key={bucket.key} value={bucket.key!}>
                      {bucket.label}
                    </option>
                  ))}
              </select>
            </label>
          );
        })}
        {!!Object.keys(currentView.dimensions).length && (
          <button onClick={() => setView({ scope, dimensions: {}, offset: 0 })}>
            <X size={12} />
            清除反馈筛选
          </button>
        )}
      </div>
      {visible?.error ? (
        <div className="report-inline-error" role="alert">
          {visible.error}
          <button onClick={refresh}>
            <RefreshCw size={13} />
            重新读取报告
          </button>
          <span>字段或活动类型已停用时，请重新配置字段映射。</span>
        </div>
      ) : !result ? (
        <div className="feedback-empty" role="status">
          正在复验来源并统计当前授权反馈…
        </div>
      ) : (
        <>
          <div className="feedback-summary">
            {[
              ['独立反馈', result.summary.feedback_count, '去重后计入统计的事项'],
              ['涉及客户', result.summary.customer_count, '按客户ID去重'],
              ['计入统计的原活动', result.summary.activity_count, '重复引用不会增加独立反馈'],
              ['原文来源', result.summary.source_count, '可回看原话的来源'],
            ].map(([label, value, help]) => (
              <article className="report-card" key={label}>
                <span>{label}</span>
                <strong>{count(Number(value))}</strong>
                <small>{help}</small>
              </article>
            ))}
          </div>
          <div className="feedback-coverage">
            <strong>数据覆盖与待确认</strong>
            <p>读取覆盖按所选活动类型及客户范围计算，不随日期或问题筛选缩小。</p>
            <div>
              <span>扫描活动 {count(result.coverage.scanned_count)}</span>
              <span>来源失效／变化而排除 {count(result.coverage.invalid_source_count)}</span>
              <span>发生日期不详 {count(result.coverage.unknown_date_count)}</span>
              {result.coverage.unknown_date_excluded_count > 0 && (
                <span>
                  因日期不详未进入期间统计 {count(result.coverage.unknown_date_excluded_count)}
                </span>
              )}
            </div>
            <p>以下为当前筛选范围内的去重与字段完整度。</p>
            <div>
              <span>重复活动 {count(result.coverage.duplicate_activity_count)}</span>
              <span>待核实 {count(result.coverage.pending_review_count)}</span>
              {activeDimensions.map((dimension) => (
                <span key={dimension.id}>
                  {dimension.label}未填写 {count(result.coverage.missing_values[dimension.id] || 0)}
                </span>
              ))}
            </div>
            <p>{result.coverage.deduplication}</p>
          </div>
          <div className="feedback-heading">
            <div>
              <h2>问题与款式分布</h2>
              <p>一条反馈可以包含多个问题，各分组的事项数与客户数不可直接相加。</p>
            </div>
          </div>
          <div className="feedback-distributions">
            <Distribution
              label="问题分类"
              buckets={result.groups.issue}
              onChoose={(value) => choose('issue', value)}
            />
            <Distribution
              label="款式／产品"
              buckets={result.groups.product}
              onChoose={(value) => choose('product', value)}
            />
          </div>
          <div className="feedback-heading feedback-detail-heading">
            <div>
              <h2>活动明细与原话</h2>
              <p>
                共 {count(result.total)} 条明细（含待核实）；独立反馈统计为{' '}
                {count(result.summary.feedback_count)} 项。待核实明细不计入上方统计。
              </p>
            </div>
            <button disabled={exporting} onClick={() => void exportPage()}>
              <Download size={13} />
              {exporting ? '正在复验导出…' : '导出当前页明细 CSV'}
            </button>
          </div>
          <div className="report-drill-table feedback-detail-table">
            <table>
              <thead>
                <tr>
                  <th>活动／客户</th>
                  <th>发生日期</th>
                  <th>款式／产品</th>
                  <th>问题分类</th>
                  {dimensions
                    .filter(
                      (dimension) =>
                        !['product', 'issue'].includes(dimension.id) && config.fields[dimension.id],
                    )
                    .map((dimension) => (
                      <th key={dimension.id}>{dimension.label}</th>
                    ))}
                  <th>来源与统计状态</th>
                  <th>原话</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  const ids = feedbackActivityIds(row);
                  return (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.title}</strong>
                        <small>{row.customer_name}</small>
                      </td>
                      <td>{feedbackDate(row.occurred_at)}</td>
                      <td>{row.product ?? '待确认'}</td>
                      <td>{row.issues.join('、') || '待确认'}</td>
                      {dimensions
                        .filter(
                          (dimension) =>
                            !['product', 'issue'].includes(dimension.id) &&
                            config.fields[dimension.id],
                        )
                        .map((dimension) => (
                          <td key={dimension.id}>
                            {row[dimension.id as 'version' | 'size' | 'color' | 'stage'] ??
                              '未填写'}
                          </td>
                        ))}
                      <td>
                        <span>{count(row.source_count)} 份来源</span>
                        <small>
                          {row.review_required
                            ? row.review_reason === 'case_conflict'
                              ? '事项编号内容冲突，待核实'
                              : '字段值待核实'
                            : '已计入统计'}
                        </small>
                      </td>
                      <td>
                        {ids.length === 1 ? (
                          <button onClick={() => openActivity(row.id)}>查看原话 →</button>
                        ) : (
                          <details className="feedback-source-links">
                            <summary>查看 {ids.length} 条活动原话</summary>
                            {ids.map((id, index) => (
                              <button key={id} onClick={() => openActivity(id)}>
                                活动 {index + 1} →
                              </button>
                            ))}
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!result.rows.length && (
              <p className="feedback-empty">
                这个范围还没有符合条件的活动明细。可调整筛选，或从指定客户资料整理已有活动。
              </p>
            )}
          </div>
          <div className="report-pagination">
            <span>
              {result.rows.length ? result.offset + 1 : 0}–{result.offset + result.rows.length} /{' '}
              {count(result.total)} 条明细
            </span>
            <div>
              <button
                disabled={result.offset === 0}
                onClick={() =>
                  setView({ ...currentView, offset: Math.max(0, result.offset - result.limit) })
                }
              >
                <ArrowLeft size={12} />
                上一页
              </button>
              <button
                disabled={result.offset + result.rows.length >= result.total}
                onClick={() => setView({ ...currentView, offset: result.offset + result.limit })}
              >
                下一页
                <ArrowRight size={12} />
              </button>
            </div>
          </div>
          <p className="report-footnote">
            仅反映当前授权、所选活动类型和已记录资料。发生日期不详的记录不会借创建日期进入期间统计；没有销量与订单分母，不据此计算退货率或次品率。
          </p>
        </>
      )}
      {selectedId && (
        <ActivityDetailDialog
          key={`${workspace}:${selectedId}`}
          workspace={workspace}
          activityId={selectedId}
          editable={false}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </section>
  );
}
