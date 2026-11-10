import { CreateObjectDialog, CustomObjectSettings, CustomObjectIcon } from './CustomObjects';
import { KnowledgeGraphWorkspace } from './KnowledgeGraph';
import type { CustomObject } from '../shared/custom-objects';
import { useEffect, useState, useRef } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  Box,
  Building,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronRight,
  ChevronDown,
  CircleDot,
  ContactRound,
  FolderClosed,
  Hash,
  LayoutGrid,
  LockKeyhole,
  Mail,
  MoreVertical,
  Plus,
  Phone,
  Search,
  SlidersHorizontal,
  Sparkle,
  Tags,
  UserRound,
} from 'lucide-react';
import { api } from './api';
import { AttributeFieldDialog } from './CompanyAttributes';
import { Dialog } from './WorkspaceUI';
import { WorkspacePageHeader, WorkspacePageTabs } from './WorkspacePage';
import { attributeKinds, type CompanyAttribute } from '../shared/attributes';
import {
  cardinalities,
  objectNames,
  type Cardinality,
  type ObjectKind,
  type RelationDefinition,
} from '../shared/connections';
import {
  relationAttributes,
  relationshipLimits,
  systemAttributes,
  systemRelationships,
} from '../shared/object-settings';
import './entity-settings.css';

const objects: ObjectKind[] = ['customers', 'people', 'projects'];
const objectDescriptions = {
  customers: '管理客户档案、合作信息与公司属性',
  people: '管理联系人资料及其所属公司、参与项目',
  projects: '管理客户项目、进展与项目联系人',
};
const objectIcons = { customers: Building, people: ContactRound, projects: FolderClosed };
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
const isSystem = (d: RelationDefinition) => systemRelationships.some((s) => s.id === d.id);
type AttributeRow = {
  id: string;
  name: string;
  type: string;
  description: string;
  options?: string[];
  constraints?: string[];
  automated?: boolean;
  properties?: string[];
  custom?: CompanyAttribute;
  relation?: ReturnType<typeof relationAttributes>[number];
};

function AttributeIcon({ attribute }: { attribute: AttributeRow }) {
  const { type, relation } = attribute;
  const Icon = relation
    ? objectIcons[relation.object]
    : type === '数字'
      ? Hash
      : type === '单选'
        ? CircleDot
        : type === '多选'
          ? Tags
          : ['日期 / 时间', '日期', '日期与时间'].includes(type)
            ? CalendarDays
            : type === '邮箱'
              ? Mail
              : type === '电话'
                ? Phone
                : ['成员', '用户'].includes(type)
                  ? UserRound
                  : type === '复选框'
                    ? CheckSquare
                    : null;
  if (Icon) return <Icon size={16} aria-hidden="true" />;
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.25" y="4" width="15.5" height="12" rx="3" />
      <path d="m5 12.5 2-5 2 5M5.7 10.8h2.6M12 8h2.5M12 11h2.5" />
    </svg>
  );
}

export function RelationSettings({
  workspace,
  onChanged,
  onOpenCustom,
  initialCustomId,
}: {
  workspace: string;
  onChanged?: () => void;
  onOpenCustom?: (object: CustomObject) => void;
  initialCustomId?: string | null;
}) {
  const initialOpened = useRef<string | null>(null);
  const [customObjects, setCustomObjects] = useState<CustomObject[]>([]);
  const [customObject, setCustomObject] = useState<CustomObject | null>(null);
  const [createObject, setCreateObject] = useState(false);
  const [objectQuery, setObjectQuery] = useState('');
  const [objectFilter, setObjectFilter] = useState('all');
  const [data, setData] = useState<{
    fields: CompanyAttribute[];
    relations: RelationDefinition[];
  } | null>(null);
  const [object, setObject] = useState<ObjectKind | null>(null);
  const [tab, setTab] = useState<'attributes' | 'relations' | 'graph'>('attributes');
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all');
  const [revision, setRevision] = useState(0),
    [error, setError] = useState('');
  const [attributeDialog, setAttributeDialog] = useState<CompanyAttribute | 'new' | null>(null);
  const [relationshipDialog, setRelationshipDialog] = useState(false);
  const [detail, setDetail] = useState<AttributeRow | null>(null);
  const [archive, setArchive] = useState<CompanyAttribute | null>(null);
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const c = new AbortController();
    setError('');
    Promise.all([
      api<CustomObject[]>('/custom-objects', { workspace, signal: c.signal }),
      api<CompanyAttribute[]>('/attributes', { workspace, signal: c.signal }),
      api<RelationDefinition[]>('/relationships', { workspace, signal: c.signal }),
    ])
      .then(([customs, fields, relations]) => {
        if (!c.signal.aborted) {
          setData({ fields, relations });
          setCustomObjects(customs);
          if (initialCustomId && initialOpened.current !== initialCustomId) {
            initialOpened.current = initialCustomId;
            setCustomObject(customs.find((o) => o.id === initialCustomId) || null);
          }
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorText(e));
      });
    return () => c.abort();
  }, [workspace, revision, initialCustomId]);

  function changed(message: string) {
    setNotice(message);
    setRevision((n) => n + 1);
    onChanged?.();
  }
  function selectObject(next: ObjectKind | null) {
    setObject(next);
    setTab('attributes');
    setQuery('');
    setFilter('all');
    setNotice('');
  }
  const definitions = [...systemRelationships, ...(data?.relations || [])];
  const activeFields = data?.fields.filter((f) => !f.archived) || [];
  const ownRelations = object ? relationAttributes(definitions, object) : [];
  const attributes: AttributeRow[] = object
    ? [
        ...systemAttributes(object),
        ...(object === 'customers'
          ? (data?.fields || []).map((custom) => ({
              id: custom.id,
              name: custom.name,
              type: attributeKinds[custom.kind],
              description: custom.description,
              options: custom.options,
              constraints: [],
              properties: ['select', 'multi_select'].includes(custom.kind)
                ? [`${custom.options.length} 个选项`]
                : [],
              custom,
            }))
          : []),
        ...ownRelations.map((relation) => ({
          id: relation.id,
          name: relation.name,
          type: '关系',
          description: `${objectNames[object]}的“${relation.name}”与${objectNames[relation.object]}的“${relation.inverse}”双向同步。`,
          relation,
          constraints: isSystem(relation.definition) && object !== 'customers' ? ['必填'] : [],
          properties: ['双向同步', cardinalities[relation.cardinality]],
        })),
      ]
    : [];
  const visibleAttributes = attributes.filter((a) => {
    const archived = !!a.custom?.archived;
    const custom = !!a.custom || (!!a.relation && !isSystem(a.relation.definition));
    if (filter === 'archived' ? !archived : archived) return false;
    if (
      (filter === 'system' && custom) ||
      (filter === 'custom' && !custom) ||
      (filter === 'ai' && !a.custom?.ai_enabled)
    )
      return false;
    return `${a.name} ${a.type} ${a.relation ? objectNames[a.relation.object] : ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });
  const visibleRelations = definitions.filter((d) => {
    if (object && d.source_object !== object && d.target_object !== object) return false;
    if ((filter === 'system' && !isSystem(d)) || (filter === 'custom' && isSystem(d))) return false;
    return `${d.source_label} ${d.target_label} ${objectNames[d.source_object]} ${objectNames[d.target_object]}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });
  const showingAttributes = !!object && tab === 'attributes';
  const showingObjects = !object && tab === 'attributes';
  const aiCount = attributes.filter((a) => a.custom?.ai_enabled && !a.custom.archived).length;

  if (customObject)
    return (
      <CustomObjectSettings
        key={customObject.id}
        workspace={workspace}
        object={customObject}
        onBack={() => {
          setCustomObject(null);
          setRevision((n) => n + 1);
        }}
        onChanged={() => {
          onChanged?.();
        }}
        onOpen={onOpenCustom}
      />
    );

  return (
    <section className="entity-settings workspace-page">
      <WorkspacePageHeader
        title="实体与关系"
        description="管理实体、属性与关联类型，查看已有知识图谱。"
      />
      <div
        className={`entity-settings-body ${object ? 'is-object' : ''} ${tab === 'graph' ? 'is-graph' : ''}`}
      >
        {object && (
          <div className="entity-object-summary">
            <button className="entity-back-button" onClick={() => selectObject(null)}>
              <ArrowLeft size={14} />
              返回全部实体
            </button>
            <div>
              <h2>{objectNames[object]}</h2>
              <span className="entity-badge">系统实体</span>
            </div>
            <p>查看和管理{objectNames[object]}已有的属性与关系。</p>
          </div>
        )}
        <WorkspacePageTabs
          className="entity-tabs"
          label={object ? `${objectNames[object]}设置` : '实体与关系设置'}
        >
          {(['attributes', 'relations', ...(!object ? ['graph' as const] : [])] as const).map(
            (t) => (
              <button
                key={t}
                role="tab"
                id={`entity-tab-${t}`}
                aria-selected={tab === t}
                aria-controls="entity-settings-panel"
                onClick={() => {
                  setTab(t);
                  setQuery('');
                  setFilter('all');
                }}
              >
                {t === 'attributes'
                  ? object
                    ? '属性'
                    : '实体'
                  : t === 'graph'
                    ? '知识图谱'
                    : '关系'}
                {t !== 'graph' && (
                  <span className="workspace-page-count">
                    {t === 'attributes'
                      ? object
                        ? attributes.filter((a) => !a.custom?.archived).length
                        : 3 + customObjects.length
                      : object
                        ? new Set(ownRelations.map((r) => r.definition.id)).size
                        : definitions.length}
                  </span>
                )}
              </button>
            ),
          )}
        </WorkspacePageTabs>

        {notice && (
          <p className="entity-success" role="status">
            <Check size={13} />
            {notice}
          </p>
        )}
        {error && (
          <div className="entity-load-error" role="alert">
            <p>{error}</p>
            <button onClick={() => setRevision((n) => n + 1)}>重新读取设置</button>
          </div>
        )}
        <div id="entity-settings-panel" role="tabpanel" aria-labelledby={`entity-tab-${tab}`}>
          {tab === 'graph' ? (
            <KnowledgeGraphWorkspace workspace={workspace} />
          ) : !data ? (
            !error && (
              <p className="entity-state" role="status">
                正在读取实体设置…
              </p>
            )
          ) : showingObjects ? (
            <>
              <div className="entity-create-action">
                <div>
                  <h2>实体</h2>
                  <p>管理工作空间中的实体与属性</p>
                </div>
                <button className="primary" onClick={() => setCreateObject(true)}>
                  <Plus size={14} />
                  创建自定义实体
                </button>
              </div>
              <div className="entity-toolbar entity-object-toolbar">
                <label className="entity-search">
                  <Search size={15} />
                  <input
                    aria-label="搜索实体"
                    placeholder="搜索实体…"
                    value={objectQuery}
                    onChange={(e) => setObjectQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label="筛选实体"
                  value={objectFilter}
                  onChange={(e) => setObjectFilter(e.target.value)}
                >
                  <option value="all">全部实体</option>
                  <option value="system">系统实体</option>
                  <option value="custom">自定义实体</option>
                </select>
              </div>
              <div className="entity-object-list">
                <div className="entity-object-labels">
                  <span>实体</span>
                  <span>属性</span>
                  <span>关系</span>
                  <span />
                </div>
                {objects
                  .filter(
                    (kind) =>
                      objectFilter !== 'custom' && objectNames[kind].includes(objectQuery.trim()),
                  )
                  .map((kind) => {
                    const ObjectIcon = objectIcons[kind];
                    const relations = relationAttributes(definitions, kind);
                    return (
                      <button
                        key={kind}
                        className="entity-object-row"
                        onClick={() => selectObject(kind)}
                      >
                        <span className="entity-object-name">
                          <span className="entity-icon">
                            <ObjectIcon size={18} aria-hidden="true" />
                          </span>
                          <span>
                            <strong>
                              {objectNames[kind]}
                              <small>系统实体</small>
                            </strong>
                            <span>{objectDescriptions[kind]}</span>
                          </span>
                        </span>
                        <span className="entity-object-stat">
                          <span>
                            <strong>
                              {systemAttributes(kind).length +
                                relations.length +
                                (kind === 'customers' ? activeFields.length : 0)}
                            </strong>
                            <small>个属性</small>
                          </span>
                          {kind === 'customers' && activeFields.some((f) => f.ai_enabled) && (
                            <small className="entity-object-ai">
                              <Sparkle size={12} />
                              {activeFields.filter((f) => f.ai_enabled).length} 个 AI 填充
                            </small>
                          )}
                        </span>
                        <span>
                          {new Set(relations.map((r) => r.definition.id)).size}
                          <small>种关系</small>
                        </span>
                        <span className="entity-open-attributes">
                          查看属性
                          <ChevronRight size={14} />
                        </span>
                      </button>
                    );
                  })}
                {customObjects
                  .filter(
                    (o) =>
                      objectFilter !== 'system' &&
                      `${o.name} ${o.slug}`
                        .toLowerCase()
                        .includes(objectQuery.trim().toLowerCase()),
                  )
                  .map((o) => (
                    <button
                      key={o.id}
                      className="entity-object-row"
                      onClick={() => setCustomObject(o)}
                    >
                      <span className="entity-object-name">
                        <CustomObjectIcon object={o} size={18} badge />
                        <span>
                          <strong>
                            {o.name}
                            <small className="custom-badge">自定义实体</small>
                          </strong>
                          <span>
                            /{o.slug} · {o.record_count} 条记录
                          </span>
                        </span>
                      </span>
                      <span className="entity-object-stat">
                        <span>
                          <strong>{o.attribute_count}</strong>
                          <small>个属性</small>
                        </span>
                      </span>
                      <span>
                        2<small>个记录引用</small>
                      </span>
                      <span className="entity-open-attributes">
                        查看属性
                        <ChevronRight size={14} />
                      </span>
                    </button>
                  ))}
                {(objectFilter === 'custom' ||
                  !objects.some((k) => objectNames[k].includes(objectQuery.trim()))) &&
                  !customObjects.some(
                    (o) =>
                      objectFilter !== 'system' &&
                      `${o.name} ${o.slug}`
                        .toLowerCase()
                        .includes(objectQuery.trim().toLowerCase()),
                  ) && <p className="entity-state">没有匹配的实体</p>}
              </div>
            </>
          ) : (
            <>
              <div className="entity-attributes-heading">
                <div>
                  <h3>
                    {showingAttributes ? '属性' : '关系'}
                    <span>
                      {showingAttributes
                        ? attributes.filter((a) => !a.custom?.archived).length
                        : object
                          ? new Set(ownRelations.map((r) => r.definition.id)).size
                          : definitions.length}
                    </span>
                    {showingAttributes && aiCount > 0 && (
                      <button
                        className="entity-ai-filter"
                        aria-pressed={filter === 'ai'}
                        onClick={() => setFilter(filter === 'ai' ? 'all' : 'ai')}
                      >
                        <Sparkle size={13} />
                        AI 填充 {aiCount}
                      </button>
                    )}
                  </h3>
                  <p>
                    {showingAttributes
                      ? '系统属性、自定义属性与 AI 填充属性在此统一查看。'
                      : '查看两端名称与数量限制，创建双向关系。'}
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() =>
                    showingAttributes && object === 'customers'
                      ? setAttributeDialog('new')
                      : setRelationshipDialog(true)
                  }
                >
                  <Plus size={15} />
                  {showingAttributes && object === 'customers' ? '创建属性' : '创建关系'}
                </button>
              </div>
              <div className="entity-toolbar">
                <label className="entity-search">
                  <Search size={16} />
                  <input
                    aria-label={showingAttributes ? '搜索属性' : '搜索关系'}
                    placeholder={showingAttributes ? '搜索属性…' : '搜索关系…'}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <label className="entity-filter">
                  <SlidersHorizontal size={15} aria-hidden="true" />
                  <select
                    aria-label={showingAttributes ? '筛选属性' : '筛选关系'}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">全部{showingAttributes ? '属性' : '关系'}</option>
                    <option value="system">系统</option>
                    <option value="custom">自定义</option>
                    {showingAttributes && <option value="ai">AI 填充</option>}
                    {showingAttributes && object === 'customers' && (
                      <>
                        <option value="archived">已停用</option>
                      </>
                    )}
                  </select>
                  <ChevronDown size={13} aria-hidden="true" />
                </label>
                <span>
                  {showingAttributes ? visibleAttributes.length : visibleRelations.length} 项
                </span>
              </div>
              {showingAttributes ? (
                <>
                  {object !== 'customers' && (
                    <p className="entity-scope-note">
                      当前支持系统属性与关系属性；自定义普通属性和 AI 填充暂仅支持公司。
                    </p>
                  )}
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
                          <th>
                            <span className="entity-table-label">
                              <LayoutGrid size={14} />
                              属性标记
                            </span>
                          </th>
                          <th>
                            <span className="sr-only">操作</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleAttributes.map((a) => (
                          <tr key={a.id} className={a.custom?.archived ? 'entity-archived' : ''}>
                            <td>
                              <button
                                className="entity-field-name"
                                onClick={() =>
                                  a.custom && !a.custom.archived
                                    ? setAttributeDialog(a.custom)
                                    : setDetail(a)
                                }
                              >
                                <AttributeIcon attribute={a} />
                                <span>{a.name}</span>
                                {a.relation && (
                                  <span className="entity-linked-object">
                                    <ArrowLeftRight size={11} aria-hidden="true" />
                                    {objectNames[a.relation.object]}
                                  </span>
                                )}
                              </button>
                            </td>
                            <td>{a.type}</td>
                            <td>
                              <span className="entity-constraints">
                                {a.constraints?.length ? a.constraints.join(' · ') : '—'}
                              </span>
                            </td>
                            <td>
                              <div className="entity-property-tags">
                                <span className="entity-badge">
                                  {a.custom || (a.relation && !isSystem(a.relation.definition))
                                    ? '自定义'
                                    : '系统'}
                                </span>
                                {a.custom?.ai_enabled && (
                                  <span className="entity-ai-badge">
                                    <Sparkle size={12} />
                                    AI 填充
                                  </span>
                                )}
                                {a.properties?.map((p) => (
                                  <span key={p} className="entity-badge">
                                    {p}
                                  </span>
                                ))}
                                {a.automated && <span className="entity-badge">自动计算</span>}
                                {a.custom?.archived && <span className="entity-badge">已停用</span>}
                                {!!a.options?.length && !a.custom?.ai_enabled && (
                                  <span className="entity-option-count">
                                    {a.options.length} 个选项
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label={`${a.custom ? '管理' : '查看'}${a.name}设置`}
                                onClick={() => setDetail(a)}
                              >
                                <MoreVertical size={15} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!visibleAttributes.length && (
                    <div className="entity-empty">
                      <Search size={20} />
                      <strong>
                        {query
                          ? '没有匹配的属性'
                          : filter === 'archived'
                            ? '暂无停用属性'
                            : filter === 'ai'
                              ? '暂无 AI 填充属性'
                              : '暂无此类属性'}
                      </strong>
                      <span>可调整搜索或筛选条件。</span>
                      <button
                        onClick={() => {
                          setQuery('');
                          setFilter('all');
                        }}
                      >
                        显示全部属性
                      </button>
                    </div>
                  )}
                  <p className="entity-footnote">
                    系统字段的定义固定，字段值在档案中维护。AI 填充使用已保存的
                    Guidance，需在公司表格手动运行。
                  </p>
                </>
              ) : (
                <>
                  <div className="entity-relation-list">
                    {visibleRelations.map((d) => (
                      <button
                        key={d.id}
                        className="entity-relation-row"
                        onClick={() => {
                          const side = relationAttributes([d], object || d.source_object)[0];
                          setDetail({
                            id: side.id,
                            name: side.name,
                            type: '关系',
                            description: `两端共用同一条关联，添加或移除会同步显示。${isSystem(d) ? '系统归属固定。' : '仅连接同一客户下的记录；对象和数量限制创建后固定。'}`,
                            relation: side,
                          });
                        }}
                      >
                        <span>
                          <small>{objectNames[d.source_object]}</small>
                          <strong>{d.source_label}</strong>
                        </span>
                        <span className="entity-relation-direction">
                          <ArrowLeftRight size={16} />
                          <small>{cardinalities[d.cardinality]}</small>
                        </span>
                        <span>
                          <small>{objectNames[d.target_object]}</small>
                          <strong>{d.target_label}</strong>
                        </span>
                        <span className="entity-badge">{isSystem(d) ? '系统归属' : '自定义'}</span>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                  {!visibleRelations.length && (
                    <div className="entity-empty">
                      <ArrowLeftRight size={21} />
                      <strong>
                        {query || filter === 'system' ? '没有匹配的关系' : '还没有自定义关系'}
                      </strong>
                      <span>例如：项目联系人 ↔ 参与项目</span>
                      <button onClick={() => setRelationshipDialog(true)}>
                        <Plus size={13} />
                        创建关系
                      </button>
                    </div>
                  )}
                  <p className="entity-footnote">
                    创建关系定义后，在具体档案的“关联记录”中选择记录。从任一端添加或移除，另一端同步显示。
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {createObject && (
        <CreateObjectDialog
          workspace={workspace}
          onClose={() => setCreateObject(false)}
          onCreated={(o) => {
            setCreateObject(false);
            setCustomObjects((old) => [...old, o]);
            setCustomObject(o);
            onChanged?.();
          }}
        />
      )}
      {attributeDialog && (
        <AttributeFieldDialog
          workspace={workspace}
          field={attributeDialog === 'new' ? undefined : attributeDialog}
          onClose={() => setAttributeDialog(null)}
          onSaved={() => {
            setAttributeDialog(null);
            changed('公司属性已保存，表格和档案已同步更新。');
          }}
          onCreateRelationship={
            attributeDialog === 'new'
              ? () => {
                  setAttributeDialog(null);
                  setRelationshipDialog(true);
                }
              : undefined
          }
        />
      )}
      {relationshipDialog && (
        <RelationshipDialog
          workspace={workspace}
          object={object || 'projects'}
          onClose={() => setRelationshipDialog(false)}
          onSaved={() => {
            setRelationshipDialog(false);
            changed('关系已创建，可在两端档案中添加关联记录。');
          }}
        />
      )}
      {detail && (
        <Dialog
          title={detail.name}
          className="entity-detail-dialog"
          onClose={() => setDetail(null)}
        >
          <div className="entity-detail-body">
            <span className="entity-badge">
              {detail.custom || (detail.relation && !isSystem(detail.relation.definition))
                ? '自定义属性'
                : '系统属性'}
            </span>
            <p>{detail.description || '公司自定义属性，在表格和档案中复用。'}</p>
            {detail.relation ? (
              <dl>
                <div>
                  <dt>当前实体</dt>
                  <dd>
                    {objectNames[object || detail.relation.definition.source_object]} ·{' '}
                    {detail.relation.name}
                  </dd>
                </div>
                <div>
                  <dt>关联实体</dt>
                  <dd>
                    {objectNames[detail.relation.object]} · {detail.relation.inverse}
                  </dd>
                </div>
                <div>
                  <dt>数量限制</dt>
                  <dd>{cardinalities[detail.relation.cardinality]}</dd>
                </div>
                <div>
                  <dt>配置</dt>
                  <dd>
                    {isSystem(detail.relation.definition)
                      ? '系统归属，不可修改'
                      : '双向同步 · 创建后对象与数量固定'}
                  </dd>
                </div>
              </dl>
            ) : (
              <dl>
                <div>
                  <dt>类型</dt>
                  <dd>{detail.type}</dd>
                </div>
                {!!detail.constraints?.length && (
                  <div>
                    <dt>约束</dt>
                    <dd>{detail.constraints.join(' · ')}</dd>
                  </div>
                )}
                {!!detail.properties?.length && (
                  <div>
                    <dt>行为与配置</dt>
                    <dd>{detail.properties.join(' · ')}</dd>
                  </div>
                )}
                {detail.custom?.ai_enabled && (
                  <>
                    <div>
                      <dt>AI 填充</dt>
                      <dd>已启用 · 在公司表格手动运行</dd>
                    </div>
                    <div>
                      <dt>Guidance</dt>
                      <dd className="entity-guidance">{detail.custom.guidance}</dd>
                    </div>
                  </>
                )}
                {!!detail.options?.length && (
                  <div>
                    <dt>选项</dt>
                    <dd className="entity-option-list">
                      {detail.options.map((o) => (
                        <span className="entity-badge" key={o}>
                          {o}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </div>
          <footer className="form-footer">
            <button onClick={() => setDetail(null)}>关闭</button>
            {detail.custom && (
              <>
                <button
                  onClick={() => {
                    setActionError('');
                    setArchive(detail.custom!);
                    setDetail(null);
                  }}
                >
                  {detail.custom.archived ? '恢复属性' : '停用属性'}
                </button>
                {!detail.custom.archived && (
                  <button
                    className="primary"
                    onClick={() => {
                      setAttributeDialog(detail.custom!);
                      setDetail(null);
                    }}
                  >
                    编辑属性与 AI 配置
                  </button>
                )}
              </>
            )}
          </footer>
        </Dialog>
      )}
      {archive && (
        <Dialog
          title={archive.archived ? '恢复属性' : '停用属性'}
          className="entity-detail-dialog"
          onClose={() => {
            if (!busy) setArchive(null);
          }}
        >
          <div className="entity-detail-body">
            <p>
              {archive.archived
                ? `恢复“${archive.name}”后，可在公司表格和档案中重新使用已有值。`
                : `停用“${archive.name}”后，将不再显示在公司表格和档案中；已有值保留，可以恢复。`}
            </p>
            {actionError && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
          </div>
          <footer className="form-footer">
            <button disabled={busy} onClick={() => setArchive(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setActionError('');
                try {
                  const { id, ...body } = archive;
                  await api(`/attributes/${id}`, {
                    workspace,
                    method: 'PATCH',
                    body: { ...body, archived: !archive.archived },
                  });
                  changed(
                    archive.archived ? '属性已恢复，已有值继续保留。' : '属性已停用，已有值保留。',
                  );
                  setArchive(null);
                } catch (e) {
                  setActionError(errorText(e));
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

function RelationshipDialog({
  workspace,
  object,
  onClose,
  onSaved,
}: {
  workspace: string;
  object: ObjectKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [source, setSource] = useState<ObjectKind>(object),
    [target, setTarget] = useState<ObjectKind>(object === 'projects' ? 'people' : 'projects');
  const [sourceLabel, setSourceLabel] = useState(''),
    [targetLabel, setTargetLabel] = useState('');
  const [cardinality, setCardinality] = useState<Cardinality>(
    object === 'customers' ? 'one_to_many' : 'many_to_many',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const limits = relationshipLimits(cardinality);
  return (
    <Dialog
      title="创建关系属性"
      className="entity-relationship-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('/relationships', {
              workspace,
              method: 'POST',
              body: {
                source_object: source,
                target_object: target,
                source_label: sourceLabel,
                target_label: targetLabel,
                cardinality,
              },
            });
            onSaved();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="entity-relationship-fields">
          <p className="entity-dialog-intro">在两个实体中各创建一个属性，共用同一条关联。</p>
          <div className="entity-relationship-sides">
            <div>
              <label>
                起点实体
                <select value={source} onChange={(e) => setSource(e.target.value as ObjectKind)}>
                  {objects.map((o) => (
                    <option value={o} key={o}>
                      {objectNames[o]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                在{objectNames[source]}中显示的名称
                <input
                  required
                  maxLength={60}
                  value={sourceLabel}
                  onChange={(e) => setSourceLabel(e.target.value)}
                  placeholder={source === 'projects' ? '例如：项目联系人' : '例如：参与项目'}
                />
              </label>
            </div>
            <ArrowLeftRight size={19} />
            <div>
              <label>
                关联实体
                <select value={target} onChange={(e) => setTarget(e.target.value as ObjectKind)}>
                  {objects.map((o) => (
                    <option value={o} key={o}>
                      {objectNames[o]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                在{objectNames[target]}中显示的名称
                <input
                  required
                  maxLength={60}
                  value={targetLabel}
                  onChange={(e) => setTargetLabel(e.target.value)}
                  placeholder={target === 'people' ? '例如：参与项目' : '例如：项目联系人'}
                />
              </label>
            </div>
          </div>
          <label>
            关系数量
            <select
              value={cardinality}
              onChange={(e) => setCardinality(e.target.value as Cardinality)}
            >
              {Object.entries(cardinalities).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <div className="entity-relationship-preview" aria-live="polite">
            <span>关系预览</span>
            <div>
              <strong>{sourceLabel.trim() || `${objectNames[source]}中的属性`}</strong>
              <ArrowLeftRight size={15} />
              <strong>{targetLabel.trim() || `${objectNames[target]}中的属性`}</strong>
            </div>
            <p>
              每个{objectNames[source]}可关联{limits.targets}
              {objectNames[target]}；每个{objectNames[target]}可关联{limits.sources}
              {objectNames[source]}。
            </p>
          </div>
          <p className="entity-dialog-note">
            <LockKeyhole size={13} />
            仅连接同一客户下的记录。两端对象和数量限制创建后固定，系统归属保持唯一。
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </fieldset>
        <footer className="form-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !sourceLabel.trim() || !targetLabel.trim()}>
            {busy ? '创建中…' : '创建关系'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
