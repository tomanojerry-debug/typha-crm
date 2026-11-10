import type { KnowledgeGraphEdge, KnowledgeGraphNode } from '../shared/knowledge';
import type { GraphEdgeGeometry, GraphPoint } from './knowledge-graph-geometry';

export const KNOWLEDGE_FOCUS_PAGE_SIZE = 6;

export interface KnowledgeFocusView {
  focus: KnowledgeGraphNode;
  neighbors: KnowledgeGraphNode[];
  nodes: KnowledgeGraphNode[];
  /** Only supplied relationships incident to the focus are shown. */
  edges: KnowledgeGraphEdge[];
  totalNeighbors: number;
  totalRelations: number;
  page: number;
  pageSize: number;
  pageCount: number;
  start: number;
  end: number;
}

export interface FocusCardPosition extends GraphPoint {
  /** x/y are the center of the rectangle. */
  width: number;
  height: number;
}

/** Match a selected CRM identity without merging its evidence partitions. */
export function defaultKnowledgeFocus(
  nodes: readonly KnowledgeGraphNode[],
  scope: { customerId: string; projectId?: string | null },
): string | null {
  return (
    (scope.projectId
      ? nodes.find(
          (node) =>
            node.origin === 'crm' && node.object_id === 'projects' && node.id === scope.projectId,
        )?.key
      : undefined) ??
    nodes.find(
      (node) =>
        node.origin === 'crm' && node.object_id === 'customers' && node.id === scope.customerId,
    )?.key ??
    nodes[0]?.key ??
    null
  );
}

export function buildKnowledgeFocusView(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
  focusKey: string | null,
  requestedPage = 1,
  requestedPageSize = KNOWLEDGE_FOCUS_PAGE_SIZE,
): KnowledgeFocusView | null {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const focus = focusKey == null ? undefined : byKey.get(focusKey);
  if (!focus) return null;
  const incident = edges.filter(
    (edge) =>
      (edge.source === focus.key || edge.target === focus.key) &&
      byKey.has(edge.source) &&
      byKey.has(edge.target),
  );
  const neighborKeys = new Set<string>();
  for (const edge of incident) {
    if (edge.source !== focus.key) neighborKeys.add(edge.source);
    if (edge.target !== focus.key) neighborKeys.add(edge.target);
  }
  // Preserve the authorized API's node order, independently of edge order.
  const uniqueKeys = new Set<string>();
  const allNeighbors = nodes.filter((node) => {
    if (!neighborKeys.has(node.key) || uniqueKeys.has(node.key)) return false;
    uniqueKeys.add(node.key);
    return true;
  });
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.max(1, Math.min(KNOWLEDGE_FOCUS_PAGE_SIZE, Math.trunc(requestedPageSize)))
    : KNOWLEDGE_FOCUS_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(allNeighbors.length / pageSize));
  const page = Number.isFinite(requestedPage)
    ? Math.max(1, Math.min(pageCount, Math.trunc(requestedPage)))
    : 1;
  const offset = (page - 1) * pageSize;
  const neighbors = allNeighbors.slice(offset, offset + pageSize);
  const visibleKeys = new Set([focus.key, ...neighbors.map((node) => node.key)]);
  return {
    focus,
    neighbors,
    nodes: [focus, ...neighbors],
    edges: incident.filter((edge) => visibleKeys.has(edge.source) && visibleKeys.has(edge.target)),
    totalNeighbors: allNeighbors.length,
    totalRelations: incident.length,
    page,
    pageSize,
    pageCount,
    start: neighbors.length ? offset + 1 : 0,
    end: offset + neighbors.length,
  };
}

/** A missing step invalidates the remainder; hidden titles must not survive. */
export function normalizeFocusTrail(
  trail: readonly string[],
  nodes: readonly KnowledgeGraphNode[],
): string[] {
  const allowed = new Set(nodes.map((node) => node.key));
  const result: string[] = [];
  for (const key of trail) {
    if (!allowed.has(key)) break;
    const existing = result.indexOf(key);
    if (existing >= 0) result.splice(existing + 1);
    else result.push(key);
  }
  return result;
}

export function moveKnowledgeFocus(
  trail: readonly string[],
  nextKey: string,
  nodes: readonly KnowledgeGraphNode[],
): string[] {
  const current = normalizeFocusTrail(trail, nodes);
  if (!nodes.some((node) => node.key === nextKey)) return current;
  const existing = current.indexOf(nextKey);
  return existing >= 0 ? current.slice(0, existing + 1) : [...current, nextKey];
}

export function truncateFocusTrail(
  trail: readonly string[],
  index: number,
  nodes: readonly KnowledgeGraphNode[],
): string[] {
  const current = normalizeFocusTrail(trail, nodes);
  if (!Number.isFinite(index)) return current;
  return current.slice(0, Math.max(0, Math.trunc(index) + 1));
}

export function knowledgeFocusLayout(
  focus: KnowledgeGraphNode,
  neighbors: readonly KnowledgeGraphNode[],
): {
  positions: Map<string, FocusCardPosition>;
  box: { x: number; y: number; width: number; height: number };
} {
  const upperLeft = { x: 175, y: 150 },
    top = { x: 550, y: 100 },
    upperRight = { x: 925, y: 150 },
    lowerRight = { x: 925, y: 570 },
    bottom = { x: 550, y: 620 },
    lowerLeft = { x: 175, y: 570 };
  const arrangements: GraphPoint[][] = [
    [],
    [{ x: 925, y: 360 }],
    [
      { x: 175, y: 360 },
      { x: 925, y: 360 },
    ],
    [upperLeft, upperRight, bottom],
    [upperLeft, upperRight, lowerRight, lowerLeft],
    [upperLeft, top, upperRight, lowerRight, lowerLeft],
    [upperLeft, top, upperRight, lowerRight, bottom, lowerLeft],
  ];
  const shown = neighbors.slice(0, KNOWLEDGE_FOCUS_PAGE_SIZE);
  const positions = new Map<string, FocusCardPosition>([
    [focus.key, { x: 550, y: 360, width: 240, height: 132 }],
  ]);
  shown.forEach((node, index) => {
    if (node.key !== focus.key)
      positions.set(node.key, { ...arrangements[shown.length][index], width: 220, height: 118 });
  });
  return { positions, box: { x: 0, y: 0, width: 1100, height: 720 } };
}

const coordinate = (point: GraphPoint) =>
  `${Math.round(point.x * 1000) / 1000} ${Math.round(point.y * 1000) / 1000}`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const validCard = (card: FocusCardPosition | undefined): card is FocusCardPosition =>
  !!card &&
  [card.x, card.y, card.width, card.height].every(Number.isFinite) &&
  card.width > 0 &&
  card.height > 0;

function curve(
  start: GraphPoint,
  control1: GraphPoint,
  control2: GraphPoint,
  end: GraphPoint,
  lane: number,
): GraphEdgeGeometry {
  return {
    start,
    control1,
    control2,
    end,
    lane,
    d: `M ${coordinate(start)} C ${coordinate(control1)}, ${coordinate(control2)}, ${coordinate(end)}`,
    label: {
      x: (start.x + 3 * control1.x + 3 * control2.x + end.x) / 8,
      y: (start.y + 3 * control1.y + 3 * control2.y + end.y) / 8,
    },
  };
}

/** Card boundary ports, retaining each supplied edge and its original direction. */
export function buildFocusEdgeGeometry(
  edges: readonly KnowledgeGraphEdge[],
  positions: ReadonlyMap<string, FocusCardPosition>,
): Map<string, GraphEdgeGeometry> {
  const pairs = new Map<string, KnowledgeGraphEdge[]>();
  for (const edge of edges) {
    if (!validCard(positions.get(edge.source)) || !validCard(positions.get(edge.target))) continue;
    const key = JSON.stringify([edge.source, edge.target].sort());
    const group = pairs.get(key) || [];
    group.push(edge);
    pairs.set(key, group);
  }
  const result = new Map<string, GraphEdgeGeometry>();
  for (const pair of pairs.values()) {
    pair.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const [firstKey, secondKey] = [pair[0].source, pair[0].target].sort();
    const a = positions.get(firstKey)!,
      b = positions.get(secondKey)!;
    pair.forEach((edge, index) => {
      const lane = index - (pair.length - 1) / 2;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      let start: GraphPoint, end: GraphPoint, control1: GraphPoint, control2: GraphPoint;
      if (firstKey === secondKey || Math.hypot(dx, dy) < 0.001) {
        const reach = 80 + index * 24;
        start = { x: a.x + a.width / 2 + 3, y: a.y - a.height * 0.22 };
        end = { x: b.x + b.width / 2 + 3, y: b.y + b.height * 0.22 };
        control1 = { x: start.x + reach, y: start.y - 55 };
        control2 = { x: end.x + reach, y: end.y + 55 };
      } else if (Math.abs(dx) >= Math.abs(dy) * 0.6) {
        const direction = dx < 0 ? -1 : 1;
        const offset = lane * 18;
        const aOffset = clamp(
          offset,
          -Math.max(0, a.height / 2 - 12),
          Math.max(0, a.height / 2 - 12),
        );
        const bOffset = clamp(
          offset,
          -Math.max(0, b.height / 2 - 12),
          Math.max(0, b.height / 2 - 12),
        );
        start = { x: a.x + direction * (a.width / 2 + 3), y: a.y + aOffset };
        end = { x: b.x - direction * (b.width / 2 + 3), y: b.y + bOffset };
        const bend = clamp(Math.abs(end.x - start.x) * 0.5, 42, 160);
        control1 = { x: start.x + direction * bend, y: start.y + offset - aOffset };
        control2 = { x: end.x - direction * bend, y: end.y + offset - bOffset };
      } else {
        const direction = dy < 0 ? -1 : 1;
        const offset = lane * 18;
        const aOffset = clamp(
          offset,
          -Math.max(0, a.width / 2 - 12),
          Math.max(0, a.width / 2 - 12),
        );
        const bOffset = clamp(
          offset,
          -Math.max(0, b.width / 2 - 12),
          Math.max(0, b.width / 2 - 12),
        );
        start = { x: a.x + aOffset, y: a.y + direction * (a.height / 2 + 3) };
        end = { x: b.x + bOffset, y: b.y - direction * (b.height / 2 + 3) };
        const bend = clamp(Math.abs(end.y - start.y) * 0.5, 42, 160);
        control1 = { x: start.x + offset - aOffset, y: start.y + direction * bend };
        control2 = { x: end.x + offset - bOffset, y: end.y - direction * bend };
      }
      result.set(
        edge.key,
        edge.source === firstKey
          ? curve(start, control1, control2, end, lane)
          : curve(end, control2, control1, start, lane),
      );
    });
  }
  return result;
}
