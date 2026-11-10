export interface GraphCamera {
  x: number;
  y: number;
  scale: number;
}

/** Anchor and translation use the same units, relative to the viewport center. */
export function zoomGraphCamera(
  camera: GraphCamera,
  factor: number,
  anchor: { x: number; y: number },
  bounds: { min: number; max: number },
): GraphCamera {
  if (
    ![camera.x, camera.y, camera.scale, factor, anchor.x, anchor.y, bounds.min, bounds.max].every(
      Number.isFinite,
    ) ||
    camera.scale <= 0 ||
    factor <= 0 ||
    bounds.min <= 0 ||
    bounds.max < bounds.min
  )
    return camera;

  const scale = Math.min(bounds.max, Math.max(bounds.min, camera.scale * factor));
  if (scale === camera.scale) return camera;

  const ratio = scale / camera.scale;
  const x = anchor.x - (anchor.x - camera.x) * ratio;
  const y = anchor.y - (anchor.y - camera.y) * ratio;
  return [x, y].every(Number.isFinite) ? { x, y, scale } : camera;
}

/** WheelEvent delta modes: pixels (0), lines (1), pages (2). */
export function graphWheelZoomFactor(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
): number {
  if (!Number.isFinite(deltaY) || ![0, 1, 2].includes(deltaMode) || deltaY === 0) return 1;
  if (deltaMode === 2 && (!Number.isFinite(viewportHeight) || viewportHeight <= 0)) return 1;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1;
  const pixels = Math.min(240, Math.max(-240, deltaY * unit));
  return Math.exp(-pixels * 0.002);
}
