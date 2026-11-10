import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, LoaderCircle, Sparkles, X } from 'lucide-react';
import {
  formatAttributeValue,
  isEmptyAttributeValue,
  type AttributeValue,
  type CompanyAttribute,
  type CompanyAttributeValue,
} from '../shared/attributes';
import { api } from './api';
import { evidenceText } from './CompanyAttributes';
import { attributeJobBusy, type AttributeCompany, type AttributeJob } from './AttributeGenerate';
import './attributes.css';

type Draft = {
  value: string | string[];
  original: AttributeValue;
  version: number;
  fieldVersion: number;
};
export function AttributeTableCell({
  workspace,
  customer,
  field,
  current,
  ready,
  configured,
  generationBusy,
  job,
  onGenerate,
  onSaved,
}: {
  workspace: string;
  customer: AttributeCompany;
  field: CompanyAttribute;
  current?: CompanyAttributeValue;
  ready: boolean;
  configured: boolean;
  generationBusy: boolean;
  job?: AttributeJob;
  onGenerate: () => void;
  onSaved: (value: CompanyAttributeValue) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [sources, setSources] = useState(false);
  const lock = useRef(false),
    dismissed = useRef(false),
    restoreFocus = useRef(false),
    valueButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!draft && restoreFocus.current) {
      restoreFocus.current = false;
      valueButton.current?.focus({ preventScroll: true });
    }
  }, [draft]);
  const generating = attributeJobBusy(job);
  const editable = ready && customer.can_edit && !customer.archived_at && !generating;
  const empty = isEmptyAttributeValue(current?.value);
  const label = `${field.name}：${customer.name}`;
  function edit() {
    if (!editable || draft) return;
    dismissed.current = false;
    setError('');
    setDraft({
      value: Array.isArray(current?.value) ? current.value : String(current?.value ?? ''),
      original: current?.value ?? null,
      version: current?.version || 0,
      fieldVersion: field.version,
    });
  }
  function cancel() {
    if (lock.current) return;
    dismissed.current = true;
    setDraft(null);
    setError('');
  }
  async function save() {
    if (!draft || lock.current || dismissed.current) return;
    let value: AttributeValue = Array.isArray(draft.value) ? draft.value : draft.value || null;
    if (field.kind === 'number' && value !== null) {
      value = typeof value === 'string' && !value.trim() ? null : Number(value);
      if (value !== null && !Number.isFinite(value)) {
        setError('请输入有效数字');
        return;
      }
    }
    if (JSON.stringify(value) === JSON.stringify(draft.original)) {
      cancel();
      return;
    }
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = await api<CompanyAttributeValue>(
        `/customers/${customer.id}/attribute-values/${field.id}`,
        {
          workspace,
          method: 'PATCH',
          body: { value, version: draft.version, attribute_version: draft.fieldVersion },
        },
      );
      onSaved(saved);
      dismissed.current = true;
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  function keyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      restoreFocus.current = true;
      cancel();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      restoreFocus.current = true;
      void save();
    }
  }
  const hint =
    job?.status === 'queued' ? '等待生成…' : job?.status === 'saving' ? '正在保存…' : '正在生成…';
  return (
    <div
      className={`attribute-table-cell${draft ? ' is-editing' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="attribute-cell" aria-busy={generating || saving}>
        {(field.ai_enabled || current?.origin === 'ai') && (
          <button
            type="button"
            className={`attribute-star${current?.origin === 'ai' ? ' is-generated' : ''}`}
            aria-label={`${empty ? 'AI生成' : current?.origin === 'ai' ? '查看AI依据' : '编辑'}${label}`}
            title={
              generating
                ? hint
                : current?.origin === 'ai'
                  ? 'AI 生成 · 查看依据'
                  : empty
                    ? '按已保存的指令 AI 生成'
                    : '人工填写 · 点击编辑'
            }
            disabled={
              generating ||
              saving ||
              !!draft ||
              (empty ? !editable || !configured || generationBusy : !ready)
            }
            onClick={() => {
              if (empty) onGenerate();
              else if (current?.origin === 'ai') setSources((v) => !v);
              else edit();
            }}
          >
            {generating ? (
              <LoaderCircle size={13} className="attribute-spin" />
            ) : (
              <Sparkles size={13} />
            )}
          </button>
        )}
        {draft ? (
          <div
            className="attribute-inline-editor"
            onKeyDown={keyDown}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                if (!lock.current) restoreFocus.current = false;
                void save();
              }
            }}
          >
            {field.kind === 'multi_select' ? (
              <div className="attribute-inline-options" role="group" aria-label={`编辑${label}`}>
                {field.options.map((option, i) => (
                  <label key={option}>
                    <input
                      type="checkbox"
                      autoFocus={i === 0}
                      disabled={saving}
                      checked={Array.isArray(draft.value) && draft.value.includes(option)}
                      onChange={(e) =>
                        setDraft((d) => {
                          if (!d) return d;
                          const values = Array.isArray(d.value) ? d.value : [];
                          return {
                            ...d,
                            value: e.target.checked
                              ? [...values, option]
                              : values.filter((v) => v !== option),
                          };
                        })
                      }
                    />
                    {option}
                  </label>
                ))}
              </div>
            ) : field.kind === 'select' ? (
              <select
                autoFocus
                aria-label={`编辑${label}`}
                disabled={saving}
                value={String(draft.value)}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              >
                <option value="">未填写</option>
                {field.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : field.kind === 'number' ? (
              <input
                autoFocus
                aria-label={`编辑${label}`}
                type="text"
                inputMode="decimal"
                disabled={saving}
                value={String(draft.value)}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              />
            ) : (
              <textarea
                autoFocus
                aria-label={`编辑${label}`}
                rows={Math.min(7, Math.max(3, Math.ceil(String(draft.value).length / 24)))}
                maxLength={5000}
                disabled={saving}
                value={String(draft.value)}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              />
            )}
            <div className="attribute-inline-actions">
              <span>{saving ? '保存中…' : 'Enter 保存 · Esc 取消'}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`保存${label}`}
                disabled={saving}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => void save()}
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`取消编辑${label}`}
                disabled={saving}
                onPointerDown={(e) => e.preventDefault()}
                onClick={cancel}
              >
                <X size={12} />
              </button>
            </div>
            {error && (
              <p className="attribute-inline-error" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : generating ? (
          <span className="attribute-cell-status" role="status">
            {hint}
          </span>
        ) : (
          <button
            ref={valueButton}
            className="attribute-value"
            disabled={!editable}
            aria-label={`编辑${label}`}
            title={`${formatAttributeValue(current?.value, current?.origin)}${editable ? ' · 点击编辑' : ''}`}
            onClick={edit}
          >
            {ready ? formatAttributeValue(current?.value, current?.origin) : '读取中…'}
          </button>
        )}
      </div>
      {!draft && empty && job?.status === 'error' && (
        <p className="attribute-inline-error" role="alert" title={job.message}>
          {job.message}
        </p>
      )}
      {!draft && empty && job?.status === 'empty' && (
        <p className="attribute-inline-hint" title={job.message}>
          资料不足，可直接填写
        </p>
      )}
      {sources && current?.origin === 'ai' && (
        <div className="attribute-cell-evidence">
          <strong>AI 生成依据</strong>
          <p>{current.explanation}</p>
          {current.sources.map((s) => (
            <details key={s.id}>
              <summary>{s.title}</summary>
              <pre>{evidenceText(s)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
