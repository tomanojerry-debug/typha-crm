import { useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Focus, ZoomIn, ZoomOut } from 'lucide-react';
import type { KnowledgeGraphEdge, KnowledgeGraphNode } from '../shared/knowledge';
import type { GraphSelection } from './KnowledgeFocusGraph';
import { buildGraphEdgeGeometry } from './knowledge-graph-geometry';
import { knowledgeOverviewLayout } from './knowledge-overview-layout';
import { useGraphWheelZoom } from './useGraphWheelZoom';
import './knowledge-overview.css';

const origins = { crm: '正式档案', candidate: '识别实体', claim: '信息主张' };

export function KnowledgeOverviewGraph({
  nodes,
  edges,
  selected,
  onSelect,
  onFocus,
}: {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  selected: GraphSelection;
  onSelect: (selection: GraphSelection) => void;
  onFocus: (nodeKey: string) => void;
}) {
  const [camera, setCamera] = useState({ scale: 1, x: 0, y: 0 });
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const arrowId = `overview-arrow-${useId().replace(/:/g, '')}`;
  const layout = useMemo(() => knowledgeOverviewLayout(nodes, edges), [nodes, edges]);
  useGraphWheelZoom(svg, setCamera, {
    enabled: nodes.length > 0,
    min: 0.6,
    max: 4,
    worldWidth: layout.box.width,
    worldHeight: layout.box.height,
  });
  const geometry = useMemo(
    () => buildGraphEdgeGeometry(nodes, edges, layout.points),
    [nodes, edges, layout],
  );
  const selectedNode =
    selected?.kind === 'node' ? nodes.find((node) => node.key === selected.key) : undefined;
  const highlighted = useMemo(() => {
    const nodeKeys = new Set<string>();
    const edgeKeys = new Set<string>();
    if (selected?.kind === 'node' && nodes.some((node) => node.key === selected.key)) {
      nodeKeys.add(selected.key);
      for (const edge of edges) {
        if (edge.source === selected.key || edge.target === selected.key) {
          edgeKeys.add(edge.key);
          nodeKeys.add(edge.source);
          nodeKeys.add(edge.target);
        }
      }
    } else if (selected?.kind === 'edge') {
      const edge = edges.find((item) => item.key === selected.key);
      if (edge) {
        edgeKeys.add(edge.key);
        nodeKeys.add(edge.source);
        nodeKeys.add(edge.target);
      }
    }
    return { nodes: nodeKeys, edges: edgeKeys, active: nodeKeys.size > 0 };
  }, [nodes, edges, selected]);

  function startPan(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || (event.target as Element).closest('[data-graph-item]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, left: camera.x, top: camera.y };
  }
  function pan(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current || !svg.current) return;
    const rect = svg.current.getBoundingClientRect();
    const fit = Math.min(rect.width / layout.box.width, rect.height / layout.box.height);
    if (!fit) return;
    setCamera((value) => ({
      ...value,
      x: drag.current!.left + (event.clientX - drag.current!.x) / fit,
      y: drag.current!.top + (event.clientY - drag.current!.y) / fit,
    }));
  }
  function zoom(factor: number) {
    setCamera((value) => ({
      ...value,
      scale: Math.min(4, Math.max(0.6, value.scale * factor)),
    }));
  }

  return (
    <div className="knowledge-overview-browser">
      <div className="overview-topline">
        <span>
          全图显示 {nodes.length} 个对象 · {edges.length} 条关系
        </span>
        <button
          disabled={!selectedNode}
          aria-label="聚焦所选对象"
          onClick={() => selectedNode && onFocus(selectedNode.key)}
        >
          <Focus size={13} />
          聚焦所选对象
        </button>
      </div>
      <div className="graph-canvas-shell overview-canvas-shell">
        <div className="graph-legend">
          <span className="crm">正式档案</span>
          <span className="candidate">识别实体</span>
          <span className="claim">信息主张</span>
          <small>虚线为候选 · 点选查看详情与来源</small>
        </div>
        {nodes.length ? (
          <svg
            ref={svg}
            className="graph-canvas overview-canvas"
            viewBox={`${layout.box.x} ${layout.box.y} ${layout.box.width} ${layout.box.height}`}
            aria-label="全图总览，所有对象与关系可点选"
            onPointerDown={startPan}
            onPointerMove={pan}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <defs>
              <marker
                id={arrowId}
                markerWidth="7"
                markerHeight="7"
                refX="5.5"
                refY="3.5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path
                  d="M1 1L5.5 3.5L1 6"
                  fill="none"
                  stroke="context-stroke"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </marker>
            </defs>
            <g
              className="overview-world"
              transform={`translate(${camera.x} ${camera.y}) translate(${layout.center.x} ${layout.center.y}) scale(${camera.scale}) translate(${-layout.center.x} ${-layout.center.y})`}
            >
              {edges.map((edge) => {
                const curve = geometry.get(edge.key);
                if (!curve) return null;
                return (
                  <g
                    key={edge.key}
                    data-graph-item="edge"
                    data-edge-key={edge.key}
                    className={`graph-edge ${edge.kind === 'crm_relationship' ? 'is-crm' : ''} ${selected?.kind === 'edge' && selected.key === edge.key ? 'is-selected' : ''} ${highlighted.edges.has(edge.key) ? 'is-connected' : highlighted.active ? 'is-muted' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`关系：${edge.label}`}
                    onClick={() => onSelect({ kind: 'edge', key: edge.key })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect({ kind: 'edge', key: edge.key });
                      }
                    }}
                  >
                    <title>
                      {nodes.find((node) => node.key === edge.source)?.name} → {edge.label} →{' '}
                      {nodes.find((node) => node.key === edge.target)?.name}
                    </title>
                    <path className="graph-edge-hit" d={curve.d} />
                    <path className="graph-edge-line" markerEnd={`url(#${arrowId})`} d={curve.d} />
                    <text x={curve.label.x} y={curve.label.y - 8}>
                      {edge.label.length > 16 ? `${edge.label.slice(0, 16)}…` : edge.label}
                    </text>
                  </g>
                );
              })}
              {nodes.map((node) => {
                const point = layout.points.get(node.key)!;
                return (
                  <g
                    key={node.key}
                    data-graph-item="node"
                    data-node-key={node.key}
                    className={`graph-node is-${node.origin} ${selected?.kind === 'node' && selected.key === node.key ? 'is-selected' : ''} ${highlighted.nodes.has(node.key) ? 'is-connected' : highlighted.active ? 'is-muted' : ''}`}
                    transform={`translate(${point.x} ${point.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${origins[node.origin]}：${node.name}`}
                    onClick={() => onSelect({ kind: 'node', key: node.key })}
                    onDoubleClick={() => onFocus(node.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect({ kind: 'node', key: node.key });
                      }
                    }}
                  >
                    <title>
                      {node.name} · {origins[node.origin]}
                    </title>
                    <circle r={node.origin === 'claim' ? 16 : 23} />
                    <text className="graph-node-symbol" y="4">
                      {node.origin === 'claim' ? '◇' : node.origin === 'crm' ? '▦' : '○'}
                    </text>
                    <text y={node.origin === 'claim' ? 34 : 42}>
                      {node.name.length > 17 ? `${node.name.slice(0, 17)}…` : node.name}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        ) : (
          <div className="graph-empty">
            <p>当前范围没有匹配的对象。</p>
          </div>
        )}
        {nodes.length > 0 && (
          <div className="graph-zoom overview-zoom">
            <button aria-label="缩小图谱" onClick={() => zoom(1 / 1.2)}>
              <ZoomOut size={15} />
            </button>
            <span>{Math.round(camera.scale * 100)}%</span>
            <button aria-label="放大图谱" onClick={() => zoom(1.2)}>
              <ZoomIn size={15} />
            </button>
            <button aria-label="重置图谱视野" onClick={() => setCamera({ scale: 1, x: 0, y: 0 })}>
              <Focus size={15} />
            </button>
          </div>
        )}
      </div>
      <div className="overview-bottomline">
        <span>滚轮缩放 · 拖动平移 · 点选查看详情，双击对象进入聚焦浏览</span>
        {highlighted.active && <button onClick={() => onSelect(null)}>取消高亮，查看全图</button>}
      </div>
    </div>
  );
}
