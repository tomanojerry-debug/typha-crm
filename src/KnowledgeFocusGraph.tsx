import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Focus,
  FolderClosed,
  Network,
  Quote,
  UserRound,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { KnowledgeGraphEdge, KnowledgeGraphNode } from '../shared/knowledge';
import {
  buildFocusEdgeGeometry,
  buildKnowledgeFocusView,
  defaultKnowledgeFocus,
  knowledgeFocusLayout,
  moveKnowledgeFocus,
  normalizeFocusTrail,
  truncateFocusTrail,
} from './knowledge-focus-model';
import { describeKnowledgeNode, type KnowledgeCardSchemaObject } from './knowledge-node-card';
import { useGraphWheelZoom } from './useGraphWheelZoom';

export type GraphSelection = { kind: 'node' | 'edge'; key: string } | null;
const origins = { crm: '正式档案', candidate: '识别实体', claim: '信息主张' };

export function KnowledgeFocusGraph({
  nodes,
  edges,
  customerId,
  projectId,
  initialFocusKey,
  schema,
  selected,
  onSelect,
}: {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  customerId: string;
  projectId: string;
  initialFocusKey?: string | null;
  schema?: KnowledgeCardSchemaObject[];
  selected: GraphSelection;
  onSelect: (selection: GraphSelection) => void;
}) {
  const [trail, setTrail] = useState<string[]>(() => {
    const key = nodes.some((n) => n.key === initialFocusKey)
      ? initialFocusKey
      : defaultKnowledgeFocus(nodes, { customerId, projectId });
    return key ? [key] : [];
  });
  const [page, setPage] = useState(1);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ width: 1100, height: 660 });
  const shell = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const arrowId = `focus-arrow-${useId().replace(/:/g, '')}`;
  const currentTrail = normalizeFocusTrail(trail, nodes);
  const focusKey = currentTrail.at(-1) ?? defaultKnowledgeFocus(nodes, { customerId, projectId });
  const viewKey = JSON.stringify([focusKey, page]);
  const [settledView, setSettledView] = useState(viewKey);
  const view = useMemo(
    () => buildKnowledgeFocusView(nodes, edges, focusKey, page),
    [nodes, edges, focusKey, page],
  );
  const layout = useMemo(
    () => (view ? knowledgeFocusLayout(view.focus, view.neighbors) : null),
    [view],
  );
  const geometry = useMemo(
    () => (layout && view ? buildFocusEdgeGeometry(view.edges, layout.positions) : new Map()),
    [layout, view],
  );
  const parallelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of view?.edges || []) {
      const key = JSON.stringify([edge.source, edge.target].sort());
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [view]);
  const descriptions = useMemo(
    () => new Map(nodes.map((n) => [n.key, describeKnowledgeNode(n, schema, nodes)])),
    [nodes, schema],
  );
  const compact = size.width < 620;
  useGraphWheelZoom(shell, setCamera, {
    enabled: !compact && !!view,
    min: 0.6,
    max: 2.2,
  });
  const fit = Math.min(size.width / 1100, size.height / 720);
  const activeEdge =
    selected?.kind === 'edge' ? view?.edges.find((e) => e.key === selected.key) : undefined;

  useEffect(() => {
    if (settledView === viewKey) return;
    const timer = setTimeout(() => setSettledView(viewKey), 360);
    return () => clearTimeout(timer);
  }, [viewKey, settledView]);

  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: 660 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!view) {
      onSelect(null);
      return;
    }
    const valid =
      selected?.kind === 'node'
        ? view.nodes.some((n) => n.key === selected.key)
        : selected?.kind === 'edge' && view.edges.some((e) => e.key === selected.key);
    if (!valid) onSelect({ kind: 'node', key: view.focus.key });
  }, [view, selected, onSelect]);

  function focus(key: string, fresh = false) {
    if (!nodes.some((n) => n.key === key)) return;
    setTrail((previous) => (fresh ? [key] : moveKnowledgeFocus(previous, key, nodes)));
    setPage(1);
    setCamera({ x: 0, y: 0, scale: 1 });
    onSelect({ kind: 'node', key });
  }
  function returnTo(index: number) {
    const next = truncateFocusTrail(currentTrail, index, nodes);
    const key = next.at(-1);
    if (!key) return;
    setTrail(next);
    setPage(1);
    setCamera({ x: 0, y: 0, scale: 1 });
    onSelect({ kind: 'node', key });
  }
  function changePage(next: number) {
    if (!view) return;
    setPage(next);
    setCamera({ x: 0, y: 0, scale: 1 });
    onSelect({ kind: 'node', key: view.focus.key });
  }
  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (
      compact ||
      event.button !== 0 ||
      (event.target as Element).closest('button,select,[data-graph-item]')
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, left: camera.x, top: camera.y };
  }
  function pan(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    setCamera((value) => ({
      ...value,
      x: drag.current!.left + event.clientX - drag.current!.x,
      y: drag.current!.top + event.clientY - drag.current!.y,
    }));
  }
  function zoom(factor: number) {
    setCamera((value) => ({ ...value, scale: Math.min(2.2, Math.max(0.6, value.scale * factor)) }));
  }

  function card(node: KnowledgeGraphNode) {
    if (!view || !layout) return null;
    const description = descriptions.get(node.key)!;
    const position = layout.positions.get(node.key)!;
    const isFocus = node.key === view.focus.key;
    const isSelected = selected?.kind === 'node' && selected.key === node.key;
    const related = !activeEdge || activeEdge.source === node.key || activeEdge.target === node.key;
    const Icon =
      description.kind === 'company'
        ? Building2
        : description.kind === 'person'
          ? UserRound
          : description.kind === 'project'
            ? FolderClosed
            : description.kind === 'claim'
              ? Quote
              : CircleDot;
    const relationships = view.edges.filter((e) =>
      isFocus
        ? e.source === node.key && e.target === node.key
        : e.source === node.key || e.target === node.key,
    );
    return (
      <article
        key={node.key}
        data-graph-item="node"
        data-node-key={node.key}
        className={`knowledge-focus-card is-${node.origin} ${isFocus ? 'is-focus' : ''} ${isSelected ? 'is-selected' : ''} ${related ? '' : 'is-muted'}`}
        style={
          compact
            ? undefined
            : {
                left: position.x - position.width / 2,
                top: position.y - position.height / 2,
                width: position.width,
                height: position.height,
              }
        }
      >
        {compact && relationships.length > 0 && (
          <div className="focus-compact-relation">
            {relationships.map((edge) => (
              <button
                key={edge.key}
                aria-label={`关系：${edge.label}`}
                aria-pressed={selected?.kind === 'edge' && selected.key === edge.key}
                title={`${nodes.find((n) => n.key === edge.source)?.name} → ${edge.label} → ${nodes.find((n) => n.key === edge.target)?.name}`}
                onClick={() => onSelect({ kind: 'edge', key: edge.key })}
              >
                {edge.source === edge.target
                  ? '自身 · '
                  : edge.source === view.focus.key
                    ? '→ '
                    : '← '}
                {edge.label}
              </button>
            ))}
          </div>
        )}
        <button
          className="focus-card-body"
          aria-label={`${origins[node.origin]}：${node.name}`}
          aria-pressed={isSelected}
          onClick={() => onSelect({ kind: 'node', key: node.key })}
          onDoubleClick={() => focus(node.key)}
        >
          <div className="focus-card-heading">
            <span className="focus-card-icon">
              <Icon size={21} />
            </span>
            <span className="focus-card-title" title={node.name}>
              {node.name}
            </span>
          </div>
          <div className="focus-card-rows">
            {description.rows.length ? (
              description.rows.map((row) => (
                <div key={row.label}>
                  <span>{row.label}</span>
                  <strong title={row.value}>{row.value}</strong>
                </div>
              ))
            ) : (
              <span className="focus-card-type">{description.typeLabel}</span>
            )}
          </div>
        </button>
        <div className="focus-card-footer">
          <span className={`focus-origin is-${node.origin}`}>
            {isFocus ? `焦点 · ${origins[node.origin]}` : origins[node.origin]}
          </span>
          {isFocus ? (
            <small>{view.totalNeighbors} 个关联</small>
          ) : (
            <button aria-label={`以${node.name}为中心`} onClick={() => focus(node.key)}>
              <Focus size={12} />
              以此为中心
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <div className="knowledge-focus-browser">
      <div className="focus-navigation">
        <button
          className="focus-back"
          aria-label="返回上一个图谱焦点"
          disabled={currentTrail.length < 2}
          onClick={() => returnTo(currentTrail.length - 2)}
        >
          <ArrowLeft size={15} />
        </button>
        <nav aria-label="图谱浏览足迹">
          {(currentTrail.length ? currentTrail : focusKey ? [focusKey] : []).map((key, index) => (
            <span key={key}>
              {index > 0 && <ChevronRight size={12} />}
              <button
                aria-current={key === focusKey ? 'location' : undefined}
                onClick={() => returnTo(index)}
                title={nodes.find((n) => n.key === key)?.name}
              >
                {nodes.find((n) => n.key === key)?.name}
              </button>
            </span>
          ))}
        </nav>
        <select
          aria-label="定位图谱对象"
          value={focusKey || ''}
          onChange={(event) => focus(event.target.value, true)}
        >
          {!nodes.length && <option value="">没有匹配的对象</option>}
          {(['crm', 'candidate', 'claim'] as const).map((origin) => (
            <optgroup key={origin} label={origins[origin]}>
              {nodes
                .filter((n) => n.origin === origin)
                .map((n) => (
                  <option key={n.key} value={n.key}>
                    {origins[origin]} · {n.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="focus-caption" role="status" aria-live="polite">
        <span>
          <Network size={13} />
          {view
            ? `当前焦点：${view.totalNeighbors} 个直接关联 · ${view.totalRelations} 条关系`
            : '当前范围没有匹配的对象'}
        </span>
        {view && view.pageCount > 1 && (
          <span>
            显示 {view.start}–{view.end} / {view.totalNeighbors}
          </span>
        )}
      </div>
      <div
        ref={shell}
        className={`focus-stage ${compact ? 'is-compact' : ''}`}
        aria-label="聚焦关系图"
        onPointerDown={startPan}
        onPointerMove={pan}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        {view && layout ? (
          compact ? (
            <div className="focus-compact-layout">
              <div className="focus-compact-center">{card(view.focus)}</div>
              <div className="focus-compact-label">
                直接关联 <ArrowRight size={12} />
              </div>
              <div className="focus-compact-neighbors">{view.neighbors.map(card)}</div>
            </div>
          ) : (
            <div
              className="focus-world"
              style={{
                width: 1100,
                height: 720,
                transform: `translate(${(size.width - 1100 * fit * camera.scale) / 2 + camera.x}px, ${(size.height - 720 * fit * camera.scale) / 2 + camera.y}px) scale(${fit * camera.scale})`,
              }}
            >
              <svg
                className={`focus-connections ${settledView !== viewKey ? 'is-transitioning' : ''}`}
                viewBox="0 0 1100 720"
                aria-label="实体关系连线"
              >
                <defs>
                  <marker
                    id={arrowId}
                    markerWidth="8"
                    markerHeight="8"
                    refX="6"
                    refY="4"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path
                      d="M1 1L6 4L1 7"
                      fill="none"
                      stroke="context-stroke"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </marker>
                </defs>
                {view.edges.map((edge) => {
                  const path = geometry.get(edge.key);
                  if (!path) return null;
                  const isSelected = selected?.kind === 'edge' && selected.key === edge.key;
                  return (
                    <g
                      key={edge.key}
                      role="button"
                      tabIndex={0}
                      data-graph-item="edge"
                      className={`focus-edge ${edge.kind === 'crm_relationship' ? 'is-crm' : ''} ${(parallelCounts.get(JSON.stringify([edge.source, edge.target].sort())) || 0) > 1 ? 'is-parallel' : ''} ${isSelected ? 'is-selected' : ''} ${activeEdge && !isSelected ? 'is-muted' : ''}`}
                      aria-label={`关系：${edge.label}`}
                      onClick={() => onSelect({ kind: 'edge', key: edge.key })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect({ kind: 'edge', key: edge.key });
                        }
                      }}
                    >
                      <title>{`${nodes.find((n) => n.key === edge.source)?.name} → ${edge.label} → ${nodes.find((n) => n.key === edge.target)?.name}`}</title>
                      <path className="focus-edge-hit" d={path.d} />
                      <path className="focus-edge-line" d={path.d} markerEnd={`url(#${arrowId})`} />
                      <text x={path.label.x} y={path.label.y - 9}>
                        {edge.label.length > 15 ? `${edge.label.slice(0, 15)}…` : edge.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
              {view.nodes.map(card)}
            </div>
          )
        ) : (
          <div className="graph-empty">
            <Network size={28} />
            <p>当前范围没有匹配的节点。</p>
          </div>
        )}
        {!compact && view && (
          <div className="focus-zoom">
            <button aria-label="缩小图谱" onClick={() => zoom(1 / 1.2)}>
              <ZoomOut size={15} />
            </button>
            <span>{Math.round(camera.scale * 100)}%</span>
            <button aria-label="放大图谱" onClick={() => zoom(1.2)}>
              <ZoomIn size={15} />
            </button>
            <button aria-label="重置图谱视野" onClick={() => setCamera({ x: 0, y: 0, scale: 1 })}>
              <Focus size={15} />
            </button>
          </div>
        )}
      </div>
      {view && (
        <div className="focus-bottom-bar">
          <span>
            {!compact && '滚轮缩放 · 拖动平移 · '}
            点选卡片查看详情，选择“以此为中心”继续浏览
          </span>
          {view.pageCount > 1 && (
            <div className="focus-pages">
              <button
                aria-label="上一组关联"
                disabled={view.page <= 1}
                onClick={() => changePage(view.page - 1)}
              >
                <ChevronLeft size={14} />
              </button>
              <span>
                {view.page} / {view.pageCount}
              </span>
              <button
                aria-label="下一组关联"
                disabled={view.page >= view.pageCount}
                onClick={() => changePage(view.page + 1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          {!view.totalNeighbors && <span>没有直接关联，可从“定位图谱对象”切换</span>}
        </div>
      )}
    </div>
  );
}
