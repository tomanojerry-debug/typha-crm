import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Box,
  Receipt,
  FileText,
  Package,
  Briefcase,
  Tag,
  CalendarDays,
  ClipboardList,
  Truck,
  ShoppingBag,
  Heart,
  Layers,
  Plus,
  Search,
  Settings2,
  ChevronRight,
  Pencil,
  Archive,
  RotateCcw,
  Hash,
  LockKeyhole,
  LayoutGrid,
  Check,
  X,
  Sparkles,
  LoaderCircle,
  ChevronLeft,
  Columns3,
  LayoutList,
  SlidersHorizontal,
  ArrowDownUp,
  Table2,
  PanelRight,
} from 'lucide-react';
import { api } from './api';
import { Dialog, Popover, closeMenus } from './WorkspaceUI';
import { ResizableTable, ColumnResizeHandle, ExpandableCell } from './ResizableTable';
import { KanbanBoard, KanbanCard } from './KanbanBoard';
import { RecordCardField } from './RecordCardField';
import { useKanbanDisplay } from './useKanbanDisplay';
import {
  customObjectIcons,
  customObjectColors,
  customAttributeKinds,
  customSystemAttributes,
  type CustomObject,
  type CustomAttribute,
  type CustomRecord,
  type CustomValue,
  type CustomAttributeRun,
  isEmptyCustomValue,
} from '../shared/custom-objects';
import './custom-objects.css';

const icons = {
  box: Box,
  receipt: Receipt,
  file: FileText,
  package: Package,
  briefcase: Briefcase,
  tag: Tag,
  calendar: CalendarDays,
  clipboard: ClipboardList,
  truck: Truck,
  'shopping-bag': ShoppingBag,
  heart: Heart,
  layers: Layers,
};
const iconNames = [
  '方块',
  '票据',
  '文件',
  '包裹',
  '公文包',
  '标签',
  '日历',
  '清单',
  '运输',
  '购物袋',
  '爱心',
  '图层',
];
const colorNames = ['灰色', '蓝色', '绿色', '紫色', '粉色', '橙色', '红色', '青色'];
const msg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
const time = (s: string) =>
  new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function CustomObjectIcon({
  object,
  size = 16,
  badge = false,
}: {
  object: Pick<CustomObject, 'icon' | 'color'>;
  size?: number;
  badge?: boolean;
}) {
  const Icon = icons[object.icon] || Box;
  return (
    <span
      className={badge ? 'custom-object-icon badge-icon' : 'custom-object-icon'}
      style={{ color: customObjectColors[object.color] }}
    >
      <Icon size={size} />
    </span>
  );
}

export function CreateObjectDialog({
  workspace,
  onClose,
  onCreated,
  presentation = 'entity',
}: {
  workspace: string;
  onClose: () => void;
  onCreated: (o: CustomObject) => void;
  presentation?: 'entity' | 'table';
}) {
  const [name, setName] = useState(''),
    [singular, setSingular] = useState(''),
    [slug, setSlug] = useState('');
  const [singularEdited, setSingularEdited] = useState(false),
    [slugEdited, setSlugEdited] = useState(false);
  const [icon, setIcon] = useState<CustomObject['icon']>('box'),
    [color, setColor] = useState<CustomObject['color']>('gray'),
    [palette, setPalette] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const o = await api<CustomObject>('/custom-objects', {
        workspace,
        method: 'POST',
        body: { name, singular_name: singular || name, slug, icon, color },
      });
      onCreated(o);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={presentation === 'table' ? '新建表格' : '创建自定义实体'}
      onClose={() => !busy && onClose()}
      className="custom-object-dialog"
    >
      <form onSubmit={submit}>
        <div className="custom-create-body">
          <div className="custom-name-row">
            <div className="custom-icon-picker">
              <button
                type="button"
                aria-label="选择实体图标与颜色"
                aria-expanded={palette}
                onClick={() => setPalette(!palette)}
              >
                <CustomObjectIcon object={{ icon, color }} size={25} />
              </button>
              {palette && (
                <div className="custom-icon-palette">
                  <div className="custom-icon-grid">
                    {customObjectIcons.map((v, i) => (
                      <button
                        key={v}
                        type="button"
                        aria-label={iconNames[i]}
                        aria-pressed={icon === v}
                        onClick={() => setIcon(v)}
                      >
                        <CustomObjectIcon object={{ icon: v, color }} size={20} />
                      </button>
                    ))}
                  </div>
                  <div className="custom-color-grid">
                    {Object.entries(customObjectColors).map(([v, c], i) => (
                      <button
                        type="button"
                        key={v}
                        style={{ background: c }}
                        aria-label={colorNames[i]}
                        aria-pressed={color === v}
                        onClick={() => setColor(v as CustomObject['color'])}
                      >
                        {color === v && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="custom-palette-done"
                    onClick={() => setPalette(false)}
                  >
                    完成
                  </button>
                </div>
              )}
            </div>
            <label>
              {presentation === 'table' ? '表格名称' : '实体名称'}
              <input
                autoFocus
                required
                maxLength={60}
                placeholder="例如：发票"
                value={name}
                onChange={(e) => {
                  const s = e.target.value;
                  setName(s);
                  if (!singularEdited) setSingular(s);
                  if (!slugEdited)
                    setSlug(
                      s
                        .toLowerCase()
                        .replace(/[^a-z0-9_]+/g, '_')
                        .replace(/^_+|_+$/g, ''),
                    );
                }}
              />
            </label>
            <label>
              单条记录名称
              <input
                required
                maxLength={60}
                placeholder="例如：发票"
                value={singular}
                onChange={(e) => {
                  setSingularEdited(true);
                  setSingular(e.target.value);
                }}
              />
            </label>
          </div>
          <label>
            标识 / Slug
            <div className="custom-slug-input">
              <span>/</span>
              <input
                required
                pattern="[a-z][a-z0-9_]{1,47}"
                maxLength={48}
                placeholder="例如：invoices"
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                }}
              />
            </div>
          </label>
          <p className="custom-help">
            用于识别实体；创建后不可修改。使用 2–48 位小写英文字母、数字或下划线，以字母开头。
          </p>
          <p className="custom-create-note">
            {presentation === 'table'
              ? '创建后打开空白记录表格，并加入左侧「资料库」。默认提供名称、所属公司、关联项目、创建时间等通用字段，可在「管理属性」中添加列。'
              : '创建后会出现在左侧「资料库」，你可以继续设置属性和新建记录。'}
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '创建中…' : presentation === 'table' ? '创建表格' : '创建实体'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function AttributeDialog({
  workspace,
  object,
  field,
  onClose,
  onSaved,
}: {
  workspace: string;
  object: CustomObject;
  field: CustomAttribute | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(field?.name || ''),
    [kind, setKind] = useState<CustomAttribute['kind']>(field?.kind || 'text');
  const [options, setOptions] = useState(field?.options.join('\n') || ''),
    [required, setRequired] = useState(field?.required || false),
    [unique, setUnique] = useState(field?.is_unique || false),
    [currency, setCurrency] = useState(field?.currency || 'CNY');
  const [description, setDescription] = useState(field?.description || ''),
    [aiEnabled, setAiEnabled] = useState(field?.ai_enabled || false),
    [guidance, setGuidance] = useState(field?.guidance || '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const canUnique = ['text', 'number', 'date'].includes(kind),
    hasOptions = ['select', 'multi_select'].includes(kind);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/custom-objects/${object.id}/attributes${field ? '/' + field.id : ''}`, {
        workspace,
        method: field ? 'PUT' : 'POST',
        body: {
          name,
          description,
          kind,
          required,
          is_unique: unique && canUnique,
          currency,
          options: hasOptions
            ? options
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          archived: field?.archived || false,
          ai_enabled: aiEnabled,
          guidance,
          ...(field ? { version: field.version } : {}),
        },
      });
      onSaved();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={field ? '编辑属性' : '创建属性'}
      onClose={() => !busy && onClose()}
      className="custom-attribute-dialog"
    >
      <form onSubmit={submit}>
        <div className="custom-form-body">
          <label>
            属性名称
            <input
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：发票金额"
            />
          </label>
          <label>
            类型
            <select
              disabled={!!field}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as CustomAttribute['kind']);
                setUnique(false);
              }}
            >
              {Object.entries(customAttributeKinds).map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {kind === 'currency' && (
            <label>
              币种
              <select
                disabled={!!field}
                value={currency}
                onChange={(e) => setCurrency(e.target.value as CustomAttribute['currency'])}
              >
                {['CNY', 'USD', 'EUR', 'GBP', 'JPY'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          {hasOptions && (
            <label>
              选项（每行一个）
              <textarea
                required
                rows={5}
                maxLength={2500}
                value={options}
                onChange={(e) => setOptions(e.target.value)}
                placeholder={'待确认\n已确认'}
              />
            </label>
          )}
          <div className="custom-constraint-box">
            <strong>约束</strong>
            <label className="custom-check">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              <span>
                必填 <small>保存记录时必须填写</small>
              </span>
            </label>
            <label className="custom-check">
              <input
                type="checkbox"
                disabled={!canUnique}
                checked={unique && canUnique}
                onChange={(e) => setUnique(e.target.checked)}
              />
              <span>
                唯一{' '}
                <small>
                  {canUnique ? '同一实体内不可重复，区分大小写' : '当前仅文本、数字和日期支持'}
                </small>
              </span>
            </label>
          </div>
          <p className="custom-help">
            类型创建后固定；已有选项保留，可追加新选项。
            {unique && canUnique ? '唯一文本最多250个字符。' : ''}
          </p>
          <label>
            属性说明
            <textarea
              rows={2}
              maxLength={1000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="说明这个属性记录什么，以及适用范围"
            />
          </label>
          <div className="custom-constraint-box">
            <label className="custom-check">
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => setAiEnabled(e.target.checked)}
              />
              <span>
                <Sparkles size={13} /> AI 整理 <small>按当前公司和项目的原文证据填入空值</small>
              </span>
            </label>
            {aiEnabled && (
              <label>
                AI 整理指引
                <textarea
                  required
                  rows={3}
                  maxLength={4000}
                  value={guidance}
                  onChange={(e) => setGuidance(e.target.value)}
                  placeholder="例如：根据客户明确介绍的服装品类填写；没有依据时返回无相关信息。"
                />
              </label>
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : field ? '保存属性' : '创建属性'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export function CustomObjectSettings({
  workspace,
  object,
  onBack,
  onChanged,
  onOpen,
}: {
  workspace: string;
  object: CustomObject;
  onBack: () => void;
  onChanged: () => void;
  onOpen?: (o: CustomObject) => void;
}) {
  const [current, setCurrent] = useState(object),
    [fields, setFields] = useState<CustomAttribute[]>([]),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState<CustomAttribute | 'new' | null>(null),
    [archive, setArchive] = useState<CustomAttribute | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    setError('');
    Promise.all([
      api<CustomAttribute[]>(`/custom-objects/${object.id}/attributes`, {
        workspace,
        signal: c.signal,
      }),
      api<CustomObject[]>('/custom-objects', { workspace, signal: c.signal }),
    ])
      .then(([fields, objects]) => {
        if (!c.signal.aborted) {
          setFields(fields);
          setCurrent(objects.find((o) => o.id === object.id) || object);
          setReady(true);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(msg(e));
      });
    return () => c.abort();
  }, [workspace, object.id, revision]);
  function changed() {
    setDialog(null);
    setArchive(null);
    setRevision((n) => n + 1);
    onChanged();
  }
  const active = fields.filter((f) => !f.archived);
  const shown = fields.filter(
    (f) =>
      (filter === 'archived' ? f.archived : !f.archived) &&
      filter !== 'system' &&
      f.name.toLowerCase().includes(query.toLowerCase()),
  );
  const systems =
    filter === 'custom' || filter === 'archived'
      ? []
      : customSystemAttributes.filter((f) => f.name.includes(query));
  return (
    <section className="entity-settings">
      <header className="entity-heading">
        <div className="entity-title">
          <h1>实体与关系</h1>
        </div>
      </header>
      <div className="entity-settings-body is-object custom-settings-body">
        <button className="entity-back-button" onClick={onBack}>
          <ArrowLeft size={14} />
          返回全部实体
        </button>
        <div className="custom-object-summary">
          <CustomObjectIcon object={current} size={30} badge />
          <div>
            <div>
              <h2>{current.name}</h2>
              <span className="entity-badge custom-badge">自定义实体</span>
            </div>
            <p>
              管理实体属性与记录设置 <span>/{current.slug}</span>
            </p>
          </div>
          {onOpen && (
            <button onClick={() => onOpen(current)}>
              打开资料库
              <ChevronRight size={14} />
            </button>
          )}
        </div>
        <div className="entity-tabs">
          <button aria-current="page">
            <LayoutGrid size={15} />
            属性<span>{active.length + 6}</span>
          </button>
        </div>
        <div className="entity-attributes-heading">
          <div>
            <h3>属性</h3>
            <p>定义每条{current.singular_name}保存的数据。</p>
          </div>
          <button className="primary" onClick={() => setDialog('new')}>
            <Plus size={15} />
            创建属性
          </button>
        </div>
        <div className="entity-toolbar">
          <label className="entity-search">
            <Search size={15} />
            <input
              aria-label="搜索属性"
              placeholder="搜索属性…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select aria-label="筛选属性" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">全部属性</option>
            <option value="system">系统</option>
            <option value="custom">自定义</option>
            <option value="archived">已停用</option>
          </select>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
            <button onClick={() => setRevision((n) => n + 1)}>重新加载</button>
          </p>
        )}
        {!ready && !error ? (
          <p className="entity-state">正在读取属性…</p>
        ) : (
          <div className="entity-table-wrap">
            <table className="entity-attribute-table">
              <thead>
                <tr>
                  <th>
                    <span className="entity-table-label">
                      <Box size={14} />
                      名称
                    </span>
                  </th>
                  <th>
                    <span className="entity-table-label">
                      <LayoutGrid size={14} />
                      类型
                    </span>
                  </th>
                  <th>
                    <span className="entity-table-label">
                      <LockKeyhole size={14} />
                      约束
                    </span>
                  </th>
                  <th>属性标记</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {systems.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <span className="custom-field-name">
                        <Hash size={15} />
                        {f.name}
                      </span>
                    </td>
                    <td>{f.type}</td>
                    <td>{f.constraint || '—'}</td>
                    <td>
                      <span className="entity-badge">系统</span>
                      {'readonly' in f && f.readonly && (
                        <span className="custom-muted-tag">只读</span>
                      )}
                    </td>
                    <td />
                  </tr>
                ))}
                {shown.map((f) => (
                  <tr key={f.id} className={f.archived ? 'custom-archived' : ''}>
                    <td>
                      <button
                        className="custom-field-name custom-text-button"
                        onClick={() => setDialog(f)}
                      >
                        <LayoutGrid size={15} />
                        {f.name}
                      </button>
                    </td>
                    <td>
                      {customAttributeKinds[f.kind]}
                      {f.kind === 'currency' && (
                        <small className="custom-muted"> {f.currency}</small>
                      )}
                    </td>
                    <td>
                      {[f.required ? '必填' : '', f.is_unique ? '唯一' : '']
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td>
                      {f.ai_enabled && (
                        <span className="entity-badge">
                          <Sparkles size={11} /> AI 整理
                        </span>
                      )}
                      {f.archived ? (
                        <span className="entity-badge">已停用</span>
                      ) : !f.ai_enabled ? (
                        <span className="custom-muted">—</span>
                      ) : null}
                    </td>
                    <td>
                      <div className="custom-row-actions">
                        <button
                          className="icon-button"
                          aria-label={`编辑${f.name}`}
                          onClick={() => setDialog(f)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`${f.archived ? '恢复' : '停用'}${f.name}`}
                          onClick={() => {
                            setArchive(f);
                            setActionError('');
                          }}
                        >
                          {f.archived ? <RotateCcw size={14} /> : <Archive size={14} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!systems.length && !shown.length && (
                  <tr>
                    <td colSpan={5} className="custom-empty-cell">
                      没有匹配的属性
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="custom-help custom-type-explanation">
          类型定义数据格式；约束决定必填或唯一；属性标记表示系统来源和只读行为。所属公司和项目为单向记录引用，项目仅可选择同公司资料。
        </p>
      </div>
      {dialog && (
        <AttributeDialog
          workspace={workspace}
          object={current}
          field={dialog === 'new' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={changed}
        />
      )}
      {archive && (
        <Dialog
          title={archive.archived ? '恢复属性' : '停用属性'}
          onClose={() => !busy && setArchive(null)}
        >
          <div className="custom-form-body">
            <p>
              {archive.archived
                ? '恢复后可以继续使用已有属性值。'
                : '停用后从录入表单中隐藏，已保存数据会保留。'}
            </p>
            <strong>{archive.name}</strong>
            {actionError && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
          </div>
          <footer>
            <button disabled={busy} onClick={() => setArchive(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const { id, object_id, version, ...rest } = archive;
                  await api(`/custom-objects/${current.id}/attributes/${id}`, {
                    workspace,
                    method: 'PUT',
                    body: { ...rest, version, archived: !archive.archived },
                  });
                  changed();
                } catch (e) {
                  setActionError(msg(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '保存中…' : archive.archived ? '恢复属性' : '停用属性'}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}

type Options = {
  customers: { id: string; name: string; can_edit: boolean }[];
  projects: { id: string; name: string }[];
};
function RecordDialog({
  workspace,
  object,
  fields,
  record,
  onClose,
  onSaved,
}: {
  workspace: string;
  object: CustomObject;
  fields: CustomAttribute[];
  record: CustomRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(record?.name || ''),
    [customer, setCustomer] = useState(record?.customer_id || ''),
    [project, setProject] = useState(record?.project_id || '');
  const [values, setValues] = useState<Record<string, CustomValue>>(record?.values || {}),
    [customerQuery, setCustomerQuery] = useState(''),
    [options, setOptions] = useState<Options>({ customers: [], projects: [] });
  const [optionsReady, setOptionsReady] = useState(false),
    [optionsError, setOptionsError] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [archive, setArchive] = useState(false);
  const readonly = !!record && !record.can_edit;
  useEffect(() => {
    const c = new AbortController();
    setOptionsReady(false);
    setOptionsError('');
    const timer = setTimeout(() => {
      const p = new URLSearchParams({ q: customerQuery });
      if (customer) p.set('customer_id', customer);
      api<Options>(`/custom-objects/${object.id}/record-options?${p}`, {
        workspace,
        signal: c.signal,
      })
        .then((o) => {
          if (!c.signal.aborted) {
            setOptions(o);
            setOptionsReady(true);
          }
        })
        .catch((e) => {
          if (!c.signal.aborted) setOptionsError(msg(e));
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [workspace, object.id, customer, customerQuery]);
  function setValue(id: string, value: CustomValue) {
    setValues((v) => ({ ...v, [id]: value }));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || readonly) return;
    setBusy(true);
    setError('');
    try {
      await api(`/custom-objects/${object.id}/records${record ? '/' + record.id : ''}`, {
        workspace,
        method: record ? 'PUT' : 'POST',
        body: {
          name,
          customer_id: customer,
          project_id: project || null,
          values,
          object_version: object.version,
          ...(record
            ? { version: record.version, archived: record.archived_at ? false : archive }
            : {}),
        },
      });
      onSaved();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        record
          ? `${readonly ? '查看' : '编辑'}${object.singular_name}`
          : `新建记录 · ${object.singular_name}`
      }
      onClose={() => !busy && onClose()}
      className="custom-record-dialog"
    >
      <form onSubmit={submit}>
        <div className="custom-form-body">
          <label>
            名称 <span className="custom-required">*</span>
            <input
              required
              maxLength={120}
              disabled={readonly}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`输入${object.singular_name}名称`}
            />
          </label>
          <div className="custom-record-grid">
            <label>
              所属公司 <span className="custom-required">*</span>
              {record ? (
                <input readOnly value={record.customer_name} />
              ) : (
                <>
                  <input
                    placeholder="搜索公司…"
                    aria-label="搜索所属公司"
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                  />
                  <select
                    aria-label="所属公司"
                    required
                    disabled={!optionsReady}
                    value={customer}
                    onChange={(e) => {
                      setCustomer(e.target.value);
                      setProject('');
                    }}
                  >
                    <option value="">{optionsReady ? '选择公司' : '正在加载…'}</option>
                    {options.customers
                      .filter((c) => c.can_edit)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </>
              )}
            </label>
            <label>
              关联项目
              <select
                disabled={readonly || !customer || !optionsReady}
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">不指定项目</option>
                {project && !options.projects.some((p) => p.id === project) && (
                  <option value={project}>{record?.project_name || '原关联项目'}</option>
                )}
                {options.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {optionsError && (
            <p className="error" role="alert">
              {optionsError}
            </p>
          )}
          <div className="custom-record-fields">
            {fields
              .filter((f) => !f.archived)
              .map((f) => (
                <div key={f.id} className="custom-record-field">
                  <label htmlFor={`custom-value-${f.id}`}>
                    {f.name}
                    {f.required && <span className="custom-required"> *</span>}
                    {f.kind === 'currency' && <small> {f.currency}</small>}
                  </label>
                  {f.kind === 'checkbox' ? (
                    <select
                      id={`custom-value-${f.id}`}
                      disabled={readonly}
                      required={f.required}
                      value={values[f.id] === true ? 'true' : values[f.id] === false ? 'false' : ''}
                      onChange={(e) =>
                        setValue(f.id, e.target.value === '' ? null : e.target.value === 'true')
                      }
                    >
                      <option value="">未填写</option>
                      <option value="true">是</option>
                      <option value="false">否</option>
                    </select>
                  ) : f.kind === 'select' ? (
                    <select
                      id={`custom-value-${f.id}`}
                      disabled={readonly}
                      required={f.required}
                      value={String(values[f.id] || '')}
                      onChange={(e) => setValue(f.id, e.target.value || null)}
                    >
                      <option value="">请选择</option>
                      {f.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : f.kind === 'multi_select' ? (
                    <div className="custom-multi-options" role="group" aria-label={f.name}>
                      {f.options.map((o) => (
                        <label key={o} className="custom-check">
                          <input
                            type="checkbox"
                            disabled={readonly}
                            checked={
                              Array.isArray(values[f.id]) && (values[f.id] as string[]).includes(o)
                            }
                            onChange={(e) => {
                              const old = Array.isArray(values[f.id])
                                ? (values[f.id] as string[])
                                : [];
                              setValue(
                                f.id,
                                e.target.checked ? [...old, o] : old.filter((v) => v !== o),
                              );
                            }}
                          />
                          {o}
                        </label>
                      ))}
                    </div>
                  ) : f.kind === 'text' ? (
                    <textarea
                      id={`custom-value-${f.id}`}
                      rows={2}
                      disabled={readonly}
                      required={f.required}
                      maxLength={f.is_unique ? 250 : 5000}
                      value={String(values[f.id] ?? '')}
                      onChange={(e) => setValue(f.id, e.target.value)}
                    />
                  ) : (
                    <input
                      id={`custom-value-${f.id}`}
                      disabled={readonly}
                      required={f.required}
                      type={
                        f.kind === 'date'
                          ? 'date'
                          : f.kind === 'timestamp'
                            ? 'datetime-local'
                            : 'number'
                      }
                      step={f.kind === 'rating' ? '1' : f.kind === 'timestamp' ? '60' : 'any'}
                      min={f.kind === 'rating' ? 1 : undefined}
                      max={f.kind === 'rating' ? 5 : undefined}
                      value={
                        f.kind === 'timestamp' && values[f.id]
                          ? new Date(new Date(String(values[f.id])).getTime() + 8 * 3600000)
                              .toISOString()
                              .slice(0, 16)
                          : String(values[f.id] ?? '')
                      }
                      onChange={(e) =>
                        setValue(
                          f.id,
                          e.target.value === ''
                            ? null
                            : f.kind === 'date'
                              ? e.target.value
                              : f.kind === 'timestamp'
                                ? new Date(e.target.value + ':00+08:00').toISOString()
                                : Number(e.target.value),
                        )
                      }
                    />
                  )}
                </div>
              ))}
          </div>
          {record && (
            <div className="custom-record-meta">
              <span>编号：{record.id}</span>
              <span>
                {record.created_by_name} 创建于 {time(record.created_at)}
              </span>
              <span>更新于 {time(record.updated_at)}</span>
            </div>
          )}
          {record && !readonly && !record.archived_at && (
            <label className="custom-check custom-archive-check">
              <input
                type="checkbox"
                checked={archive}
                onChange={(e) => setArchive(e.target.checked)}
              />
              归档此记录（可恢复）
            </label>
          )}
          {record?.archived_at && <p className="custom-help">保存后恢复此记录。</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            {readonly ? '关闭' : '取消'}
          </button>
          {!readonly && (
            <button className="primary" disabled={busy || !customer || !optionsReady}>
              {busy ? '保存中…' : record?.archived_at ? '恢复记录' : '保存记录'}
            </button>
          )}
        </footer>
      </form>
    </Dialog>
  );
}

function displayValue(f: CustomAttribute, v: CustomValue | undefined) {
  if (v === null || v === undefined) return '—';
  if (f.kind === 'checkbox') return v ? '是' : '否';
  if (f.kind === 'currency')
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: f.currency }).format(
      Number(v),
    );
  if (f.kind === 'timestamp') return time(String(v));
  if (f.kind === 'rating') return '★'.repeat(Number(v));
  return Array.isArray(v) ? v.join('、') : String(v);
}

function CustomAttributeCell({
  workspace,
  object,
  field,
  record,
  onSaved,
  onEdit,
}: {
  workspace: string;
  object: CustomObject;
  field: CustomAttribute;
  record: CustomRecord;
  onSaved: (record: CustomRecord) => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [showEvidence, setShowEvidence] = useState(false);
  const scope = useRef<object>({}),
    controller = useRef<AbortController | null>(null),
    lock = useRef(false);
  useEffect(() => {
    const token = {};
    scope.current = token;
    return () => {
      scope.current = {};
      controller.current?.abort();
    };
  }, [workspace, object.id, record.id]);
  const value = record.values[field.id],
    provenance = record.field_provenance?.[field.id];
  const empty = isEmptyCustomValue(value),
    generated = provenance?.origin === 'ai';
  const label =
    generated && provenance.state === 'no_information' && empty
      ? '无相关信息'
      : displayValue(field, value);
  async function generate() {
    if (lock.current || !empty || !record.can_edit || record.archived_at) return;
    lock.current = true;
    const token = scope.current,
      request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    let applying = false;
    try {
      const run = await api<CustomAttributeRun>(
        `/custom-objects/${object.id}/records/${record.id}/attribute-runs`,
        {
          workspace,
          method: 'POST',
          signal: request.signal,
          body: {
            attribute_id: field.id,
            attribute_version: field.version,
            object_version: object.version,
            record_version: record.version,
            use_saved_guidance: true,
            only_empty: true,
          },
        },
      );
      if (request.signal.aborted || scope.current !== token) return;
      applying = true;
      const saved = await api<CustomRecord>(
        `/custom-objects/${object.id}/records/${record.id}/attribute-runs/${run.id}/apply`,
        { workspace, method: 'POST', body: {} },
      );
      if (scope.current === token) onSaved(saved);
    } catch (e) {
      if (scope.current === token && (!request.signal.aborted || applying)) setError(msg(e));
    } finally {
      lock.current = false;
      if (scope.current === token) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <div className="custom-ai-cell attribute-table-cell" onClick={(e) => e.stopPropagation()}>
      <div className="custom-ai-value" aria-busy={busy}>
        {(field.ai_enabled || generated) && (
          <button
            type="button"
            className={`attribute-star${generated ? ' is-generated' : ''}`}
            aria-label={`${generated && !empty ? '查看AI依据' : 'AI整理'}${record.name}的${field.name}`}
            title={
              busy
                ? '正在按证据整理…'
                : generated && !empty
                  ? '查看 AI 整理依据'
                  : !empty
                    ? '已有内容，已保留'
                    : '按已保存指引 AI 整理'
            }
            disabled={
              busy ||
              (!generated && !empty) ||
              (empty && (!field.ai_enabled || !record.can_edit || !!record.archived_at))
            }
            onClick={() => {
              if (generated && !empty) setShowEvidence(true);
              else void generate();
            }}
          >
            {busy ? <LoaderCircle size={13} className="attribute-spin" /> : <Sparkles size={13} />}
          </button>
        )}
        <button
          type="button"
          className="attribute-value"
          disabled={busy}
          title={`${label} · 点击${record.can_edit ? '编辑' : '查看'}`}
          onClick={onEdit}
        >
          {busy ? '正在整理…' : label}
        </button>
        {generated && empty && (
          <button
            type="button"
            className="custom-ai-explanation"
            aria-label={`查看${field.name}的查询说明`}
            onClick={() => setShowEvidence(true)}
          >
            依据
          </button>
        )}
      </div>
      {error && (
        <p className="attribute-inline-error" role="alert">
          {error}
        </p>
      )}
      {showEvidence && generated && (
        <Dialog title={`${field.name} · AI 整理依据`} onClose={() => setShowEvidence(false)}>
          <div className="custom-form-body custom-ai-evidence">
            <p>{label}</p>
            <p>{provenance.explanation}</p>
            {provenance.sources_stale && (
              <p className="custom-help">
                原始依据已变化。已有值保留，可核对或手动清空后重新整理。
              </p>
            )}
            {!!provenance.missing.length && (
              <p className="custom-help">{provenance.missing.join('；')}</p>
            )}
            {provenance.sources.map((source) => (
              <details key={source.id}>
                <summary>{source.title}</summary>
                {provenance.evidence
                  .filter((e) => e.source_id === source.id)
                  .map((e, i) => (
                    <blockquote key={i}>{e.quote}</blockquote>
                  ))}
              </details>
            ))}
          </div>
          <footer>
            <button type="button" onClick={() => setShowEvidence(false)}>
              关闭
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
export interface CustomRecordSummary {
  objectId: string;
  total: number | null;
  loading: boolean;
  archived: boolean;
}

type CustomRecordLayout = 'list' | 'board';
function readRecordLayout(key: string): CustomRecordLayout {
  try {
    return localStorage.getItem(key) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

export function CustomObjectRecords({
  workspace,
  actorId,
  object,
  admin,
  onChanged,
  onManage,
  onSummary,
}: {
  workspace: string;
  actorId: string;
  object: CustomObject;
  admin: boolean;
  onChanged: () => void;
  onManage: () => void;
  onSummary?: (summary: CustomRecordSummary) => void;
}) {
  const columnsKey = `light-crm:custom-columns:${workspace}:${actorId}:${object.id}`;
  const layoutKey = `light-crm:custom-layout:${workspace}:${actorId}:${object.id}`;
  const [storedLayout, setStoredLayout] = useState(() => ({
    key: layoutKey,
    value: readRecordLayout(layoutKey),
  }));
  const layout = storedLayout.key === layoutKey ? storedLayout.value : readRecordLayout(layoutKey);
  const cardDisplay = useKanbanDisplay(
    `light-crm:custom-cards:${workspace}:${actorId}:${object.id}`,
    ['customer', 'project', 'created'],
  );
  function setLayout(value: CustomRecordLayout) {
    setStoredLayout({ key: layoutKey, value });
    try {
      localStorage.setItem(layoutKey, value);
    } catch {
      // Layout remains usable when browser storage is unavailable.
    }
    closeMenus();
  }
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(columnsKey) || '[]');
      return Array.isArray(saved)
        ? saved.filter((id): id is string => typeof id === 'string' && id !== 'name').slice(0, 48)
        : [];
    } catch {
      return [];
    }
  });
  const [columnQuery, setColumnQuery] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [current, setCurrent] = useState(object),
    [fields, setFields] = useState<CustomAttribute[]>([]),
    [result, setResult] = useState<{ items: CustomRecord[]; total: number } | null>(null),
    [q, setQ] = useState(''),
    [archived, setArchived] = useState(false),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<CustomRecord | 'new' | null>(null),
    [opening, setOpening] = useState(false);
  useEffect(() => {
    onSummary?.({
      objectId: object.id,
      total: error ? null : (result?.total ?? null),
      loading,
      archived,
    });
  }, [object.id, result?.total, error, loading, archived, onSummary]);
  useEffect(() => setChecked([]), [object.id, q, archived, page]);
  function setColumnVisible(id: string, visible: boolean) {
    if (id === 'name') return;
    const next = visible ? hiddenColumns.filter((key) => key !== id) : [...hiddenColumns, id];
    setHiddenColumns(next);
    try {
      localStorage.setItem(columnsKey, JSON.stringify(next));
    } catch {
      // Column visibility remains usable without browser storage.
    }
  }
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      Promise.all([
        api<CustomAttribute[]>(`/custom-objects/${object.id}/attributes`, {
          workspace,
          signal: c.signal,
        }),
        api<CustomObject[]>('/custom-objects', { workspace, signal: c.signal }),
        api<{ items: CustomRecord[]; total: number }>(
          `/custom-objects/${object.id}/records?${new URLSearchParams({ q, archived: String(archived), page: String(page) })}`,
          { workspace, signal: c.signal },
        ),
      ])
        .then(([f, objects, r]) => {
          if (!c.signal.aborted) {
            setFields(f);
            setCurrent(objects.find((o) => o.id === object.id) || object);
            setResult(r);
            setPage((currentPage) => Math.min(currentPage, Math.max(1, Math.ceil(r.total / 50))));
            setChecked((selected) =>
              selected.filter((id) => r.items.some((item) => item.id === id)),
            );
            setLoading(false);
          }
        })
        .catch((e) => {
          if (!c.signal.aborted) {
            setError(msg(e));
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [workspace, object.id, q, archived, page, revision]);
  async function open(r: CustomRecord) {
    if (opening) return;
    setOpening(true);
    setError('');
    try {
      const [fresh, objects, f] = await Promise.all([
        api<CustomRecord>(`/custom-objects/${object.id}/records/${r.id}`, { workspace }),
        api<CustomObject[]>('/custom-objects', { workspace }),
        api<CustomAttribute[]>(`/custom-objects/${object.id}/attributes`, { workspace }),
      ]);
      setCurrent(objects.find((o) => o.id === object.id) || object);
      setFields(f);
      setDialog(fresh);
    } catch (e) {
      setError(msg(e));
    } finally {
      setOpening(false);
    }
  }
  const active = fields.filter((f) => !f.archived);
  const aiFields = new Set(active.filter((field) => field.ai_enabled).map((field) => field.id));
  const allColumns = [
    { id: 'name', label: '名称', width: 240 },
    { id: 'customer', label: '所属公司', width: 190 },
    { id: 'project', label: '关联项目', width: 180 },
    ...active.map((f) => ({ id: f.id, label: f.name, width: 170 })),
    { id: 'created', label: '创建时间', width: 190 },
  ];
  const columns = allColumns.filter((column) => !hiddenColumns.includes(column.id));
  const cardOptions = [
    ...allColumns,
    { id: 'id', label: '记录编号' },
    { id: 'created_by', label: '创建人' },
  ];
  const cardColumns = cardOptions.filter(
    (column) => column.id !== 'name' && cardDisplay.fields.includes(column.id),
  );
  const rowColumns = [
    { id: '_select', label: '', width: 36, fixed: true },
    ...columns,
    { id: '_space', label: '', width: 80, fixed: true, fill: true },
  ];
  const viewName = archived ? '已归档记录' : '全部记录';
  const totalPages = Math.max(1, Math.ceil((result?.total || 0) / 50));
  function updateRecord(saved: CustomRecord) {
    setResult((previous) =>
      previous
        ? {
            ...previous,
            items: previous.items.map((item) => (item.id === saved.id ? saved : item)),
          }
        : previous,
    );
  }
  function recordValue(record: CustomRecord, id: string) {
    if (id === 'customer') return record.customer_name;
    if (id === 'project') return record.project_name || '—';
    if (id === 'created') return time(record.created_at);
    if (id === 'id') return record.id;
    if (id === 'created_by') return record.created_by_name;
    const field = active.find((attribute) => attribute.id === id);
    return field ? (
      <CustomAttributeCell
        workspace={workspace}
        object={current}
        field={field}
        record={record}
        onEdit={() => void open(record)}
        onSaved={updateRecord}
      />
    ) : (
      <span className="custom-muted">属性不可用</span>
    );
  }
  const emptyMessage = q
    ? '没有匹配的记录'
    : archived
      ? '暂无已归档记录'
      : '暂无记录，点击右上角“新建记录”开始添加。';
  return (
    <section className="custom-records" aria-label={`${current.name}记录`}>
      <div className="view-heading">
        <Popover
          label={viewName}
          icon={layout === 'board' ? <LayoutGrid size={15} /> : <LayoutList size={15} />}
          className="view-selector"
        >
          <p className="popover-caption">{current.name}视图</p>
          {[false, true].map((value) => (
            <button
              className="menu-item"
              key={String(value)}
              onClick={() => {
                setArchived(value);
                setPage(1);
                closeMenus();
              }}
            >
              {value ? '已归档记录' : '全部记录'}
            </button>
          ))}
        </Popover>
        <Popover label="视图设置" icon={<Settings2 size={14} />} className="columns-popover">
          <div className="settings-layout">
            <span>显示方式</span>
            <button
              className={layout === 'list' ? 'current' : ''}
              aria-pressed={layout === 'list'}
              onClick={() => setLayout('list')}
            >
              <Table2 size={13} /> 表格
            </button>
            <button
              className={layout === 'board' ? 'current' : ''}
              aria-pressed={layout === 'board'}
              onClick={() => setLayout('board')}
            >
              <LayoutGrid size={13} /> 卡片
            </button>
          </div>
          {admin && (
            <button
              className="menu-item"
              onClick={() => {
                closeMenus();
                onManage();
              }}
            >
              管理属性
            </button>
          )}
          <button
            className="menu-item"
            onClick={() => {
              setRevision((n) => n + 1);
              closeMenus();
            }}
          >
            <RotateCcw size={14} /> 刷新记录
          </button>
        </Popover>
        <div className="view-heading-actions">
          <button
            className="primary"
            disabled={loading || !!error}
            onClick={() => setDialog('new')}
          >
            <Plus size={14} /> 新建记录
          </button>
        </div>
      </div>
      <div className="view-toolbar">
        <div className="toolbar-options">
          <span className="sort-label">
            <ArrowDownUp size={14} /> 最近更新
          </span>
          <Popover label={`筛选${archived ? ' 1' : ''}`} icon={<SlidersHorizontal size={14} />}>
            <label className="check-label">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => {
                  setArchived(event.target.checked);
                  setPage(1);
                }}
              />
              只看已归档记录
            </label>
            <button
              className="text-button"
              onClick={() => {
                setArchived(false);
                setQ('');
                setPage(1);
                closeMenus();
              }}
            >
              清除筛选
            </button>
          </Popover>
          {layout === 'board' && (
            <Popover
              label="卡片字段"
              icon={<Columns3 size={14} />}
              className="custom-card-fields-popover"
            >
              <p className="popover-caption">名称固定 · 仅保存本人在此表的本机显示偏好</p>
              {cardOptions.map((column) => (
                <label className="column-visibility-option" key={column.id}>
                  <input
                    type="checkbox"
                    checked={column.id === 'name' || cardDisplay.fields.includes(column.id)}
                    disabled={column.id === 'name'}
                    onChange={(event) =>
                      cardDisplay.setFields(
                        event.target.checked
                          ? [...cardDisplay.fields, column.id]
                          : cardDisplay.fields.filter((id) => id !== column.id),
                      )
                    }
                  />
                  <span title={aiFields.has(column.id) ? 'AI 整理已启用' : undefined}>
                    {aiFields.has(column.id) && (
                      <Sparkles size={12} className="custom-ai-heading" aria-hidden="true" />
                    )}
                    {column.label}
                  </span>
                  {column.id === 'name' && <small>固定</small>}
                </label>
              ))}
            </Popover>
          )}
          {layout === 'list' && (
            <Popover
              label="表格字段"
              icon={<Table2 size={14} />}
              className="columns-popover column-visibility-popover custom-card-fields-popover"
            >
              <p className="popover-caption">勾选显示，取消勾选隐藏</p>
              <input
                aria-label="搜索显示列"
                placeholder="搜索属性…"
                value={columnQuery}
                onChange={(event) => setColumnQuery(event.target.value)}
              />
              {allColumns
                .filter((column) =>
                  column.label.toLowerCase().includes(columnQuery.trim().toLowerCase()),
                )
                .map((column) => (
                  <label className="column-visibility-option" key={column.id}>
                    <input
                      type="checkbox"
                      checked={!hiddenColumns.includes(column.id)}
                      disabled={column.id === 'name'}
                      onChange={(event) => setColumnVisible(column.id, event.target.checked)}
                    />
                    <span title={aiFields.has(column.id) ? 'AI 整理已启用' : undefined}>
                      {aiFields.has(column.id) && (
                        <Sparkles size={12} className="custom-ai-heading" aria-hidden="true" />
                      )}
                      {column.label}
                    </span>
                    {column.id === 'name' && <small>固定</small>}
                  </label>
                ))}
            </Popover>
          )}
          {layout === 'board' && (
            <label className="custom-card-select-all">
              <input
                type="checkbox"
                aria-label="选择本页全部记录"
                disabled={loading || !!error || !result?.items.length}
                checked={
                  !!result?.items.length &&
                  result.items.every((record) => checked.includes(record.id))
                }
                onChange={(event) =>
                  setChecked(
                    event.target.checked ? result?.items.map((record) => record.id) || [] : [],
                  )
                }
              />
              本页全选
            </label>
          )}
          {!!checked.length && (
            <button className="text-button" onClick={() => setChecked([])}>
              已选 {checked.length} 条 · 清除
            </button>
          )}
        </div>
        <label className="search">
          <Search size={14} />
          <input
            aria-label={`搜索${current.name}`}
            placeholder="搜索名称或公司…"
            maxLength={120}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          {q && (
            <button
              aria-label="清除搜索"
              onClick={() => {
                setQ('');
                setPage(1);
              }}
            >
              <X size={12} />
            </button>
          )}
        </label>
      </div>
      {error && (
        <p role="alert" className="error custom-record-error">
          {error}
          <button onClick={() => setRevision((n) => n + 1)}>重新加载</button>
        </p>
      )}
      <div className="workspace-body custom-record-table">
        {loading ? (
          <p className="custom-record-state" role="status">
            正在加载记录…
          </p>
        ) : (
          !error &&
          (layout === 'board' ? (
            <KanbanBoard className="custom-record-cards" aria-label={`${current.name}卡片`}>
              {result?.items.map((record) => (
                <KanbanCard
                  key={record.id}
                  className={checked.includes(record.id) ? 'is-selected' : ''}
                >
                  <div className="custom-card-heading">
                    <input
                      type="checkbox"
                      aria-label={`选择${record.name}`}
                      checked={checked.includes(record.id)}
                      onChange={(event) =>
                        setChecked((previous) =>
                          event.target.checked
                            ? [...previous, record.id]
                            : previous.filter((id) => id !== record.id),
                        )
                      }
                    />
                    <button
                      className="kanban-card-title"
                      disabled={opening}
                      onClick={() => void open(record)}
                      title={`打开${record.name}`}
                    >
                      <span className="kanban-card-identity">
                        <CustomObjectIcon object={current} size={15} />
                      </span>
                      <span className="kanban-card-name">{record.name}</span>
                      <PanelRight className="kanban-card-preview" size={13} />
                    </button>
                  </div>
                  {!!cardColumns.length && (
                    <div className="kanban-card-fields">
                      {cardColumns.map((column) => {
                        const field = active.find((field) => field.id === column.id);
                        const value = field
                          ? record.values[field.id]
                          : column.id === 'customer'
                            ? record.customer_name
                            : column.id === 'project'
                              ? record.project_name
                              : column.id === 'created'
                                ? record.created_at
                                : column.id === 'id'
                                  ? record.id
                                  : column.id === 'created_by'
                                    ? record.created_by_name
                                    : undefined;
                        return (
                          <RecordCardField
                            key={column.id}
                            fieldId={column.id}
                            label={column.label}
                            kind={field?.kind}
                            value={value}
                          >
                            {recordValue(record, column.id)}
                          </RecordCardField>
                        );
                      })}
                    </div>
                  )}
                  <div className="kanban-card-footer">
                    <span>
                      {record.archived_at ? '已归档' : record.can_edit ? '可编辑' : '只读'}
                    </span>
                    <button
                      className="text-button"
                      disabled={opening}
                      onClick={() => void open(record)}
                    >
                      {record.can_edit ? (
                        record.archived_at ? (
                          <RotateCcw size={12} />
                        ) : (
                          <Pencil size={12} />
                        )
                      ) : (
                        <PanelRight size={12} />
                      )}
                      {record.can_edit
                        ? record.archived_at
                          ? '恢复记录'
                          : '编辑记录'
                        : '查看记录'}
                    </button>
                  </div>
                </KanbanCard>
              ))}
              {!result?.items.length && <div className="kanban-empty">{emptyMessage}</div>}
            </KanbanBoard>
          ) : (
            <ResizableTable
              columns={rowColumns}
              storageKey={`${workspace}:${actorId}:custom:${object.id}`}
              className="record-table custom-data-table"
            >
              <thead>
                <tr>
                  <th className="check-cell">
                    <input
                      type="checkbox"
                      aria-label="选择本页全部记录"
                      disabled={!result?.items.length}
                      checked={
                        !!result?.items.length &&
                        result.items.every((record) => checked.includes(record.id))
                      }
                      onChange={(event) =>
                        setChecked(
                          event.target.checked
                            ? result?.items.map((record) => record.id) || []
                            : [],
                        )
                      }
                    />
                  </th>
                  {columns.map((c) => (
                    <th key={c.id}>
                      <div className="attribute-column-heading">
                        {active.find((f) => f.id === c.id)?.ai_enabled && (
                          <Sparkles size={12} className="custom-ai-heading" />
                        )}
                        <Popover label={c.label}>
                          {c.id !== 'name' && (
                            <button
                              className="menu-item"
                              onClick={() => {
                                setColumnVisible(c.id, false);
                                closeMenus();
                              }}
                            >
                              隐藏此列
                            </button>
                          )}
                          {admin && (
                            <button
                              className="menu-item"
                              onClick={() => {
                                closeMenus();
                                onManage();
                              }}
                            >
                              管理属性
                            </button>
                          )}
                          {c.id === 'name' && !admin && (
                            <p className="popover-caption">名称列固定显示</p>
                          )}
                        </Popover>
                      </div>
                      <ColumnResizeHandle columnId={c.id} />
                    </th>
                  ))}
                  <th className="table-spacer" />
                </tr>
              </thead>
              <tbody>
                {result && !result.total && (
                  <tr>
                    <td colSpan={rowColumns.length} className="custom-record-empty-cell">
                      <div className="custom-record-empty">
                        <span>{emptyMessage}</span>
                      </div>
                    </td>
                  </tr>
                )}
                {result?.items.map((r) => (
                  <tr
                    key={r.id}
                    className={checked.includes(r.id) ? 'selected' : ''}
                    onClick={(event) => {
                      if (
                        !(event.target as HTMLElement).closest(
                          'button,input,select,textarea,a,.popover',
                        )
                      )
                        void open(r);
                    }}
                  >
                    <td className="check-cell">
                      <input
                        type="checkbox"
                        aria-label={`选择${r.name}`}
                        checked={checked.includes(r.id)}
                        onChange={(event) =>
                          setChecked((previous) =>
                            event.target.checked
                              ? [...previous, r.id]
                              : previous.filter((id) => id !== r.id),
                          )
                        }
                      />
                    </td>
                    {columns.map((column) =>
                      column.id === 'name' ? (
                        <td key={column.id}>
                          <button
                            className="custom-record-link"
                            disabled={opening}
                            onClick={() => void open(r)}
                          >
                            <span>{r.name}</span>
                          </button>
                        </td>
                      ) : column.id === 'customer' ? (
                        <ExpandableCell key={column.id} label="所属公司">
                          {r.customer_name}
                        </ExpandableCell>
                      ) : column.id === 'project' ? (
                        <ExpandableCell key={column.id} label="关联项目">
                          {r.project_name || '—'}
                        </ExpandableCell>
                      ) : column.id === 'created' ? (
                        <td key={column.id}>{time(r.created_at)}</td>
                      ) : (
                        active
                          .filter((field) => field.id === column.id)
                          .map((f) => (
                            <ExpandableCell key={f.id} label={f.name}>
                              <CustomAttributeCell
                                workspace={workspace}
                                object={current}
                                field={f}
                                record={r}
                                onEdit={() => void open(r)}
                                onSaved={updateRecord}
                              />
                            </ExpandableCell>
                          ))
                      ),
                    )}
                    <td className="table-spacer" />
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          ))
        )}
      </div>
      <footer className="table-footer">
        <span>
          {loading
            ? '加载中…'
            : `共 ${result?.total ?? '—'} 项 · 当前页 ${result?.items.length ?? 0} 项`}
        </span>
        <div>
          <span>
            {page} / {totalPages}
          </span>
          <button
            className="icon-button"
            aria-label="上一页"
            disabled={loading || !!error || page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="下一页"
            disabled={loading || !!error || page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </footer>
      {dialog && (
        <RecordDialog
          workspace={workspace}
          object={current}
          fields={fields}
          record={dialog === 'new' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setRevision((n) => n + 1);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
