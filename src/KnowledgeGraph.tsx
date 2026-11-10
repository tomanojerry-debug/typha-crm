import { useCallback, useEffect, useMemo, useState } from 'react';
import { Focus, MessagesSquare, Network, RefreshCw, Search } from 'lucide-react';
import { api, isDemoRuntime } from './api';
import { RecordEvidence } from './RecordEvidence';
import type { Customer, Project } from '../shared/domain';
import type { KnowledgeGraphNode, KnowledgeGraphView } from '../shared/knowledge';
import { KnowledgeFocusGraph, type GraphSelection } from './KnowledgeFocusGraph';
import { KnowledgeOverviewGraph } from './KnowledgeOverviewGraph';
import { describeKnowledgeNode } from './knowledge-node-card';
import './knowledge-graph.css';

const states: Record<KnowledgeGraphView['state'], string> = {
  not_synced: '尚未同步',
  pending: '等待同步',
  syncing: '正在整理',
  ready: '已同步',
  failed: '同步失败',
  disabled: '尚未启用',
};
const origins = { crm: '正式档案', candidate: '识别实体', claim: '信息主张' };
const kinds = {
  crm_relationship: '正式关系',
  attribute_candidate: '属性候选',
  relation_candidate: '关系候选',
  explicit_correction: '明确纠正候选',
  proposed_change: '修改请求候选',
};
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const errorText = (e: unknown) => (e instanceof Error ? e.message : '读取失败，请重试');
const textValue = (value: unknown): string =>
  value == null
    ? '未填写'
    : typeof value === 'object'
      ? JSON.stringify(value, null, 2)
      : String(value);
const objectLabels: Record<string, string> = {
  customers: '公司',
  people: '联系人',
  projects: '项目',
};

export function KnowledgeGraphWorkspace({ workspace }: { workspace: string }) {
  const [customerQuery, setCustomerQuery] = useState(''),
    [customerPage, setCustomerPage] = useState(1);
  const [directory, setDirectory] = useState<{
    key: string;
    items: Customer[];
    total: number;
    loading: boolean;
    error: string;
  }>({ key: '', items: [], total: 0, loading: true, error: '' });
  const [customerId, setCustomerId] = useState(''),
    [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]),
    [graphData, setData] = useState<KnowledgeGraphView | null>(null);
  const [loadedScope, setLoadedScope] = useState('');
  const [projectsScope, setProjectsScope] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const graphScope = JSON.stringify([workspace, customerId, projectId, revision]);
  const data = loadedScope === graphScope ? graphData : null;
  const [query, setQuery] = useState(''),
    [layer, setLayer] = useState('all'),
    [selected, setSelected] = useState<{ kind: 'node' | 'edge'; key: string } | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [graphMode, setGraphMode] = useState<'overview' | 'focus'>('overview');
  const [initialFocusKey, setInitialFocusKey] = useState<string | null>(null);
  const [sourceQuery, setSourceQuery] = useState('');
  const [schema, setSchema] = useState<{
    objects?: {
      id: string;
      name: string;
      attributes: {
        id: string;
        name: string;
        type: string;
        storage_key?: string;
        currency?: string;
        option_labels?: Record<string, string>;
      }[];
    }[];
  } | null>(null);
  const [schemaWorkspace, setSchemaWorkspace] = useState('');
  const currentSchema = schemaWorkspace === workspace ? schema : null;
  const [inspectorTab, setInspectorTab] = useState<'details' | 'sources' | 'all-sources'>(
    'all-sources',
  );
  const selectGraphItem = useCallback((selection: GraphSelection) => {
    setSelected(selection);
    if (selection) setInspectorTab('details');
  }, []);
  const directoryKey = JSON.stringify([workspace, customerQuery, customerPage, revision]);
  const directoryCurrent = directory.key === directoryKey;
  const directoryLoading = !directoryCurrent || directory.loading;
  const customers = directoryCurrent ? directory.items : [];
  const total = directoryCurrent ? directory.total : 0;
  const directoryError = directoryCurrent ? directory.error : '';

  useEffect(() => {
    const c = new AbortController();
    setDirectory({ key: directoryKey, items: [], total: 0, loading: true, error: '' });
    const timer = setTimeout(() => {
      api<{ items: Customer[]; total: number }>(
        `/customers?${new URLSearchParams({ q: customerQuery, page: String(customerPage) })}`,
        { workspace, signal: c.signal },
      )
        .then((result) => {
          if (!c.signal.aborted) {
            setDirectory({
              key: directoryKey,
              items: result.items,
              total: result.total,
              loading: false,
              error: '',
            });
          }
        })
        .catch((e) => {
          if (!c.signal.aborted) {
            setDirectory({
              key: directoryKey,
              items: [],
              total: 0,
              loading: false,
              error: errorText(e),
            });
          }
        });
    }, 180);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [workspace, customerQuery, customerPage, revision, directoryKey]);
  useEffect(() => {
    const c = new AbortController();
    setSchema(null);
    setSchemaWorkspace('');
    api<NonNullable<typeof schema>>('/entity-schema', { workspace, signal: c.signal })
      .then((value) => {
        if (!c.signal.aborted) {
          setSchema(value);
          setSchemaWorkspace(workspace);
        }
      })
      .catch(() => {
        if (!c.signal.aborted) setSchema(null);
      });
    return () => c.abort();
  }, [workspace, revision]);
  useEffect(() => {
    const c = new AbortController();
    setProjects([]);
    setProjectsScope('');
    if (customerId)
      api<Project[]>(`/customers/${customerId}/projects`, { workspace, signal: c.signal })
        .then((rows) => {
          if (!c.signal.aborted) {
            setProjects(rows.filter((p) => !p.archived_at));
            setProjectsScope(JSON.stringify([workspace, customerId]));
          }
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(errorText(e));
        });
    return () => c.abort();
  }, [workspace, customerId, revision]);
  useEffect(() => {
    const c = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setLoadedScope('');
    setError('');
    setSelected(null);
    setRecordId(null);
    setInspectorTab('all-sources');
    setInitialFocusKey(null);
    setSourceQuery('');
    if (!customerId) return () => c.abort();
    const load = async () => {
      try {
        const result = await api<KnowledgeGraphView>(
          `/customers/${customerId}/knowledge/graph?${new URLSearchParams(projectId ? { project_id: projectId } : {})}`,
          { workspace, signal: c.signal },
        );
        if (c.signal.aborted) return;
        setLoadedScope(graphScope);
        setData(result);
        if (['pending', 'syncing'].includes(result.state))
          timer = setTimeout(() => void load(), 5000);
      } catch (e) {
        if (!c.signal.aborted) {
          setData(null);
          setError(errorText(e));
        }
      }
    };
    void load();
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [workspace, customerId, projectId, revision, graphScope]);
  useEffect(() => {
    setCustomerId('');
    setProjectId('');
    setSelected(null);
    setRecordId(null);
    setQuery('');
    setLayer('all');
  }, [workspace]);
  async function sync() {
    setBusy(true);
    setError('');
    try {
      await api(`/customers/${customerId}/knowledge/sync`, { workspace, method: 'POST', body: {} });
      setRevision((v) => v + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const visible = useMemo(() => {
    const all = data?.nodes || [],
      allEdges = data?.edges || [];
    const eligible = all.filter(
      (n) => layer === 'all' || (layer === 'crm' ? n.origin === 'crm' : n.origin !== 'crm'),
    );
    const needle = query.trim().toLowerCase();
    const matches = new Set(
      eligible
        .filter((n) =>
          `${n.name} ${n.labels.join(' ')} ${textValue(n.attributes)}`
            .toLowerCase()
            .includes(needle),
        )
        .map((n) => n.key),
    );
    const directMatches = new Set(matches);
    if (needle)
      for (const e of allEdges)
        if (
          directMatches.has(e.source) ||
          directMatches.has(e.target) ||
          `${e.label} ${e.fact}`.toLowerCase().includes(needle)
        ) {
          matches.add(e.source);
          matches.add(e.target);
        }
    const filtered = eligible.filter((n) => !needle || matches.has(n.key));
    const nodes = filtered,
      keys = new Set(nodes.map((n) => n.key));
    return {
      nodes,
      edges: allEdges.filter((e) => keys.has(e.source) && keys.has(e.target)),
      total: filtered.length,
    };
  }, [data, layer, query]);
  const node =
      selected?.kind === 'node' ? visible.nodes.find((n) => n.key === selected.key) : undefined,
    edge =
      selected?.kind === 'edge' ? visible.edges.find((e) => e.key === selected.key) : undefined;
  const sourceIds = new Set(node?.source_ids || edge?.source_ids || []);
  const sources = data?.sources?.filter((s) => sourceIds.has(s.id)) || [];
  const schemaObject = currentSchema?.objects?.find((o) => o.id === node?.object_id);
  const displayAttributes = Object.entries(node?.attributes || {}).flatMap(([id, value]) => {
    if (
      [
        'id',
        'workspace_id',
        'object_id',
        'version',
        'canonical_id',
        'candidate',
        'created_by',
        'owner_id',
        'record_id',
        'field_id',
        'evidence',
        'field_provenance',
        'speaker_id',
        'entity_ref',
        'from_ref',
        'to_ref',
      ].includes(id)
    )
      return [];
    if (id === 'values' && value && typeof value === 'object' && !Array.isArray(value))
      return Object.entries(value);
    if (id === 'custom_attributes' && Array.isArray(value))
      return value.map(
        (v: { attribute_id: string; value: unknown; origin: string }) =>
          [v.attribute_id, v.value] as [string, unknown],
      );
    return [[id, value] as [string, unknown]];
  });
  const fieldFor = (id: string) =>
    schemaObject?.attributes.find(
      (a) => a.id === id || a.storage_key === id || a.id === `${node?.object_id}:${id}`,
    );
  const attributeValue = (id: string, value: unknown) => {
    const field = fieldFor(id);
    if (value == null) return '未填写';
    if (['customer_id', 'project_id'].includes(id) && typeof value === 'string') {
      const expected = id === 'customer_id' ? 'customers' : 'projects';
      const matches =
        data?.nodes.filter(
          (n) => n.origin === 'crm' && n.object_id === expected && n.id === value,
        ) || [];
      return matches.length === 1 ? matches[0].name : '关联对象未在当前图谱显示';
    }
    if (id === 'value' && node?.origin === 'claim')
      return (
        describeKnowledgeNode(node, currentSchema?.objects, visible.nodes).rows.find(
          (row) => row.label === '提取值',
        )?.value || '请查看原文'
      );
    if (field?.type === 'currency') return `${textValue(value)} ${field.currency || ''}`.trim();
    if (field?.type === 'checkbox' && typeof value === 'boolean') return value ? '是' : '否';
    if (
      (field?.type === 'timestamp' || ['created_at', 'updated_at', 'archived_at'].includes(id)) &&
      typeof value === 'string' &&
      Number.isFinite(Date.parse(value))
    )
      return date(value);
    if (field?.type === 'select' && field.option_labels) {
      const labels = field.option_labels;
      return (Array.isArray(value) ? value : [value])
        .map((v) => labels[String(v)] || String(v))
        .join('、');
    }
    if (field?.type === 'record_reference')
      return (
        data?.nodes.find((n) => n.origin === 'crm' && n.id === value)?.name || textValue(value)
      );
    return textValue(value);
  };
  const hasGraph = data?.provenance === 'graphiti_persisted';
  const sourceContext = useMemo(
    () =>
      new Map(
        (data?.sources || []).map((source) => {
          const linkedNodes = data!.nodes.filter((n) => n.source_ids.includes(source.id));
          const linkedEdges = data!.edges.filter((e) => e.source_ids.includes(source.id));
          const names = [...new Set(linkedNodes.map((n) => n.name))];
          return [
            source.id,
            {
              search: `${names.join(' ')} ${linkedEdges.map((e) => `${e.label} ${e.fact}`).join(' ')}`,
              label: names.slice(0, 4).join('、') + (names.length > 4 ? '…' : ''),
            },
          ];
        }),
      ),
    [data],
  );
  const allSources = (data?.sources || []).filter((source) =>
    `${source.title} ${source.speaker} ${source.excerpt} ${sourceContext.get(source.id)?.search || ''}`
      .toLowerCase()
      .includes(sourceQuery.trim().toLowerCase()),
  );
  const focusOn = (key: string) => {
    setInitialFocusKey(key);
    setGraphMode('focus');
    selectGraphItem({ kind: 'node', key });
  };
  return (
    <section className="knowledge-graph-workspace" aria-label="客户知识图谱">
      <div className="graph-intro">
        <div>
          <h2>知识图谱</h2>
          <p>查看实体、属性与关系，沿着来源核对沟通中的变化。</p>
        </div>
        <span className="graph-state">
          {data
            ? isDemoRuntime() && data.state === 'ready'
              ? '示例图谱'
              : states[data.state]
            : customerId
              ? '正在读取'
              : '选择客户后查看'}
        </span>
      </div>
      <div className="graph-scope">
        <label className="graph-directory-search">
          <Search size={14} />
          <input
            aria-label="搜索图谱客户"
            placeholder="搜索客户…"
            value={customerQuery}
            onChange={(e) => {
              setCustomerQuery(e.target.value);
              setCustomerPage(1);
            }}
          />
        </label>
        <select
          aria-label="图谱客户"
          aria-busy={directoryLoading}
          disabled={directoryLoading}
          value={customerId}
          onChange={(e) => {
            setData(null);
            setCustomerId(e.target.value);
            setProjectId('');
            setSelected(null);
            setQuery('');
          }}
        >
          <option value="">{directoryLoading ? '正在搜索客户…' : '选择客户'}</option>
          {customerId && !customers.some((c) => c.id === customerId) && (
            <option value={customerId}>已选择的客户</option>
          )}
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {total > 30 && (
          <div className="graph-directory-pages">
            <button disabled={customerPage === 1} onClick={() => setCustomerPage((v) => v - 1)}>
              上一页
            </button>
            <small>
              {customerPage} / {Math.ceil(total / 30)}
            </small>
            <button
              disabled={customerPage * 30 >= total}
              onClick={() => setCustomerPage((v) => v + 1)}
            >
              下一页
            </button>
          </div>
        )}
        <select
          aria-label="图谱项目"
          value={projectId}
          disabled={!customerId}
          onChange={(e) => {
            setData(null);
            setProjectId(e.target.value);
          }}
        >
          <option value="">全部项目及客户资料</option>
          {(projectsScope === JSON.stringify([workspace, customerId]) ? projects : []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          aria-label="刷新知识图谱"
          disabled={!customerId}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </button>
        {data?.can_sync && !isDemoRuntime() && (
          <button disabled={busy || data.state === 'syncing'} onClick={() => void sync()}>
            {busy ? '正在提交…' : data.state === 'failed' ? '重试同步' : '同步最新资料'}
          </button>
        )}
      </div>
      <p className="graph-directory-status" role="status" aria-live="polite">
        {directoryLoading
          ? '正在搜索已授权的客户目录…'
          : directoryError
            ? '客户目录读取失败，请刷新后重试。'
            : customerQuery.trim()
              ? total > 0
                ? `找到 ${total} 位客户，请在“选择客户”中选择。`
                : '未找到匹配的客户。这里只搜索已建档客户；未关联的微信预览尚不进入知识图谱。'
              : '可按公司名、主要联系人或邮箱搜索，再选择客户查看图谱。'}
        {customerId && ' 搜索不会自动切换当前客户，选择其他客户后才会更新图谱。'}
      </p>
      {(error || directoryError || data?.error) && (
        <p className="error" role="alert">
          {error || directoryError || data?.error}
        </p>
      )}
      {!customerId ? (
        <div className="graph-empty">
          <Network size={34} />
          <h3>从一位客户开始</h3>
          <p>选择客户后，查看该客户已授权的档案与沟通知识。</p>
        </div>
      ) : !hasGraph ? (
        <div className="graph-empty">
          <Network size={34} />
          <h3>{data ? states[data.state] : error ? '暂时无法读取' : '正在读取图谱…'}</h3>
          <p>
            {data?.state === 'ready'
              ? '这份历史同步没有保存可视化节点，请同步最新资料。'
              : data?.state === 'disabled'
                ? 'Graphiti 文字知识运行器尚未启用。'
                : '资料与图谱须属于同一最新版本。同步完成后在此显示。'}
          </p>
        </div>
      ) : (
        <>
          <div className="graph-toolbar">
            <label>
              <Search size={14} />
              <input
                aria-label="搜索图谱节点和关系"
                placeholder="搜索名称、属性或关系…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(null);
                  setRecordId(null);
                }}
              />
            </label>
            <select
              aria-label="图谱分层"
              value={layer}
              onChange={(e) => {
                setLayer(e.target.value);
                setSelected(null);
                setRecordId(null);
              }}
            >
              <option value="all">全部图层</option>
              <option value="crm">正式档案</option>
              <option value="candidates">沟通候选</option>
            </select>
            <span>
              范围内 {visible.nodes.length} 个对象 · {visible.edges.length} 条关系
            </span>
          </div>
          <div className="graph-view-navigation">
            <div className="graph-view-modes" role="group" aria-label="图谱浏览方式">
              <button
                aria-pressed={graphMode === 'overview'}
                onClick={() => {
                  setGraphMode('overview');
                  setSelected(null);
                  setInspectorTab('all-sources');
                }}
              >
                <Network size={14} />
                全图总览
              </button>
              <button
                aria-pressed={graphMode === 'focus'}
                onClick={() => {
                  if (graphMode === 'focus') return;
                  setInitialFocusKey(selected?.kind === 'node' ? selected.key : null);
                  setGraphMode('focus');
                }}
              >
                <Focus size={14} />
                聚焦浏览
              </button>
            </div>
            <span className="graph-view-explanation">
              {graphMode === 'overview'
                ? '展示当前范围内全部已有对象和关系'
                : '只看当前对象的一圈关联，可随时返回全图'}
            </span>
            <button
              className="graph-all-sources"
              aria-pressed={inspectorTab === 'all-sources'}
              onClick={() => setInspectorTab('all-sources')}
            >
              <MessagesSquare size={14} />
              消息与笔记 {data.sources.length}
            </button>
          </div>
          <div className="graph-layout">
            {graphMode === 'overview' ? (
              <KnowledgeOverviewGraph
                key={JSON.stringify([graphScope, data.generation, layer, query])}
                nodes={visible.nodes}
                edges={visible.edges}
                selected={selected}
                onSelect={selectGraphItem}
                onFocus={focusOn}
              />
            ) : (
              <KnowledgeFocusGraph
                key={JSON.stringify([graphScope, data.generation, layer, query, initialFocusKey])}
                nodes={visible.nodes}
                edges={visible.edges}
                customerId={customerId}
                projectId={projectId}
                initialFocusKey={initialFocusKey}
                schema={currentSchema?.objects}
                selected={selected}
                onSelect={selectGraphItem}
              />
            )}
            <aside className="graph-inspector" aria-label="图谱属性与来源">
              <div className="graph-inspector-tabs" role="tablist" aria-label="图谱详情栏目">
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'details'}
                  onClick={() => setInspectorTab('details')}
                >
                  详情
                </button>
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'sources'}
                  onClick={() => setInspectorTab('sources')}
                >
                  来源 {sources.length || ''}
                </button>
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'all-sources'}
                  onClick={() => setInspectorTab('all-sources')}
                >
                  全部来源 {data.sources.length}
                </button>
              </div>
              {inspectorTab === 'all-sources' ? (
                <div className="graph-all-source-list">
                  <h3>消息与笔记</h3>
                  <p>当前客户及所选项目内的已保存来源。点开核对完整原文。</p>
                  <label className="graph-source-search">
                    <Search size={13} />
                    <input
                      aria-label="搜索图谱来源消息"
                      placeholder="搜索标题、提出者或关联图谱…"
                      value={sourceQuery}
                      onChange={(event) => setSourceQuery(event.target.value)}
                    />
                  </label>
                  <small className="graph-source-count">
                    {sourceQuery.trim()
                      ? `找到 ${allSources.length} 条来源 / 共 ${data.sources.length} 条`
                      : `共 ${data.sources.length} 条来源`}
                  </small>
                  {allSources.length ? (
                    allSources.map((source) => (
                      <button
                        className="graph-source"
                        key={source.id}
                        onClick={() => setRecordId(source.record_id)}
                      >
                        <strong>
                          {source.ref.note_id
                            ? '笔记'
                            : source.channel === 'email'
                              ? '邮件'
                              : source.channel === 'wechat'
                                ? '微信'
                                : '业务记录'}{' '}
                          · {source.speaker}
                        </strong>
                        <span>{source.title}</span>
                        {(source.excerpt || sourceContext.get(source.id)?.label) && (
                          <span className="graph-source-excerpt">
                            {source.excerpt || `关联信息：${sourceContext.get(source.id)?.label}`}
                          </span>
                        )}
                        <small>{date(source.occurred_at)}</small>
                      </button>
                    ))
                  ) : (
                    <p className="graph-note">
                      {sourceQuery.trim() ? '没有匹配的已保存来源。' : '当前范围没有可打开的来源。'}
                    </p>
                  )}
                </div>
              ) : node ? (
                <>
                  <span className={`graph-origin is-${node.origin}`}>{origins[node.origin]}</span>
                  <h3>{node.name}</h3>
                  <p>
                    {schemaObject?.name ||
                      (node.object_id
                        ? objectLabels[node.object_id] || '自定义实体'
                        : node.labels.filter((l) => l !== 'Entity').join(' · '))}
                  </p>
                  {inspectorTab === 'details' && (
                    <>
                      <h4>属性</h4>
                      <dl>
                        {displayAttributes.map(([id, value]) => (
                          <div key={id}>
                            <dt>
                              {fieldFor(id)?.name ||
                                (
                                  {
                                    id: '记录编号',
                                    name: '名称',
                                    customer_id: '所属公司',
                                    project_id: '关联项目',
                                    created_at: '创建时间',
                                    created_by: '创建人',
                                    updated_at: '更新时间',
                                    archived_at: '归档时间',
                                    version: '版本',
                                    canonical_id: '关联正式档案',
                                    candidate: '候选标记',
                                    value: '提取值',
                                    field_id: '对应字段',
                                    field_label: '字段名称',
                                    modality: '表达方式',
                                    speaker: '提出者',
                                    observed_at: '消息时间',
                                    effective_at: '生效时间',
                                    evidence: '原文定位',
                                    record_id: '来源记录',
                                    values: '自定义属性值',
                                  } as Record<string, string>
                                )[id] ||
                                id}
                            </dt>
                            <dd>{attributeValue(id, value)}</dd>
                          </div>
                        ))}
                      </dl>
                    </>
                  )}
                </>
              ) : edge ? (
                <>
                  <span className="graph-origin">{kinds[edge.kind]}</span>
                  <h3>{edge.label}</h3>
                  {inspectorTab === 'details' && (
                    <>
                      <p>
                        {edge.kind === 'crm_relationship'
                          ? '来自当前档案中的明确关联。'
                          : edge.fact}
                      </p>
                      <dl>
                        <div>
                          <dt>起点</dt>
                          <dd>{data.nodes.find((n) => n.key === edge.source)?.name}</dd>
                        </div>
                        <div>
                          <dt>终点</dt>
                          <dd>{data.nodes.find((n) => n.key === edge.target)?.name}</dd>
                        </div>
                        <div>
                          <dt>生效时间</dt>
                          <dd>{edge.valid_at ? date(edge.valid_at) : '待核对'}</dd>
                        </div>
                        <div>
                          <dt>失效时间</dt>
                          <dd>{edge.invalid_at ? date(edge.invalid_at) : '未自动失效'}</dd>
                        </div>
                      </dl>
                    </>
                  )}
                </>
              ) : (
                <div className="graph-inspector-empty">
                  <Network size={24} />
                  <h3>点选节点或连线</h3>
                  <p>在这里查看实体属性、关系含义、时间和原始依据。</p>
                </div>
              )}
              {(node || edge) && inspectorTab === 'sources' && (
                <>
                  <h4>来源与依据</h4>
                  {sources.length ? (
                    sources.map((s) => (
                      <button
                        className="graph-source"
                        key={s.id}
                        onClick={() => setRecordId(s.record_id)}
                      >
                        <strong>
                          {s.channel === 'email'
                            ? '邮件'
                            : s.channel === 'wechat'
                              ? '微信'
                              : '业务记录'}{' '}
                          · {s.speaker}
                        </strong>
                        <span>{s.title}</span>
                        <small>{date(s.occurred_at)}</small>
                      </button>
                    ))
                  ) : (
                    <p className="graph-note">
                      {node?.origin === 'crm' || edge?.kind === 'crm_relationship'
                        ? '来自当前 CRM 正式档案或人工维护关系。'
                        : '当前没有可打开的沟通依据。'}
                    </p>
                  )}
                </>
              )}
            </aside>
          </div>
          <div className="graph-footer">
            <span>
              {isDemoRuntime()
                ? '基于示例资料准备的知识关系 · 非实时索引运行'
                : 'Graphiti 已保存节点与关系的真实回读'}{' '}
              · {data.synced_at && date(data.synced_at)}
            </span>
            <span>候选与原文共用 Record 来源，需核对后更新正式档案。</span>
          </div>
        </>
      )}
      {recordId && customerId && data && (
        <RecordEvidence
          key={`${workspace}:${customerId}:${projectId}:${recordId}`}
          workspace={workspace}
          customerId={customerId}
          recordId={recordId}
          onClose={() => setRecordId(null)}
        />
      )}
    </section>
  );
}
