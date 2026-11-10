import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { graphWheelZoomFactor, zoomGraphCamera, type GraphCamera } from './knowledge-graph-camera';

/** Keep wheel handling local to the canvas, with a non-passive native listener. */
export function useGraphWheelZoom<T extends Element>(
  target: RefObject<T | null>,
  setCamera: Dispatch<SetStateAction<GraphCamera>>,
  {
    enabled,
    min,
    max,
    worldWidth,
    worldHeight,
  }: {
    enabled: boolean;
    min: number;
    max: number;
    worldWidth?: number;
    worldHeight?: number;
  },
) {
  useEffect(() => {
    const element = target.current;
    if (!enabled || !element) return;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    function wheel(event: WheelEvent) {
      if (
        event.target instanceof Element &&
        event.target.closest('input,select,textarea,[data-graph-scroll]')
      )
        return;
      const rect = element!.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const factor = graphWheelZoomFactor(event.deltaY, event.deltaMode, rect.height);
      if (factor === 1) return;
      const fit =
        worldWidth && worldHeight
          ? Math.min(rect.width / worldWidth, rect.height / worldHeight)
          : 1;
      event.preventDefault();
      element!.classList.add('is-wheel-zooming');
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => element!.classList.remove('is-wheel-zooming'), 160);
      setCamera((camera) =>
        zoomGraphCamera(
          camera,
          factor,
          {
            x: (event.clientX - rect.left - rect.width / 2) / fit,
            y: (event.clientY - rect.top - rect.height / 2) / fit,
          },
          { min, max },
        ),
      );
    }
    element.addEventListener('wheel', wheel as EventListener, { passive: false });
    return () => {
      element.removeEventListener('wheel', wheel as EventListener);
      clearTimeout(settleTimer);
      element.classList.remove('is-wheel-zooming');
    };
  }, [target, setCamera, enabled, min, max, worldWidth, worldHeight]);
}
