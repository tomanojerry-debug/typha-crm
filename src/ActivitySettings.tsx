import { useEffect, useState } from 'react';
import { ArrowLeft, Layers2, Plus, Sparkles } from 'lucide-react';
import { api } from './api';
import { Dialog } from './WorkspaceUI';
import {
  activityBaseField,
  ordinaryActivityFieldKinds,
  type ActivityField,
  type ActivityFieldKind,
  type ActivitySchema,
  type BusinessActivityType,
} from '../shared/business-activities';
import './business-activities.css';

export const activityKindLabels: Record<ActivityFieldKind, string> = {
  text: '文本',
  number: '数字',
  currency: '金额',
  date: '日期',
  timestamp: '日期与时间',
  checkbox: '复选框',
  rating: '评分',
  select: '单选',
  multi_select: '多选',
  record_reference: '记录引用',
  actor_reference: '用户',
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
const fieldInput = (field: ActivityField) => ({
  id: field.id,
  name: field.name,
  kind: field.kind,
  options: field.options,
  required: field.required,
  ai_enabled: field.ai_enabled,
  guidance: field.guidance,
  ...(field.currency ? { currency: field.currency } : {}),
});
type Owner =
  { kind: 'schema'; value: ActivitySchema } | { kind: 'type'; value: BusinessActivityType };

export function ActivitySettings({ workspace, admin }: { workspace: string; admin: boolean }) {
  const [schemas, setSchemas] = useState<ActivitySchema[]>([]);
  const [types, setTypes] = useState<BusinessActivityType[]>([]);
  const [tab, setTab] = useState<'schemas' | 'types'>('schemas');
  const [selected, setSelected] = useState<{ kind: Owner['kind']; id: string } | null>(null);
  const [detailTab, setDetailTab] = useState<'attributes' | 'configuration'>('attributes');
  const [creating, setCreating] = useState<'schema' | 'type' | null>(null);
  const [field, setField] = useState<ActivityField | 'new' | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      api<ActivitySchema[]>('/activity-schemas', { workspace, signal: controller.signal }),
      api<BusinessActivityType[]>('/activity-types', { workspace, signal: controller.signal }),
    ])
      .then(([nextSchemas, nextTypes]) => {
        setSchemas(nextSchemas);
        setTypes(nextTypes);
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorText(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [workspace, revision]);
  const currentSchema =
    selected?.kind === 'schema' ? schemas.find((s) => s.id === selected.id) : null;
  const currentType = selected?.kind === 'type' ? types.find((t) => t.id === selected.id) : null;
  const owner: Owner | null = currentSchema
    ? { kind: 'schema', value: currentSchema }
    : currentType
      ? { kind: 'type', value: currentType }
      : null;
  function changed(message: string, next?: { kind: Owner['kind']; id: string }) {
    setNotice(message);
    setCreating(null);
    setField(null);
    setRevision((n) => n + 1);
    if (next) setSelected(next);
  }
  const ordered = schemas
    .filter((s) => !s.parent_id)
    .flatMap((root) => [root, ...schemas.filter((s) => s.parent_id === root.id)]);
  return (
    <section className="ba-settings" aria-label="活动与 Schema 设置">
      <div className="ba-settings-heading">
        <Layers2 size={21} />
        <div>
          <p className="ba-eyebrow">工作空间设置</p>
          <h3>活动与 Schema</h3>
        </div>
      </div>
      {notice && (
        <p className="ba-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="ba-alert" role="alert">
          {error}
          <button onClick={() => setRevision((n) => n + 1)}>重新读取</button>
        </div>
      )}
      {loading ? (
        <p className="ba-empty" role="status">
          正在读取活动配置…
        </p>
      ) : owner ? (
        <>
          <button
            className="text-button ba-back"
            onClick={() => {
              setSelected(null);
              setNotice('');
            }}
          >
            <ArrowLeft size={14} />
            {owner.kind === 'schema' ? 'Schemas' : '活动类型'}
          </button>
          <h3 className="ba-detail-name">{owner.value.name}</h3>
          <p className="ba-muted">
            {owner.kind === 'schema'
              ? currentSchema?.parent_id
                ? `来自 ${schemas.find((s) => s.id === currentSchema.parent_id)?.name || '父结构'} · 第 2 层`
                : '根结构 · 第 1 层'
              : `采用 ${currentType?.schema_name}`}
          </p>
          <div className="ba-tabs" role="tablist" aria-label="活动配置详情">
            <button
              role="tab"
              aria-selected={detailTab === 'configuration'}
              onClick={() => setDetailTab('configuration')}
            >
              配置
            </button>
            <button
              role="tab"
              aria-selected={detailTab === 'attributes'}
              onClick={() => setDetailTab('attributes')}
            >
              属性
            </button>
          </div>
          {detailTab === 'configuration' ? (
            <ActivityConfiguration
              key={`${owner.kind}:${owner.value.id}:${owner.value.version}`}
              owner={owner}
              workspace={workspace}
              admin={admin}
              onSaved={() => changed('配置已保存')}
            />
          ) : (
            <>
              <div className="ba-toolbar">
                <div>
                  <strong>属性</strong>
                  <small>{owner.value.effective_fields.length} 项</small>
                </div>
                {admin && (
                  <button className="primary" onClick={() => setField('new')}>
                    <Plus size={14} />
                    创建属性
                  </button>
                )}
              </div>
              <div className="ba-attribute-table">
                <table>
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>数据类型</th>
                      <th>约束</th>
                      <th>标记</th>
                    </tr>
                  </thead>
                  <tbody>
                    {owner.value.effective_fields.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <button
                            className="ba-field-name"
                            disabled={!admin || f.system || f.read_only || f.inherited}
                            onClick={() => setField(f)}
                          >
                            {f.name}
                          </button>
                          {f.system ? (
                            <span className="ba-inline-source">来自 系统</span>
                          ) : (
                            f.inherited && (
                              <button
                                className="ba-inline-source"
                                onClick={() => {
                                  if (f.source_schema_id) {
                                    setSelected({ kind: 'schema', id: f.source_schema_id });
                                    setDetailTab('attributes');
                                  }
                                }}
                              >
                                来自 {f.source_schema_name || 'Schema'}
                              </button>
                            )
                          )}
                        </td>
                        <td>{activityKindLabels[f.kind]}</td>
                        <td>{f.required ? '必填' : ''}</td>
                        <td>
                          <span className="ba-tags">
                            {f.system && <span className="ba-tag">系统</span>}
                            {f.inherited && <span className="ba-tag inherited">继承</span>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="ba-tabs" role="tablist" aria-label="活动设置分类">
            <button role="tab" aria-selected={tab === 'schemas'} onClick={() => setTab('schemas')}>
              Schemas
            </button>
            <button role="tab" aria-selected={tab === 'types'} onClick={() => setTab('types')}>
              活动类型
            </button>
          </div>
          <div className="ba-toolbar">
            <div>
              <strong>{tab === 'schemas' ? 'Schemas' : '活动类型'}</strong>
              <small>
                {tab === 'schemas' ? '当前支持一层或两层' : '选择已有结构并设置整理规则'}
              </small>
            </div>
            {admin && (
              <button
                className="primary"
                onClick={() => setCreating(tab === 'schemas' ? 'schema' : 'type')}
              >
                <Plus size={14} />
                {tab === 'schemas' ? '新建 Schema' : '新建活动类型'}
              </button>
            )}
          </div>
          {tab === 'schemas' ? (
            ordered.length ? (
              <div className="ba-attribute-table">
                <table>
                  <thead>
                    <tr>
                      <th>Schema</th>
                      <th>全部属性</th>
                      <th>标记</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <button
                            className={`ba-schema-name ${s.parent_id ? 'child' : ''}`}
                            onClick={() => {
                              setSelected({ kind: 'schema', id: s.id });
                              setDetailTab('attributes');
                            }}
                          >
                            <Layers2 size={15} />
                            {s.name}
                          </button>
                        </td>
                        <td>{s.effective_fields.length}</td>
                        <td>
                          <span className="ba-tag">用户自定义</span>
                          {s.archived && <span className="ba-tag">已停用</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="ba-empty">
                还没有 Schema。新建根结构后，仅生成通用默认属性；业务字段由你自行增加。
              </p>
            )
          ) : types.length ? (
            <div className="ba-attribute-table">
              <table>
                <thead>
                  <tr>
                    <th>活动类型</th>
                    <th>采用 Schema</th>
                    <th>全部属性</th>
                  </tr>
                </thead>
                <tbody>
                  {types.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => {
                            setSelected({ kind: 'type', id: t.id });
                            setDetailTab('attributes');
                          }}
                        >
                          {t.name}
                        </button>
                        {t.archived && <span className="ba-tag">已停用</span>}
                      </td>
                      <td>{t.schema_name}</td>
                      <td>{t.effective_fields.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="ba-empty">还没有活动类型。先创建 Schema，再选择结构建立常用活动类型。</p>
          )}
          {!admin && (
            <p className="ba-muted ba-small">
              活动结构由工作空间管理员管理，已有活动类型可在客户页面选用。
            </p>
          )}
        </>
      )}
      {creating && (
        <CreateActivityDefinition
          workspace={workspace}
          kind={creating}
          schemas={schemas}
          onClose={() => setCreating(null)}
          onSaved={(id) => changed('已创建，可继续配置属性', { kind: creating, id })}
        />
      )}
      {field && owner && (
        <ActivityFieldDialog
          workspace={workspace}
          owner={owner}
          field={field}
          onClose={() => setField(null)}
          onSaved={() => changed('属性已保存，已有活动保留原版本')}
        />
      )}
    </section>
  );
}

function CreateActivityDefinition({
  workspace,
  kind,
  schemas,
  onClose,
  onSaved,
}: {
  workspace: string;
  kind: 'schema' | 'type';
  schemas: ActivitySchema[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [schema, setSchema] = useState(schemas.find((s) => !s.archived)?.id || '');
  const [description, setDescription] = useState('');
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const item = await api<{ id: string }>(
        kind === 'schema' ? '/activity-schemas' : '/activity-types',
        {
          workspace,
          method: 'POST',
          body:
            kind === 'schema'
              ? { name: name.trim(), description, parent_id: parent || null }
              : { name: name.trim(), description, schema_id: schema, guidance },
        },
      );
      onSaved(item.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={kind === 'schema' ? '新建 Schema' : '新建活动类型'}
      className="ba-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(e) => void save(e)}>
        <div className="form-grid">
          <label className="field wide">
            名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              autoFocus
            />
          </label>
          {kind === 'schema' ? (
            <label className="field wide">
              父 Schema
              <select value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">无 · 新建根结构</option>
                {schemas
                  .filter((s) => !s.archived)
                  .map((s) => (
                    <option key={s.id} value={s.id} disabled={s.depth >= 2}>
                      {s.name}
                      {s.depth >= 2 ? '（二层不可再下设）' : ''}
                    </option>
                  ))}
              </select>
              <small>
                {parent
                  ? '继承所选根结构，不自动生成业务字段。'
                  : '仅创建通用默认字段，业务属性由你明确增加。'}
              </small>
            </label>
          ) : (
            <label className="field wide">
              采用 Schema
              <select value={schema} onChange={(e) => setSchema(e.target.value)} required>
                <option value="" disabled>
                  请选择字段结构
                </option>
                {schemas
                  .filter((s) => !s.archived)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.effective_fields.length} 项属性
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="field wide">
            说明
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </label>
          {kind === 'type' && (
            <label className="field wide">
              AI 整理指引
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                rows={4}
                placeholder="说明哪些内容属于此活动，何时合并或拆分；AI 只填写已启用的已有字段。"
              />
            </label>
          )}
          {error && (
            <p className="error wide" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="form-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !name.trim() || (kind === 'type' && !schema)}
          >
            {busy ? '保存中…' : '创建'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function ActivityConfiguration({
  workspace,
  owner,
  admin,
  onSaved,
}: {
  workspace: string;
  owner: Owner;
  admin: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState(owner.value.name);
  const [description, setDescription] = useState(owner.value.description);
  const [guidance, setGuidance] = useState(owner.kind === 'type' ? owner.value.guidance : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="ba-config-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api(
            `/${owner.kind === 'schema' ? 'activity-schemas' : 'activity-types'}/${owner.value.id}`,
            {
              workspace,
              method: 'PATCH',
              body: {
                version: owner.value.version,
                name: name.trim(),
                description,
                ...(owner.kind === 'type' ? { guidance } : {}),
              },
            },
          );
          onSaved();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        名称
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!admin || busy}
          maxLength={80}
          required
        />
      </label>
      <label className="field">
        说明
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!admin || busy}
        />
      </label>
      {owner.kind === 'type' && (
        <label className="field">
          AI 整理指引
          <textarea
            rows={5}
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            disabled={!admin || busy}
          />
        </label>
      )}
      <p className="ba-muted ba-small">
        已使用的结构保持关联，改名不会改变记录身份。结构调整用于后续整理，历史活动保留原配置。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {admin && (
        <div className="ba-toolbar">
          <span />
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? '保存中…' : '保存配置'}
          </button>
        </div>
      )}
    </form>
  );
}

function ActivityFieldDialog({
  workspace,
  owner,
  field,
  onClose,
  onSaved,
}: {
  workspace: string;
  owner: Owner;
  field: ActivityField | 'new';
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = field === 'new' ? null : field;
  const [name, setName] = useState(initial?.name || '');
  const [kind, setKind] = useState<ActivityFieldKind>(initial?.kind || 'text');
  const [options, setOptions] = useState(initial?.options.join('\n') || '');
  const [required, setRequired] = useState(initial?.required || false);
  const [ai, setAi] = useState(initial?.ai_enabled || false);
  const [guidance, setGuidance] = useState(initial?.guidance || '');
  const [currency, setCurrency] = useState(initial?.currency || 'CNY');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next = {
        ...(initial ? { id: initial.id } : {}),
        name: name.trim(),
        kind,
        options: ['select', 'multi_select'].includes(kind)
          ? [
              ...new Set(
                options
                  .split(/[\n,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            ]
          : [],
        required,
        ai_enabled: ai,
        guidance,
        ...(kind === 'currency' ? { currency } : {}),
      };
      const fields = initial
        ? owner.value.fields.map((f) => (f.id === initial.id ? next : fieldInput(f)))
        : [...owner.value.fields.map(fieldInput), next];
      await api(
        `/${owner.kind === 'schema' ? 'activity-schemas' : 'activity-types'}/${owner.value.id}`,
        { workspace, method: 'PATCH', body: { version: owner.value.version, fields } },
      );
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={initial ? '编辑活动属性' : '创建活动属性'}
      className="ba-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(e) => void save(e)}>
        <div className="form-grid">
          <label className="field">
            名称
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            数据类型
            <select
              value={kind}
              disabled={!!initial}
              onChange={(e) => setKind(e.target.value as ActivityFieldKind)}
            >
              {ordinaryActivityFieldKinds.map((k) => (
                <option key={k} value={k}>
                  {activityKindLabels[k]}
                </option>
              ))}
            </select>
          </label>
          {['select', 'multi_select'].includes(kind) && (
            <label className="field wide">
              选项
              <textarea
                required
                value={options}
                rows={4}
                onChange={(e) => setOptions(e.target.value)}
                placeholder="每行一个选项"
              />
            </label>
          )}
          {kind === 'currency' && (
            <label className="field">
              币种
              <input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                minLength={3}
                maxLength={3}
                required
              />
            </label>
          )}
          <label className="ba-check wide">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            必填
          </label>
          <label className="ba-check wide">
            <input
              type="checkbox"
              checked={ai}
              disabled={initial?.id === activityBaseField.title}
              onChange={(e) => setAi(e.target.checked)}
            />
            <Sparkles size={14} />
            允许 AI 根据原文整理
          </label>
          {initial?.id === activityBaseField.title && (
            <p className="ba-muted ba-small wide">活动标题用于识别每条活动，需由 AI 生成。</p>
          )}
          {ai && (
            <label className="field wide">
              提取指引
              <textarea
                value={guidance}
                rows={4}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder="明确如何识别本字段；没有依据留空。"
              />
            </label>
          )}
          {error && (
            <p className="error wide" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="form-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? '保存中…' : '保存属性'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
