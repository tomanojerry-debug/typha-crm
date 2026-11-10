import type { KnowledgeGraphEdge, KnowledgeGraphNode } from '../shared/knowledge';

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphEdgeGeometry {
  /** Reuse this exact path for the visible stroke and its larger hit target. */
  d: string;
  start: GraphPoint;
  end: GraphPoint;
  control1: GraphPoint;
  control2: GraphPoint;
  label: GraphPoint;
  lane: number;
}

const clearance = 3;
const radius = (node: KnowledgeGraphNode) => (node.origin === 'claim' ? 16 : 23) + clearance;
const finite = (point: GraphPoint | undefined): point is GraphPoint =>
  !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
const number = (value: number) => Math.round(value * 1000) / 1000;
const coordinate = (point: GraphPoint) => `${number(point.x)} ${number(point.y)}`;

function geometry(
  start: GraphPoint,
  control1: GraphPoint,
  control2: GraphPoint,
  end: GraphPoint,
  lane: number,
): GraphEdgeGeometry {
  return {
    d: `M ${coordinate(start)} C ${coordinate(control1)}, ${coordinate(control2)}, ${coordinate(end)}`,
    start,
    control1,
    control2,
    end,
    // The midpoint of the curve, including the offset used by parallel edges.
    label: {
      x: (start.x + 3 * control1.x + 3 * control2.x + end.x) / 8,
      y: (start.y + 3 * control1.y + 3 * control2.y + end.y) / 8,
    },
    lane,
  };
}

function towards(center: GraphPoint, control: GraphPoint, distance: number): GraphPoint {
  const dx = control.x - center.x,
    dy = control.y - center.y,
    length = Math.hypot(dx, dy);
  return { x: center.x + (dx / length) * distance, y: center.y + (dy / length) * distance };
}

/** Only draws supplied edges; it never merges partitions or infers relationships. */
export function buildGraphEdgeGeometry(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
  positions: ReadonlyMap<string, GraphPoint>,
): Map<string, GraphEdgeGeometry> {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const pairs = new Map<string, KnowledgeGraphEdge[]>();
  for (const edge of edges) {
    if (
      !nodeByKey.has(edge.source) ||
      !nodeByKey.has(edge.target) ||
      !finite(positions.get(edge.source)) ||
      !finite(positions.get(edge.target))
    )
      continue;
    const pair = JSON.stringify([edge.source, edge.target].sort());
    const group = pairs.get(pair) || [];
    group.push(edge);
    pairs.set(pair, group);
  }

  const result = new Map<string, GraphEdgeGeometry>();
  for (const group of pairs.values()) {
    // A canonical direction gives both directions of a relationship distinct
    // lanes on the same physical curve, independent of response ordering.
    group.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const [firstKey, secondKey] = [group[0].source, group[0].target].sort();
    const first = positions.get(firstKey)!,
      second = positions.get(secondKey)!;
    const firstRadius = radius(nodeByKey.get(firstKey)!),
      secondRadius = radius(nodeByKey.get(secondKey)!);
    const dx = second.x - first.x,
      dy = second.y - first.y,
      distance = Math.hypot(dx, dy);

    group.forEach((edge, index) => {
      const lane = index - (group.length - 1) / 2;
      if (firstKey === secondKey || distance < 0.001) {
        // A non-zero loop also handles two different nodes at coincident
        // coordinates without pretending that their identities are equal.
        const reach = 48 + index * 20;
        const diagonal = Math.SQRT1_2;
        const start = {
          x: first.x + firstRadius * diagonal,
          y: first.y - firstRadius * diagonal,
        };
        const end = {
          x: second.x + secondRadius * diagonal,
          y: second.y + secondRadius * diagonal,
        };
        const control1 = { x: first.x + firstRadius + reach, y: first.y - reach };
        const control2 = { x: second.x + secondRadius + reach, y: second.y + reach };
        result.set(
          edge.key,
          edge.source === firstKey
            ? geometry(start, control1, control2, end, lane)
            : geometry(end, control2, control1, start, lane),
        );
        return;
      }

      const nearVertical = Math.abs(dx) <= Math.max(24, Math.abs(dy) * 0.28);
      const bend = nearVertical
        ? Math.min(125, 50 + Math.abs(dy) * 0.15)
        : Math.min(190, Math.max(20, Math.abs(dx) * 0.48));
      const direction = dx < 0 ? -1 : 1;
      const offset = lane * 24;
      const normal = { x: -dy / distance, y: dx / distance };
      const firstHandle = {
        x: first.x + direction * bend + normal.x * offset,
        y: first.y + (nearVertical ? dy * 0.18 : 0) + normal.y * offset,
      };
      const secondHandle = {
        x: second.x + (nearVertical ? direction : -direction) * bend + normal.x * offset,
        y: second.y - (nearVertical ? dy * 0.18 : 0) + normal.y * offset,
      };
      // Even short edges or densely spaced lanes must depart outside a node,
      // rather than turning back through its circle after endpoint clipping.
      const control1 = towards(
          first,
          firstHandle,
          Math.max(firstRadius + 16, Math.hypot(firstHandle.x - first.x, firstHandle.y - first.y)),
        ),
        control2 = towards(
          second,
          secondHandle,
          Math.max(
            secondRadius + 16,
            Math.hypot(secondHandle.x - second.x, secondHandle.y - second.y),
          ),
        );
      const start = towards(first, control1, firstRadius),
        end = towards(second, control2, secondRadius);
      result.set(
        edge.key,
        edge.source === firstKey
          ? geometry(start, control1, control2, end, lane)
          : geometry(end, control2, control1, start, lane),
      );
    });
  }
  return result;
}
