import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { FileText, Search } from 'lucide-react';
import { mailTemplates, searchMailTemplates, type MailTemplate } from '../shared/mail-templates';
import './mail-template-picker.css';

export type MailTemplatePickerProps = {
  onSelect: (template: MailTemplate) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  templates?: MailTemplate[];
};

type PanelPosition = { top: number; left: number; width: number; maxHeight: number };

export function MailTemplatePicker({
  onSelect,
  disabled = false,
  label = '选择一个模板',
  className = '',
  templates: catalog = mailTemplates,
}: MailTemplatePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const id = useId();
  const templates = searchMailTemplates(query, catalog);
  const activeTemplate = templates[activeIndex];

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
    setPosition(null);
    composing.current = false;
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const button = trigger.current;
      if (!button) return;
      const anchor = button.getBoundingClientRect();
      const dialog = button.closest('dialog')?.getBoundingClientRect();
      const container = button.closest('.compose-body') ?? button.closest('dialog');
      const bounds = container?.getBoundingClientRect();
      const margin = 12;
      const leftEdge = Math.max(margin, (bounds?.left ?? 0) + margin);
      const rightEdge = Math.min(
        window.innerWidth - margin,
        (bounds?.right ?? window.innerWidth) - margin,
      );
      const width = Math.min(400, Math.max(0, rightEdge - leftEdge));
      const topEdge = Math.max(margin, (dialog?.top ?? 0) + margin);
      const bottomEdge = Math.min(
        window.innerHeight - margin,
        (dialog?.bottom ?? window.innerHeight) - margin,
      );
      const below = Math.max(0, bottomEdge - anchor.bottom - 7);
      const above = Math.max(0, anchor.top - topEdge - 7);
      const useAbove = below < 330 && above > below;
      const maxHeight = Math.min(380, useAbove ? above : below);
      const height = Math.min(panel.current?.scrollHeight ?? 380, maxHeight);
      setPosition({
        left: Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)),
        top: useAbove ? anchor.top - 7 - height : anchor.bottom + 7,
        width,
        maxHeight,
      });
    };
    updatePosition();
    const resizeObserver = new ResizeObserver(updatePosition);
    if (panel.current) resizeObserver.observe(panel.current);
    const container = trigger.current?.closest('.compose-body');
    if (container) resizeObserver.observe(container);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const positioned = position !== null;
  useLayoutEffect(() => {
    if (open && positioned) search.current?.focus({ preventScroll: true });
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || composing.current || event.keyCode === 229)
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled, open, close]);

  useEffect(() => {
    const option = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!option || !list.current) return;
    const bounds = list.current.getBoundingClientRect();
    const active = option.getBoundingClientRect();
    if (active.top < bounds.top) list.current.scrollTop -= bounds.top - active.top;
    else if (active.bottom > bounds.bottom) list.current.scrollTop += active.bottom - bounds.bottom;
  }, [activeIndex, open, query]);

  function select(template: MailTemplate) {
    close();
    onSelect(template);
  }

  return (
    <span
      className={`mail-template-picker ${className}`}
      onBlur={(event) => {
        if (
          open &&
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          close(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="mail-template-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => {
          if (open) close();
          else {
            setQuery('');
            setActiveIndex(0);
            setOpen(true);
          }
        }}
      >
        {label}
      </button>
      {open && (
        <div
          ref={panel}
          id={`${id}-panel`}
          className="mail-template-panel"
          role="dialog"
          aria-label="选择邮件模板"
          style={position ? position : { visibility: 'hidden' }}
        >
          <div className="mail-template-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              placeholder="搜索模板…"
              aria-label="搜索邮件模板"
              role="combobox"
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={activeTemplate ? `${id}-${activeTemplate.id}` : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229)
                  return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (templates.length)
                    setActiveIndex(
                      (current) =>
                        (current + (event.key === 'ArrowDown' ? 1 : -1) + templates.length) %
                        templates.length,
                    );
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  if (activeTemplate) select(activeTemplate);
                }
              }}
            />
          </div>
          <div
            ref={list}
            id={`${id}-list`}
            className="mail-template-list"
            role="listbox"
            aria-label="邮件模板"
          >
            {templates.map((template, index) => (
              <button
                key={template.id}
                type="button"
                role="option"
                id={`${id}-${template.id}`}
                aria-selected={index === activeIndex}
                className="mail-template-option"
                tabIndex={-1}
                onPointerMove={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(template)}
              >
                <FileText size={16} aria-hidden="true" />
                <span>
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                </span>
              </button>
            ))}
            {!templates.length && (
              <p className="mail-template-empty" role="status">
                没有匹配的模板，试试其他关键词
              </p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
