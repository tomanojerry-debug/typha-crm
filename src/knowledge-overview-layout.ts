import type { KnowledgeGraphEdge, KnowledgeGraphNode } from '../shared/knowledge';
import type { GraphPoint } from './knowledge-graph-geometry';

/** Position every supplied identity without joining partitions or inventing edges. */
export function knowledgeOverviewLayout(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
) {
  const points = nodes.map((node, index) => ({
    key: node.key,
    x: 450 + Math.cos(index * 2.39996) * (70 + Math.sqrt(index) * 42),
    y: 320 + Math.sin(index * 2.39996) * (70 + Math.sqrt(index) * 36),
  }));
  const indices = new Map(points.map((point, index) => [point.key, index]));
  const iterations = nodes.length > 240 ? 35 : 100;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const force = points.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const strength = Math.min(14, 8200 / (distance * distance));
        force[i].x += (dx / distance) * strength;
        force[i].y += (dy / distance) * strength;
        force[j].x -= (dx / distance) * strength;
        force[j].y -= (dy / distance) * strength;
      }
    }
    for (const edge of edges) {
      const i = indices.get(edge.source);
      const j = indices.get(edge.target);
      if (i == null || j == null || i === j) continue;
      const dx = points[j].x - points[i].x;
      const dy = points[j].y - points[i].y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const strength = (distance - 165) * 0.025;
      force[i].x += (dx / distance) * strength;
      force[i].y += (dy / distance) * strength;
      force[j].x -= (dx / distance) * strength;
      force[j].y -= (dy / distance) * strength;
    }
    for (let i = 0; i < points.length; i++) {
      points[i].x += Math.max(-14, Math.min(14, force[i].x + (450 - points[i].x) * 0.002));
      points[i].y += Math.max(-14, Math.min(14, force[i].y + (320 - points[i].y) * 0.002));
    }
  }
  const minX = Math.min(0, ...points.map((point) => point.x - 100));
  const minY = Math.min(0, ...points.map((point) => point.y - 80));
  const width = Math.max(900, ...points.map((point) => point.x + 100)) - minX;
  const height = Math.max(640, ...points.map((point) => point.y + 85)) - minY;
  return {
    points: new Map<string, GraphPoint>(points.map((point) => [point.key, point])),
    box: { x: minX, y: minY, width, height },
    center: { x: minX + width / 2, y: minY + height / 2 },
  };
}
