import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Maximize2, X } from 'lucide-react';
import './resizable-table.css';

export interface TableColumn {
  id: string;
  label: string;
  width: number;
  min?: number;
  max?: number;
  fixed?: boolean;
  fill?: boolean;
}
type Widths = Record<string, number>;
type Preview = {
  label: string;
  text: string;
  anchor: HTMLElement;
  action?: HTMLElement;
  actionLabel?: string;
  style: CSSProperties;
};
type Drag = {
  id: string;
  pointer: number;
  startX: number;
  start: number;
  width: number;
  widths: Widths;
  handle: HTMLElement;
};
const bounded = (value: number, column: TableColumn) =>
  Math.round(Math.min(column.max ?? 1000, Math.max(column.min ?? 88, value)));
function loadWidths(key: string, columns: TableColumn[]): Widths {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          ([id, width]) => id.length <= 100 && typeof width === 'number' && Number.isFinite(width),
        )
        .slice(0, 256)
        .flatMap(([id, width]) => {
          const column = columns.find((c) => c.id === id);
          // Keep hidden fields so resizing a visible column after reload does not erase them.
          return column?.fixed
            ? []
            : [[id, bounded(width as number, column ?? { id, label: '', width: 160 })]];
        }),
    );
  } catch {
    return {};
  }
}
const TableContext = createContext<{
  columns: TableColumn[];
  widths: Widths;
  resizing: string | null;
  start: (id: string, e: ReactPointerEvent<HTMLElement>) => void;
  move: (e: ReactPointerEvent<HTMLElement>) => void;
  end: (e: ReactPointerEvent<HTMLElement>, cancel?: boolean) => void;
  set: (id: string, width: number) => void;
  isBypassed: (anchor: HTMLElement) => boolean;
  open: (label: string, text: string, anchor: HTMLElement, action?: HTMLElement) => void;
} | null>(null);

export function ResizableTable({
  columns,
  storageKey,
  children,
  className = '',
  ...props
}: {
  columns: TableColumn[];
  storageKey: string;
  children: ReactNode;
} & TableHTMLAttributes<HTMLTableElement>) {
  const key = `light-crm:column-widths:${storageKey}`;
  const [saved, setSaved] = useState(() => ({ key, widths: loadWidths(key, columns) }));
  const widths = saved.key === key ? saved.widths : loadWidths(key, columns);
  const [resizing, setResizing] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [copied, setCopied] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  const bypass = useRef<HTMLElement | null>(null);
  const id = useId();
  function persist(next: Widths) {
    setSaved({ key, widths: next });
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* A blocked preference store does not block resizing. */
    }
  }
  function set(columnId: string, width: number) {
    const column = columns.find((c) => c.id === columnId);
    if (column && !column.fixed) persist({ ...widths, [columnId]: bounded(width, column) });
  }
  function cleanup() {
    drag.current = null;
    document.body.classList.remove('table-column-resizing');
    setResizing(null);
  }
  useEffect(
    () => () => {
      document.body.classList.remove('table-column-resizing');
    },
    [],
  );
  useEffect(() => {
    setPreview(null);
    if (drag.current) cleanup();
  }, [key]);
  function start(columnId: string, e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    const column = columns.find((c) => c.id === columnId);
    if (!column || column.fixed) return;
    e.preventDefault();
    e.stopPropagation();
    setPreview(null);
    const start = widths[columnId] ?? column.width;
    drag.current = {
      id: columnId,
      pointer: e.pointerId,
      startX: e.clientX,
      start,
      width: start,
      widths,
      handle: e.currentTarget,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('table-column-resizing');
    setResizing(columnId);
  }
  function applyWidth(d: Drag, width: number) {
    const index = columns.findIndex((c) => c.id === d.id);
    const col = table.current?.querySelectorAll('col')[index];
    if (col) col.style.width = `${width}px`;
    const total = columns.reduce(
      (n, c) => n + (c.id === d.id ? width : c.fixed ? c.width : (d.widths[c.id] ?? c.width)),
      0,
    );
    if (table.current) {
      table.current.style.width = columns.some((c) => c.fill) ? '100%' : `${total}px`;
      table.current.style.minWidth = `${total}px`;
    }
    d.handle.setAttribute('aria-valuenow', String(width));
  }
  function move(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const column = columns.find((c) => c.id === d.id)!;
    d.width = bounded(d.start + e.clientX - d.startX, column);
    applyWidth(d, d.width);
  }
  function end(e: ReactPointerEvent<HTMLElement>, cancel = false) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (cancel) {
      applyWidth(d, d.start);
      setSaved({ key, widths: d.widths });
    } else persist({ ...d.widths, [d.id]: d.width });
    cleanup();
    if (d.handle.hasPointerCapture(d.pointer)) d.handle.releasePointerCapture(d.pointer);
  }
  function close(restore = true) {
    if (restore && preview?.anchor.isConnected) preview.anchor.focus({ preventScroll: true });
    setPreview(null);
  }
  useEffect(() => {
    if (!preview) return;
    setCopied(false);
    popup.current?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (!popup.current?.contains(e.target as Node) && !preview.anchor.contains(e.target as Node))
        close(false);
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const scroll = (e: Event) => {
      if (!popup.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', scroll);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', scroll);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [preview]);
  function open(label: string, text: string, anchor: HTMLElement, action?: HTMLElement) {
    if (bypass.current === anchor) return;
    const rect = anchor.getBoundingClientRect(),
      width = Math.min(480, window.innerWidth - 24),
      below = window.innerHeight - rect.bottom;
    setPreview({
      label,
      text,
      anchor,
      action,
      actionLabel: action?.matches('.attribute-value')
        ? '编辑此属性'
        : action
          ? '打开档案'
          : undefined,
      style: {
        width,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        ...(below >= 200
          ? { top: rect.bottom + 5, maxHeight: Math.min(400, below - 17) }
          : {
              bottom: window.innerHeight - rect.top + 5,
              maxHeight: Math.max(150, Math.min(400, rect.top - 17)),
            }),
      },
    });
  }
  const total = columns.reduce((n, c) => n + (c.fixed ? c.width : (widths[c.id] ?? c.width)), 0);
  return (
    <TableContext.Provider
      value={{
        columns,
        widths,
        resizing,
        start,
        move,
        end,
        set,
        open,
        isBypassed: (anchor) => bypass.current === anchor,
      }}
    >
      <table
        {...props}
        id={props.id || id}
        ref={table}
        className={`resizable-table ${className}`}
        data-resizing-column={resizing || undefined}
        style={{
          ...props.style,
          width: columns.some((c) => c.fill) ? '100%' : total,
          minWidth: total,
          tableLayout: 'fixed',
        }}
      >
        <colgroup>
          {columns.map((c) => (
            <col
              key={c.id}
              style={{ width: c.fill ? undefined : c.fixed ? c.width : (widths[c.id] ?? c.width) }}
            />
          ))}
        </colgroup>
        {children}
      </table>
      {preview &&
        createPortal(
          <div
            ref={popup}
            className="cell-value-popover"
            role="dialog"
            aria-label={`${preview.label}完整内容`}
            tabIndex={-1}
            style={preview.style}
          >
            <header>
              <strong>{preview.label}</strong>
              <button className="icon-button" aria-label="关闭完整内容" onClick={() => close()}>
                <X size={15} />
              </button>
            </header>
            <pre>{preview.text}</pre>
            <footer>
              {preview.action && (
                <button
                  onClick={() => {
                    const action = preview.action!;
                    bypass.current = preview.anchor;
                    setPreview(null);
                    action.click();
                    bypass.current = null;
                  }}
                >
                  {preview.actionLabel}
                </button>
              )}
              <button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(preview.text)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? '已复制' : '复制全文'}
              </button>
            </footer>
          </div>,
          document.body,
        )}
    </TableContext.Provider>
  );
}
export function ColumnResizeHandle({ columnId }: { columnId: string }) {
  const ctx = useContext(TableContext);
  if (!ctx) return null;
  const column = ctx.columns.find((c) => c.id === columnId);
  if (!column || column.fixed) return null;
  const width = ctx.widths[columnId] ?? column.width;
  return (
    <span
      className={`column-resize-handle${ctx.resizing === columnId ? ' resizing' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label={`调整${column.label}列宽`}
      aria-orientation="vertical"
      aria-valuemin={column.min ?? 88}
      aria-valuemax={column.max ?? 1000}
      aria-valuenow={width}
      title="拖动调整列宽，双击恢复默认宽度"
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => ctx.start(columnId, e)}
      onPointerMove={ctx.move}
      onPointerUp={(e) => ctx.end(e)}
      onPointerCancel={(e) => ctx.end(e, true)}
      onLostPointerCapture={(e) => ctx.end(e, true)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.set(columnId, column.width);
      }}
      onKeyDown={(e) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          ctx.set(
            columnId,
            e.key === 'Home'
              ? (column.min ?? 88)
              : e.key === 'End'
                ? (column.max ?? 1000)
                : width + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 48 : 16),
          );
        }
      }}
    />
  );
}

let textMeasure: CanvasRenderingContext2D | null | undefined;
function controlText(node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  return node instanceof HTMLSelectElement
    ? Array.from(node.selectedOptions)
        .map((o) => o.label)
        .join('、')
    : node.value;
}
function hasOverflow(el: HTMLElement) {
  if (el.scrollWidth > el.clientWidth + 1) return true;
  return Array.from(el.querySelectorAll<HTMLElement>('*')).some((n) => {
    if (!n.clientWidth) return false;
    if (
      n instanceof HTMLInputElement ||
      n instanceof HTMLSelectElement ||
      n instanceof HTMLTextAreaElement
    ) {
      if (n instanceof HTMLInputElement && ['checkbox', 'radio', 'date'].includes(n.type))
        return false;
      textMeasure ??= document.createElement('canvas').getContext('2d');
      if (!textMeasure) return false;
      const style = getComputedStyle(n);
      textMeasure.font = style.font;
      return (
        textMeasure.measureText(controlText(n)).width >
        n.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          (n instanceof HTMLSelectElement ? 20 : 0) +
          1
      );
    }
    return !n.matches('svg,path') && n.scrollWidth > n.clientWidth + 1;
  });
}
function cellText(el: HTMLElement) {
  const clone = el.cloneNode(true) as HTMLElement;
  const originals = el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    'input,select,textarea',
  );
  clone
    .querySelectorAll('input,select,textarea')
    .forEach((node, i) => node.replaceWith(document.createTextNode(controlText(originals[i]))));
  clone
    .querySelectorAll('svg,.preview-button,.wf-open,[aria-hidden="true"]')
    .forEach((node) => node.remove());
  return (clone.textContent || '').trim();
}

export function ExpandableCell({
  label,
  children,
  className = '',
  ...props
}: { label: string; children: ReactNode } & TdHTMLAttributes<HTMLTableCellElement>) {
  const ctx = useContext(TableContext);
  const root = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => setOverflow(hasOverflow(el));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);
  function show(target?: HTMLElement) {
    const el = content.current,
      anchor = root.current;
    if (!el || !anchor || !ctx) return;
    const text = cellText(el);
    if (!text) return;
    const action =
      target?.closest<HTMLElement>('.record-name,.table-link,.wf-record-name,.attribute-value') ||
      el.querySelector<HTMLElement>('.record-name,.table-link,.wf-record-name,.attribute-value') ||
      undefined;
    ctx.open(label, text, anchor, action);
  }
  return (
    <td {...props} className={className}>
      <div
        ref={root}
        className={`expandable-cell${overflow ? ' has-overflow' : ''}`}
        tabIndex={overflow ? 0 : undefined}
        onKeyDown={(e) => {
          if (overflow && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
            show();
          }
        }}
        onClickCapture={(e) => {
          if (!overflow || (root.current && ctx?.isBypassed(root.current))) return;
          const target = e.target as HTMLElement;
          if (
            target.closest(
              'input,select,textarea,.preview-button,.cell-expand-button,.attribute-table-cell,.attribute-star',
            )
          )
            return;
          e.preventDefault();
          e.stopPropagation();
          show(target);
        }}
      >
        <div ref={content} className="table-cell-content">
          {children}
        </div>
        {overflow && (
          <button
            type="button"
            className="cell-expand-button"
            aria-label={`查看完整${label}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              show();
            }}
          >
            <Maximize2 size={12} />
          </button>
        )}
      </div>
    </td>
  );
}
