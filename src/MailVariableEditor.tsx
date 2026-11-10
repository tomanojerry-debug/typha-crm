import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ChevronLeft, Search, X } from 'lucide-react';
import {
  mailVariableText,
  type MailInlineNode,
  type MailVariableCatalog,
  type MailVariableField,
  type MailVariableNode,
} from '../shared/mail-variables';
import {
  cleanMailPaste,
  cloneMailNodes,
  mailVariableDirectory,
  searchMailVariableFields,
} from './mail-variable-editor-model';
import './mail-variable-editor.css';

export interface MailVariableEditorHandle {
  focus(): void;
}
export interface MailVariableEditorProps {
  value: MailInlineNode[];
  onChange: (nodes: MailInlineNode[]) => void;
  catalog: MailVariableCatalog;
  label: string;
  multiline?: boolean;
  disabled?: boolean;
  placeholder?: string;
  identityKey?: string;
  maxLength?: number;
}
type Menu = {
  kind: 'picker' | 'detail';
  path: string[];
  query: string;
  range: Range | null;
  trigger: boolean;
  tokenId?: string;
  highlight: number;
};

export const MailVariableEditor = forwardRef<MailVariableEditorHandle, MailVariableEditorProps>(
  function MailVariableEditor(
    {
      value,
      onChange,
      catalog,
      label,
      multiline = false,
      disabled = false,
      placeholder = '输入文字，或输入 { 插入变量',
      identityKey = '',
      maxLength,
    },
    forwardedRef,
  ) {
    const editor = useRef<HTMLDivElement>(null),
      panel = useRef<HTMLDivElement>(null);
    const metadata = useRef(new Map<string, MailVariableNode>());
    const lastValue = useRef(''),
      lastIdentity = useRef(identityKey),
      caret = useRef<Range | null>(null);
    const composing = useRef(false),
      currentMenu = useRef<Menu | null>(null);
    const [menu, setMenu] = useState<Menu | null>(null),
      [error, setError] = useState('');
    const menuId = useId();
    const live = useRef({ onChange, catalog, disabled, maxLength });
    live.current = { onChange, catalog, disabled, maxLength };
    function ownRange(range: Range | null) {
      return (
        !!range &&
        !!editor.current &&
        range.startContainer.isConnected &&
        range.endContainer.isConnected &&
        editor.current.contains(range.startContainer) &&
        editor.current.contains(range.endContainer)
      );
    }
    function remember() {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      if (!ownRange(range)) return false;
      caret.current = range.cloneRange();
      return true;
    }
    function place(range: Range) {
      editor.current!.focus();
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      caret.current = range.cloneRange();
    }
    function endRange() {
      const range = document.createRange();
      range.selectNodeContents(editor.current!);
      range.collapse(false);
      return range;
    }
    function chipFor(id: string) {
      return Array.from(
        editor.current?.querySelectorAll<HTMLElement>('[data-mail-variable]') || [],
      ).find((chip) => chip.dataset.mailVariable === id);
    }
    function descriptor(node: MailVariableNode) {
      return live.current.catalog.fields.find(
        (field) => field.root === node.root && field.field === node.field,
      );
    }
    function makeChip(node: MailVariableNode) {
      metadata.current.set(node.id, { ...node });
      const field = descriptor(node),
        chip = document.createElement('button');
      chip.type = 'button';
      chip.contentEditable = 'false';
      chip.dataset.mailVariable = node.id;
      chip.className = 'mail-variable-chip';
      chip.textContent = `{${field?.path.join(' › ') || node.label || '不可用变量'}}`;
      chip.setAttribute(
        'aria-label',
        `${field?.path.join('，') || node.label || '不可用变量'}，变量设置`,
      );
      chip.disabled = live.current.disabled;
      return chip;
    }
    function renderNodes(nodes: MailInlineNode[]) {
      if (!editor.current) return;
      metadata.current.clear();
      editor.current.replaceChildren();
      nodes.forEach((node) =>
        editor.current!.append(
          node.type === 'text' ? document.createTextNode(node.text) : makeChip(node),
        ),
      );
    }
    function readNodes() {
      const nodes: MailInlineNode[] = [];
      const add = (text: string) => {
        text = text.replace(/\u200B/g, '');
        if (!text) return;
        const last = nodes.at(-1);
        if (last?.type === 'text') last.text += text;
        else nodes.push({ type: 'text', text });
      };
      const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          add(node.textContent || '');
          return;
        }
        if (!(node instanceof HTMLElement)) return;
        const item = node.dataset.mailVariable && metadata.current.get(node.dataset.mailVariable);
        if (item) {
          nodes.push({ ...item });
          return;
        }
        if (node.tagName === 'BR') {
          add('\n');
          return;
        }
        if (
          ['DIV', 'P'].includes(node.tagName) &&
          nodes.length &&
          !(nodes.at(-1)?.type === 'text' && (nodes.at(-1) as { text: string }).text.endsWith('\n'))
        )
          add('\n');
        node.childNodes.forEach(visit);
      };
      editor.current!.childNodes.forEach(visit);
      return nodes;
    }
    function publish() {
      const nodes = readNodes();
      lastValue.current = JSON.stringify(nodes);
      live.current.onChange(cloneMailNodes(nodes));
      setError(
        live.current.maxLength && mailVariableText(nodes).length > live.current.maxLength
          ? `最多输入 ${live.current.maxLength} 个字符，请精简后保存`
          : '',
      );
    }
    function hide() {
      currentMenu.current = null;
      setMenu(null);
    }
    function show(next: Menu) {
      currentMenu.current = next;
      setMenu(next);
    }
    function updateMenu(patch: Partial<Menu>) {
      if (currentMenu.current) show({ ...currentMenu.current, ...patch });
    }
    function trigger() {
      const selection = window.getSelection();
      if (!selection?.isCollapsed || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      if (
        !ownRange(range) ||
        range.startContainer.nodeType !== Node.TEXT_NODE ||
        range.startContainer.parentElement?.closest('[data-mail-variable]')
      )
        return null;
      const match = (range.startContainer.textContent || '')
        .slice(0, range.startOffset)
        .match(/\{([^{}\n]{0,80})$/);
      if (!match) return null;
      const replacement = range.cloneRange();
      replacement.setStart(range.startContainer, range.startOffset - match[0].length);
      return { range: replacement, query: match[1] };
    }
    function fromInput() {
      remember();
      const found = trigger();
      if (found)
        show({
          kind: 'picker',
          path: [],
          query: found.query,
          range: found.range,
          trigger: true,
          highlight: 0,
        });
      else if (currentMenu.current?.trigger) hide();
    }
    function position() {
      const active = currentMenu.current,
        pop = panel.current,
        host = editor.current;
      if (!active || !pop || !host) return;
      const chip = active.tokenId && chipFor(active.tokenId);
      let anchor = chip ? chip.getBoundingClientRect() : null;
      if (!anchor && ownRange(active.range)) {
        const point = active.range!.cloneRange();
        point.collapse(false);
        const rect = point.getBoundingClientRect();
        if (rect.height || rect.width) anchor = rect;
      }
      if (!anchor) anchor = host.getBoundingClientRect();
      const width = Math.min(350, window.innerWidth - 20);
      pop.style.width = `${width}px`;
      const height = pop.offsetHeight;
      const below = anchor.bottom + 6,
        above = anchor.top - height - 6;
      const top = below + height > window.innerHeight - 10 && above >= 10 ? above : below;
      pop.style.left = `${Math.max(10, Math.min(anchor.left, window.innerWidth - width - 10))}px`;
      pop.style.top = `${Math.max(10, Math.min(top, window.innerHeight - height - 10))}px`;
    }
    function insert(field: MailVariableField) {
      const active = currentMenu.current;
      if (!active || composing.current || live.current.disabled) return;
      let range = active.range;
      const old = active.tokenId && chipFor(active.tokenId);
      if (old) {
        range = document.createRange();
        range.selectNode(old);
      }
      if (!ownRange(range)) {
        hide();
        return;
      }
      const node: MailVariableNode = {
        type: 'variable',
        id: crypto.randomUUID(),
        root: field.root,
        field: field.field,
        label: field.path.join(' › '),
      };
      const chip = makeChip(node),
        after = document.createTextNode('\u200B');
      range!.deleteContents();
      range!.insertNode(after);
      range!.insertNode(chip);
      const next = document.createRange();
      next.setStart(after, 1);
      next.collapse(true);
      hide();
      place(next);
      publish();
    }
    function remove(chip: HTMLElement) {
      const range = document.createRange();
      range.setStartBefore(chip);
      range.collapse(true);
      chip.remove();
      hide();
      place(range);
      publish();
    }
    function insertText(value: string) {
      if (composing.current || live.current.disabled) return;
      remember();
      const range = ownRange(caret.current) ? caret.current!.cloneRange() : endRange();
      value = cleanMailPaste(value, multiline);
      if (
        maxLength &&
        mailVariableText(readNodes()).length - range.toString().length + value.length > maxLength
      ) {
        setError(`最多输入 ${maxLength} 个字符，本次粘贴未加入`);
        return;
      }
      const node = document.createTextNode(value);
      range.deleteContents();
      range.insertNode(node);
      const next = document.createRange();
      next.setStart(node, node.length);
      next.collapse(true);
      place(next);
      publish();
      fromInput();
    }
    useImperativeHandle(forwardedRef, () => ({
      focus() {
        if (editor.current) place(ownRange(caret.current) ? caret.current! : endRange());
      },
    }));
    useLayoutEffect(() => {
      const encoded = JSON.stringify(value);
      if (
        lastIdentity.current !== identityKey ||
        (!composing.current && encoded !== lastValue.current)
      ) {
        lastIdentity.current = identityKey;
        lastValue.current = encoded;
        caret.current = null;
        hide();
        renderNodes(value);
      }
    }, [value, identityKey]);
    useEffect(() => {
      editor.current
        ?.querySelectorAll<HTMLButtonElement>('[data-mail-variable]')
        .forEach((chip) => {
          chip.disabled = disabled;
        });
      if (disabled) hide();
    }, [disabled]);
    useLayoutEffect(() => {
      const pop = panel.current;
      if (!pop) return;
      if (menu) {
        if (!pop.matches(':popover-open')) pop.showPopover();
        position();
      } else if (pop.matches(':popover-open')) pop.hidePopover();
    }, [menu]);
    useEffect(() => {
      const outside = (event: PointerEvent) => {
        if (
          !panel.current?.contains(event.target as Node) &&
          !editor.current?.contains(event.target as Node)
        )
          hide();
      };
      const selection = () => {
        if (composing.current) return;
        if (!remember()) {
          const active = document.activeElement;
          if (active && !panel.current?.contains(active) && !editor.current?.contains(active)) {
            caret.current = null;
            hide();
          }
          return;
        }
        const active = currentMenu.current;
        if (!active) return;
        if (active.kind === 'picker' && active.trigger) {
          const found = trigger();
          if (
            !found ||
            found.range.startContainer !== active.range?.startContainer ||
            found.range.startOffset !== active.range.startOffset
          )
            hide();
          else updateMenu({ range: found.range, query: found.query });
        }
      };
      const escape = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && currentMenu.current && !composing.current) {
          event.preventDefault();
          event.stopPropagation();
          hide();
        }
      };
      document.addEventListener('pointerdown', outside);
      document.addEventListener('selectionchange', selection);
      document.addEventListener('keydown', escape, true);
      window.addEventListener('resize', position);
      document.addEventListener('scroll', position, true);
      return () => {
        document.removeEventListener('pointerdown', outside);
        document.removeEventListener('selectionchange', selection);
        document.removeEventListener('keydown', escape, true);
        window.removeEventListener('resize', position);
        document.removeEventListener('scroll', position, true);
      };
    }, []);
    const directory = mailVariableDirectory(catalog, menu?.path || []);
    const choices = menu?.query.trim()
      ? searchMailVariableFields(catalog, menu.query).map((field) => ({ field }))
      : [
          ...directory.groups.map((group) => ({ group })),
          ...directory.fields.map((field) => ({ field })),
        ];
    const selected = menu?.tokenId ? metadata.current.get(menu.tokenId) : undefined;
    const selectedField = selected && descriptor(selected);
    function updateSelected(patch: Partial<MailVariableNode>) {
      if (!selected || !menu?.tokenId) return;
      const next = { ...selected, ...patch };
      if (
        !Object.hasOwn(patch, 'fallback') &&
        Object.hasOwn(next, 'fallback') &&
        next.fallback === undefined
      )
        delete next.fallback;
      metadata.current.set(menu.tokenId, next);
      publish();
      updateMenu({});
    }
    return (
      <div className={`mail-variable-editor${multiline ? ' is-multiline' : ''}`}>
        <div
          ref={editor}
          className="mail-variable-input"
          role="textbox"
          aria-label={label}
          aria-multiline={multiline}
          aria-disabled={disabled}
          aria-controls={menu ? menuId : undefined}
          aria-expanded={!!menu}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          data-placeholder={placeholder}
          onCompositionStart={() => {
            composing.current = true;
            hide();
          }}
          onCompositionEnd={() => {
            composing.current = false;
            publish();
            fromInput();
          }}
          onInput={(event) => {
            if (!composing.current && !event.nativeEvent.isComposing) {
              publish();
              fromInput();
            }
          }}
          onBeforeInput={(event) => {
            const native = event.nativeEvent as InputEvent;
            if (composing.current || native.isComposing) return;
            if (native.inputType?.startsWith('format')) event.preventDefault();
            if (native.inputType === 'insertParagraph' || native.inputType === 'insertLineBreak') {
              event.preventDefault();
              if (multiline) insertText('\n');
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            if (!composing.current) insertText(event.clipboardData.getData('text/plain'));
          }}
          onDrop={(event) => event.preventDefault()}
          onDragOver={(event) => event.preventDefault()}
          onClick={(event) => {
            const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-mail-variable]');
            if (chip && !disabled && !composing.current) {
              show({
                kind: 'detail',
                path: [],
                query: '',
                range: null,
                trigger: false,
                tokenId: chip.dataset.mailVariable,
                highlight: 0,
              });
            }
          }}
          onKeyDown={(event) => {
            if (
              disabled ||
              composing.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return;
            if (
              menu?.kind === 'picker' &&
              ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) &&
              choices.length
            ) {
              event.preventDefault();
              if (event.key === 'Enter') {
                const item = choices[Math.min(menu.highlight, choices.length - 1)];
                if ('field' in item) insert(item.field);
                else updateMenu({ path: item.group.path, query: '', highlight: 0 });
              } else
                updateMenu({
                  highlight:
                    (menu.highlight + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) %
                    choices.length,
                });
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (multiline) insertText('\n');
              return;
            }
            if (event.key !== 'Backspace' && event.key !== 'Delete') return;
            const direct = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-mail-variable]',
            );
            if (direct) {
              event.preventDefault();
              remove(direct);
              return;
            }
            const selection = window.getSelection();
            if (!selection?.isCollapsed || !selection.rangeCount) return;
            const range = selection.getRangeAt(0);
            if (!ownRange(range)) return;
            const backwards = event.key === 'Backspace';
            const node = range.startContainer,
              offset = range.startOffset;
            let adjacent: Node | null | undefined;
            if (node.nodeType === Node.TEXT_NODE) {
              const rest = backwards
                ? node.textContent!.slice(0, offset)
                : node.textContent!.slice(offset);
              if (rest.replace(/\u200B/g, '')) return;
              adjacent = backwards ? node.previousSibling : node.nextSibling;
            } else adjacent = node.childNodes[backwards ? offset - 1 : offset];
            while (
              adjacent?.nodeType === Node.TEXT_NODE &&
              !adjacent.textContent?.replace(/\u200B/g, '')
            )
              adjacent = backwards ? adjacent.previousSibling : adjacent.nextSibling;
            if (adjacent instanceof HTMLElement && adjacent.dataset.mailVariable) {
              event.preventDefault();
              remove(adjacent);
            }
          }}
        />
        {error && (
          <small className="error" role="alert">
            {error}
          </small>
        )}
        <div
          ref={panel}
          id={menuId}
          popover="manual"
          className="mail-variable-popover"
          role="dialog"
          aria-label={menu?.kind === 'detail' ? '变量设置' : '插入变量'}
          onPointerDown={(event) => {
            if (!composing.current && (event.target as HTMLElement).closest('button')) {
              remember();
              event.preventDefault();
            }
          }}
        >
          {menu?.kind === 'picker' ? (
            <>
              <header>
                {menu.path.length > 0 && (
                  <button
                    type="button"
                    aria-label="返回上一级"
                    onClick={() =>
                      updateMenu({ path: menu.path.slice(0, -1), query: '', highlight: 0 })
                    }
                  >
                    <ChevronLeft size={15} />
                  </button>
                )}
                <strong>{menu.tokenId ? '更换变量' : '插入变量'}</strong>
                <button type="button" aria-label="关闭变量菜单" onClick={hide}>
                  <X size={15} />
                </button>
              </header>
              <div className="mail-variable-breadcrumb">
                <button
                  type="button"
                  onClick={() => updateMenu({ path: [], query: '', highlight: 0 })}
                >
                  全部变量
                </button>
                {menu.path.map((part, index) => (
                  <button
                    key={`${part}:${index}`}
                    type="button"
                    onClick={() =>
                      updateMenu({ path: menu.path.slice(0, index + 1), query: '', highlight: 0 })
                    }
                  >
                    › {part}
                  </button>
                ))}
              </div>
              <label className="mail-variable-search">
                <Search size={14} />
                <input
                  aria-label="搜索变量字段"
                  placeholder="继续输入，搜索字段"
                  value={menu.query}
                  onChange={(event) => updateMenu({ query: event.target.value, highlight: 0 })}
                />
              </label>
              <div className="mail-variable-options">
                {choices.map((item, index) =>
                  'group' in item ? (
                    <button
                      type="button"
                      key={item.group.path.join('/')}
                      data-active={menu.highlight === index}
                      onClick={() => updateMenu({ path: item.group.path, query: '', highlight: 0 })}
                    >
                      <span>{item.group.label}</span>
                      <span>›</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      key={`${item.field.root}:${item.field.field}`}
                      data-active={menu.highlight === index}
                      onClick={() => insert(item.field)}
                    >
                      <span>
                        {item.field.label}
                        {item.field.ai_enabled && <small className="mail-variable-ai">AI</small>}
                        {!!menu.query.trim() && (
                          <small>{item.field.path.slice(0, -1).join(' › ')}</small>
                        )}
                      </span>
                      <span>插入</span>
                    </button>
                  ),
                )}
                {!choices.length && <p>没有匹配字段</p>}
              </div>
            </>
          ) : (
            selected && (
              <>
                <header>
                  <strong>{selectedField?.label || '不可用变量'}</strong>
                  <button type="button" aria-label="关闭变量设置" onClick={hide}>
                    <X size={15} />
                  </button>
                </header>
                <dl>
                  <dt>取值路径</dt>
                  <dd>{selectedField?.path.join(' › ') || selected.label || '字段已不可用'}</dd>
                  <dt>取值来源</dt>
                  <dd>
                    {selectedField?.path.slice(0, -1).join(' › ') || '不可用'}
                    {selectedField?.ai_enabled ? ' · AI整理属性' : ''}
                  </dd>
                </dl>
                <label className="mail-variable-fallback">
                  <input
                    type="checkbox"
                    checked={Object.hasOwn(selected, 'fallback')}
                    onChange={(event) => {
                      if (event.target.checked) updateSelected({ fallback: '' });
                      else {
                        const next = { ...selected };
                        delete next.fallback;
                        metadata.current.set(selected.id, next);
                        publish();
                        updateMenu({});
                      }
                    }}
                  />
                  字段为空时使用备用文案
                </label>
                <label className="mail-variable-fallback-text">
                  备用文案（可为空文本）
                  <input
                    aria-label="备用文案"
                    value={selected.fallback ?? ''}
                    disabled={!Object.hasOwn(selected, 'fallback')}
                    maxLength={2000}
                    onChange={(event) => updateSelected({ fallback: event.target.value })}
                  />
                </label>
                <p className="mail-variable-note">
                  未绑定对象或无权读取时不会使用备用文案，核对邮件时显示具体问题。
                </p>
                <footer>
                  <button
                    type="button"
                    onClick={() =>
                      updateMenu({ kind: 'picker', path: [], query: '', highlight: 0 })
                    }
                  >
                    更换变量
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const chip = chipFor(selected.id);
                      if (chip) remove(chip);
                    }}
                  >
                    删除变量
                  </button>
                </footer>
              </>
            )
          )}
        </div>
      </div>
    );
  },
);
