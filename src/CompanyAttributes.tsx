import { useEffect, useRef, useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { api } from './api';
import { Dialog } from './WorkspaceUI';
import {
  attributeKinds,
  formatAttributeValue,
  type CompanyAttribute,
  type CompanyAttributeValue,
  type AttributeKind,
  type AttributeModelStatus,
  type AttributeRun,
  type AttributeValue,
  type AttributeSource,
} from '../shared/attributes';
import {
  customerTypes,
  customerStatuses,
  projectStages,
  projectTypes,
  recordKinds,
} from '../shared/domain';
import './attributes.css';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
export function useCompanyAttributes(workspace: string, refresh: number) {
  const [data, setData] = useState<{
    workspace: string;
    fields: CompanyAttribute[];
    status: AttributeModelStatus;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    setError('');
    Promise.all([
      api<CompanyAttribute[]>('/attributes', { workspace, signal: c.signal }),
      api<AttributeModelStatus>('/attributes/model', { workspace, signal: c.signal }),
    ])
      .then(([fields, status]) => setData({ workspace, fields, status }))
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setData(null);
          setError(errorMessage(e));
        }
      });
    return () => c.abort();
  }, [workspace, refresh]);
  return {
    fields: data?.workspace === workspace ? data.fields.filter((f) => !f.archived) : [],
    status: data?.workspace === workspace ? data.status : null,
    error,
  };
}
export function useCompanyAttributeValues(
  workspace: string,
  customerIds: string[],
  refresh: number,
) {
  const key = customerIds.slice().sort().join(',');
  const [data, setData] = useState<{
    workspace: string;
    key: string;
    refresh: number;
    values: CompanyAttributeValue[];
  } | null>(null);
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => {
    const c = new AbortController(),
      requestRevision = ++revision.current;
    setError('');
    if (key)
      api<CompanyAttributeValue[]>('/attributes/customer-values', {
        workspace,
        signal: c.signal,
        method: 'POST',
        body: { customer_ids: key.split(',') },
      })
        .then((values) => {
          if (c.signal.aborted) return;
          setData((prev) => {
            // A request started before an inline write must not restore its old value.
            const recent = prev?.workspace === workspace && prev.key === key ? prev.values : [];
            for (const value of recent) {
              const index = values.findIndex(
                (v) => v.customer_id === value.customer_id && v.attribute_id === value.attribute_id,
              );
              if (index < 0 && revision.current !== requestRevision) values.push(value);
              else if (index >= 0 && values[index].version < value.version) values[index] = value;
            }
            return { workspace, key, refresh, values };
          });
        })
        .catch((e) => {
          if (!c.signal.aborted) {
            setData(null);
            setError(errorMessage(e));
          }
        });
    return () => c.abort();
  }, [workspace, key, refresh]);
  const scoped = data?.workspace === workspace && data.key === key;
  return {
    values: scoped ? data.values : [],
    ready: !key || (scoped && data.refresh === refresh && !error),
    error,
    update: (value: CompanyAttributeValue) => {
      ++revision.current;
      if (!key.split(',').includes(value.customer_id)) return;
      setData((prev) => {
        if (prev?.workspace !== workspace || prev.key !== key) return prev;
        const current = prev.values.find(
          (v) => v.customer_id === value.customer_id && v.attribute_id === value.attribute_id,
        );
        if (current && current.version > value.version) return prev;
        return { ...prev, values: [...prev.values.filter((v) => v !== current), value] };
      });
    },
  };
}
export function AttributeFieldDialog({
  workspace,
  field,
  onClose,
  onSaved,
  onCreateRelationship,
}: {
  workspace: string;
  field?: CompanyAttribute;
  onClose: () => void;
  onSaved: (field: CompanyAttribute) => void;
  onCreateRelationship?: () => void;
}) {
  const [name, setName] = useState(field?.name || ''),
    [kind, setKind] = useState<AttributeKind>(field?.kind || 'text');
  const [description] = useState(field?.description || ''),
    [options, setOptions] = useState(field?.options.join('\n') || '');
  const [ai, setAi] = useState(field?.ai_enabled || false),
    [guidance, setGuidance] = useState(field?.guidance || '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog
      title={field ? '编辑公司属性' : '创建新的属性'}
      className="attribute-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        autoComplete="off"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const saved = await api<CompanyAttribute>(`/attributes${field ? `/${field.id}` : ''}`, {
              workspace,
              method: field ? 'PATCH' : 'POST',
              body: {
                name,
                kind,
                description,
                options: ['select', 'multi_select'].includes(kind)
                  ? options
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : [],
                ai_enabled: ai,
                guidance,
                archived: false,
                ...(field ? { version: field.version } : {}),
              },
            });
            onSaved(saved);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="attribute-fields">
          <p className="attribute-scope">公司属性 · 在公司表格和档案中复用</p>
          <label>
            属性类型
            <select
              value={kind}
              disabled={!!field}
              onChange={(e) => {
                if (e.target.value === 'relationship') onCreateRelationship?.();
                else setKind(e.target.value as AttributeKind);
              }}
            >
              {Object.entries(attributeKinds).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
              {onCreateRelationship && <option value="relationship">关系 · 双向关联记录</option>}
            </select>
          </label>
          <label>
            名称
            <input
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：合作需求摘要"
            />
          </label>
          {['select', 'multi_select'].includes(kind) && (
            <label>
              选项（每行一个）
              <textarea
                required
                maxLength={2400}
                rows={4}
                value={options}
                onChange={(e) => setOptions(e.target.value)}
                placeholder={'团体定制\n经销合作\n待确认'}
              />
            </label>
          )}
          <div className="attribute-ai-config">
            <label className="attribute-toggle">
              <Sparkles size={15} />
              <strong>AI 填充</strong>
              <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
            </label>
            {ai && (
              <>
                <label>
                  Guidance · 填充指令
                  <textarea
                    required
                    maxLength={4000}
                    rows={4}
                    value={guidance}
                    onChange={(e) => setGuidance(e.target.value)}
                    placeholder="基于这家公司的业务记录、联系人和项目关系，概括当前需求与待确认事项。只写有依据的内容。"
                  />
                </label>
                <p>
                  根据当前公司的档案、业务记录、联系人、项目及显式关系分析，在表格中直接填充，支持编辑修改。
                </p>
                <span className="attribute-model-name">MiniMax M3.1 Flash</span>
              </>
            )}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </fieldset>
        <footer className="form-footer">
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
function ValueInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: CompanyAttribute;
  value: AttributeValue;
  onChange: (v: AttributeValue) => void;
  disabled: boolean;
}) {
  if (field.kind === 'multi_select')
    return (
      <div className="attribute-options">
        {field.options.map((o) => (
          <label key={o}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={Array.isArray(value) && value.includes(o)}
              onChange={(e) => {
                const values = Array.isArray(value) ? value : [];
                onChange(e.target.checked ? [...values, o] : values.filter((v) => v !== o));
              }}
            />
            {o}
          </label>
        ))}
      </div>
    );
  if (field.kind === 'select')
    return (
      <select
        aria-label="属性值"
        disabled={disabled}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">未填写</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  if (field.kind === 'number')
    return (
      <input
        aria-label="属性值"
        disabled={disabled}
        type="number"
        step="any"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  return (
    <textarea
      aria-label="属性值"
      disabled={disabled}
      rows={4}
      maxLength={5000}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value || null)}
      placeholder="输入属性值…"
    />
  );
}
export function evidenceText(source: AttributeSource) {
  const quoted = source.quote ? `支持该值的原文摘录：\n${source.quote}\n\n` : '';
  const labels: Record<string, string> = {
    name: '名称',
    type: '类型',
    status: '状态',
    region: '地区',
    contact_name: '主要联系人',
    email: '邮箱',
    phone: '电话',
    kind: '记录性质',
    body: '原文',
    description: '说明',
    job_title: '职位',
    stage: '项目阶段',
    due_date: '目标日期',
    created_at: '记录时间',
    source_name: '起点',
    target_name: '终点',
    source_label: '关系',
    target_label: '反向关系',
    value: '已有属性值',
    origin: '值来源',
    archived_at: '归档时间',
  };
  try {
    const row = JSON.parse(source.body) as Record<string, unknown>;
    if (Array.isArray(row.originals))
      return (
        quoted +
        row.originals
          .map((item) => {
            const original = item as Record<string, unknown>;
            const channel =
              original.channel === 'email'
                ? '邮件'
                : original.channel === 'wechat'
                  ? '微信'
                  : '业务记录';
            const at = original.occurred_at
              ? new Date(String(original.occurred_at)).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  hour12: false,
                })
              : '';
            const trust = recordKinds[original.trust as keyof typeof recordKinds] || '性质待核对';
            return `${channel} · ${String(original.speaker || '说话人待核对')}\n${at} · ${trust}\n${String(original.body || '')}`;
          })
          .join('\n\n')
      );
    return (
      quoted +
      (Object.entries(row)
        .filter(([k, v]) => labels[k] && v !== null && v !== '')
        .map(([k, v]) => {
          const dictionaries: Record<string, Record<string, string>> = {
            kind: recordKinds,
            type: { ...customerTypes, ...projectTypes },
            status: customerStatuses,
            stage: projectStages,
            origin: { manual: '人工填写', ai: 'AI 分析' },
          };
          const formatted = k.endsWith('_at')
            ? new Date(String(v)).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false,
              })
            : dictionaries[k]?.[String(v)] || String(v);
          return `${labels[k]}：${formatted}`;
        })
        .join('\n') || JSON.stringify(row, null, 2))
    );
  } catch {
    return quoted + source.body;
  }
}
export function AttributeValueDialog({
  workspace,
  customer,
  field,
  current,
  status,
  onClose,
  onSaved,
}: {
  workspace: string;
  customer: { id: string; name: string };
  field: CompanyAttribute;
  current?: CompanyAttributeValue;
  status: AttributeModelStatus | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<AttributeValue>(current?.value ?? null),
    [guidance, setGuidance] = useState(field.guidance);
  const [run, setRun] = useState<AttributeRun | null>(null),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  async function save(ai: boolean) {
    setBusy('saving');
    setError('');
    try {
      if (ai && run)
        await api(`/customers/${customer.id}/attribute-runs/${run.id}/apply`, {
          workspace,
          method: 'POST',
          body: {},
        });
      else
        await api(`/customers/${customer.id}/attribute-values/${field.id}`, {
          workspace,
          method: 'PATCH',
          body: { value, version: current?.version || 0, attribute_version: field.version },
        });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <Dialog
      title={field.name}
      className="attribute-dialog attribute-value-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="attribute-fields">
        <p className="attribute-scope">
          当前公司：<strong>{customer.name}</strong>
        </p>
        {field.description && <p>{field.description}</p>}
        <label>
          当前属性值
          <ValueInput
            field={field}
            value={value}
            onChange={(v) => {
              setValue(v);
              setRun(null);
              setChecked(false);
            }}
            disabled={!!busy}
          />
        </label>
        {current && (
          <p className="attribute-meta">
            {current.origin === 'ai' ? 'AI 生成' : '人工填写'} ·{' '}
            {new Date(current.updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
          </p>
        )}
        {current?.sources.length && !run ? (
          <details className="attribute-evidence">
            <summary>查看已保存依据（{current.sources.length}）</summary>
            {current.sources.map((s) => (
              <details key={s.id}>
                <summary>{s.title}</summary>
                <pre>{evidenceText(s)}</pre>
              </details>
            ))}
          </details>
        ) : null}
        {field.ai_enabled && (
          <section className="attribute-ai-config" aria-label="AI 填充">
            <div className="attribute-ai-heading">
              <Sparkles size={16} />
              <strong>AI 填充</strong>
              <span>MiniMax M3.1 Flash</span>
            </div>
            <label>
              Guidance · 本次填充指令
              <textarea
                rows={4}
                maxLength={4000}
                disabled={!!busy}
                value={guidance}
                onChange={(e) => {
                  setGuidance(e.target.value);
                  setRun(null);
                  setChecked(false);
                }}
              />
            </label>
            <p>
              按此属性的问题检索当前公司的邮件、微信原文及图谱，再结合档案生成。保留来源摘录；无依据显示无相关信息。
            </p>
            {!status?.configured && <div className="notice">AI 服务暂未就绪，请稍后重试。</div>}
            <button
              type="button"
              disabled={!!busy || !guidance.trim() || !status?.configured}
              onClick={async () => {
                setBusy('generating');
                setError('');
                setRun(null);
                setChecked(false);
                try {
                  setRun(
                    await api<AttributeRun>(`/customers/${customer.id}/attribute-runs`, {
                      workspace,
                      method: 'POST',
                      body: { attribute_id: field.id, attribute_version: field.version, guidance },
                    }),
                  );
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy('');
                }
              }}
            >
              <Sparkles size={14} />
              {busy === 'generating' ? '正在分析公司资料…' : run ? '重新生成候选值' : '生成候选值'}
            </button>
          </section>
        )}
        {run && (
          <section className="attribute-preview" aria-label="AI 候选结果">
            <h3>候选值 · 待核对</h3>
            <div className="attribute-diff">
              <div>
                <small>已保存的值</small>
                <p>{formatAttributeValue(current?.value, current?.origin)}</p>
              </div>
              <div>
                <small>AI 候选值</small>
                <p>{run.value === null ? '无相关信息' : formatAttributeValue(run.value)}</p>
              </div>
            </div>
            <p>{run.explanation}</p>
            {!!run.missing.length && <div className="notice">待确认：{run.missing.join('；')}</div>}
            {run.warnings.map((w) => (
              <p className="notice" key={w}>
                {w}
              </p>
            ))}
            <details className="attribute-evidence">
              <summary>查看依据（{run.sources.length}）</summary>
              {run.sources.map((s) => (
                <details key={s.id}>
                  <summary>{s.title}</summary>
                  <pre>{evidenceText(s)}</pre>
                </details>
              ))}
            </details>
            <label className="attribute-review">
              <input
                type="checkbox"
                disabled={!!busy}
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              我已核对候选值与依据，保存将替换当前值
            </label>
          </section>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="form-footer">
        <button type="button" disabled={!!busy} onClick={onClose}>
          取消
        </button>
        <button type="button" disabled={!!busy} onClick={() => void save(false)}>
          保存人工值
        </button>
        {run && (
          <button
            className="primary"
            type="button"
            disabled={!!busy || (current?.value != null && !checked)}
            onClick={() => void save(true)}
          >
            {run.value === null ? '保存查询结果' : '保存 AI 值'}
          </button>
        )}
      </footer>
    </Dialog>
  );
}

export function CompanyAttributes({
  workspace,
  customer,
  refresh,
  onSaved,
}: {
  workspace: string;
  customer: { id: string; name: string; can_edit: boolean; archived_at: string | null };
  refresh: number;
  onSaved: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const { fields, status, error } = useCompanyAttributes(workspace, refresh + revision);
  const { values, ready } = useCompanyAttributeValues(workspace, [customer.id], refresh + revision);
  const [editing, setEditing] = useState<CompanyAttribute | null>(null),
    [creating, setCreating] = useState(false);
  const editable = customer.can_edit && !customer.archived_at;
  return (
    <section className="company-attributes" aria-label="公司自定义属性">
      <div className="attribute-section-heading">
        <strong>自定义属性</strong>
        {status?.can_manage && (
          <>
            <button
              className="icon-button"
              aria-label="创建新的属性"
              onClick={() => setCreating(true)}
            >
              <Plus size={13} />
            </button>
          </>
        )}
      </div>
      {fields.map((f) => {
        const v = values.find((v) => v.attribute_id === f.id);
        return (
          <div className="company-attribute-row" key={f.id}>
            <span>
              {f.ai_enabled && <Sparkles size={12} />} {f.name}
            </span>
            <button
              className="attribute-value"
              disabled={!editable || !ready}
              title={formatAttributeValue(v?.value, v?.origin)}
              onClick={() => setEditing(f)}
            >
              {formatAttributeValue(v?.value, v?.origin)}
            </button>
          </div>
        );
      })}
      {!fields.length && !error && (
        <p className="attribute-meta">添加公司属性，按指令分析现有记录与关系。</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {creating && (
        <AttributeFieldDialog
          workspace={workspace}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setRevision((n) => n + 1);
            onSaved();
          }}
        />
      )}
      {editing && (
        <AttributeValueDialog
          key={`${customer.id}:${editing.id}`}
          workspace={workspace}
          customer={customer}
          field={editing}
          current={values.find((v) => v.attribute_id === editing.id)}
          status={status}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setRevision((n) => n + 1);
            onSaved();
          }}
        />
      )}
    </section>
  );
}
