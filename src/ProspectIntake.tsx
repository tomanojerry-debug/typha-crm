import { useEffect, useRef, useState } from 'react';
import { Sparkles, Trash2 } from 'lucide-react';
import type { Customer } from '../shared/domain';
import type { CustomerList } from '../shared/views';
import type { Prospect, ProspectListResponse, ProspectSourceRef } from '../shared/prospects';
import { api } from './api';

type Requirement = {
  id: string;
  title: string;
  kind: 'missing' | 'action';
  source_record_ids: string[];
  quote: string;
};
type Candidate = {
  id: string;
  customer_id: string;
  version: number;
  title: string;
  summary: string;
  requirements: Requirement[];
  source_refs: ProspectSourceRef[];
};
type Source = ProspectSourceRef & { quote: string; project_id: string | null };
type SourcePage = { sources: Source[]; next_offset: number; has_more: boolean };
export interface ProspectIntakeProps {
  workspace: string;
  customerId?: string;
  sourceRecordIds?: string[];
  sourceKind?: string;
  sourceId?: string;
  onCreated: (id: string) => void;
  onClose: () => void;
  onDirty?: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请保留输入后重试');

/** Content component: callers provide the existing shared Dialog and navigation protection. */
function ProspectIntakeEditor(props: ProspectIntakeProps) {
  const { workspace, customerId, sourceKind, sourceId, sourceRecordIds, onCreated, onClose } =
    props;
  const [customer, setCustomer] = useState(customerId || '');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');
  const [customerPage, setCustomerPage] = useState(1);
  const [customerMore, setCustomerMore] = useState(false);
  const [sourceRows, setSources] = useState<Source[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<string[]>(sourceRecordIds || []);
  const [instruction, setInstruction] = useState('');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [targets, setTargets] = useState<Prospect[]>([]);
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<'new' | 'link'>('new');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'accept' | null>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const sourceController = useRef<AbortController | null>(null);
  const recordIdsKey = (sourceRecordIds || []).join(',');
  const generationRequest = useRef<string | null>(null);
  const acceptanceRequest = useRef<string | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const dirty = Boolean(candidate || instruction || selected.length);
  useEffect(() => {
    callbacks.current.onDirty?.(dirty);
  }, [dirty]);
  useEffect(() => {
    callbacks.current.onBusy?.(Boolean(busy));
  }, [busy]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      callbacks.current.onDirty?.(false);
      callbacks.current.onBusy?.(false);
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void api<CustomerList>(
      `/customers?editable=true&q=${encodeURIComponent(query)}&sort=name&direction=asc&page=${customerPage}`,
      { workspace, signal: abort.signal },
    )
      .then((r) => {
        if (abort.signal.aborted) return;
        setCustomers((old) =>
          customerPage === 1
            ? r.items
            : [...old, ...r.items.filter((v) => !old.some((c) => c.id === v.id))],
        );
        setCustomerMore(customerPage * r.page_size < r.total);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      });
    return () => abort.abort();
  }, [workspace, query, customerPage]);
  useEffect(() => {
    if (!customer) {
      setSources([]);
      setHasMore(false);
      return;
    }
    const abort = new AbortController();
    sourceController.current = abort;
    setSources([]);
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ customer_id: customer });
    if (sourceKind) params.set('source_kind', sourceKind);
    if (sourceId) params.set('source_id', sourceId);
    if (sourceRecordIds?.length) params.set('record_ids', sourceRecordIds.join(','));
    void api<SourcePage>(`/prospect-intakes/sources?${params}`, { workspace, signal: abort.signal })
      .then((r) => {
        if (abort.signal.aborted) return;
        setSources(r.sources);
        setHasMore(r.has_more);
        setNextOffset(r.next_offset);
        if (sourceRecordIds?.length)
          setSelected(sourceRecordIds.filter((id) => r.sources.some((s) => s.record_id === id)));
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [workspace, customer, sourceKind, sourceId, recordIdsKey]);
  useEffect(() => {
    if (!customer || !candidate) {
      setTargets([]);
      return;
    }
    const abort = new AbortController();
    void (async () => {
      const items: Prospect[] = [];
      for (let page = 1; ; page++) {
        const r = await api<ProspectListResponse>(
          `/prospects?customer_id=${customer}&page=${page}&page_size=50`,
          { workspace, signal: abort.signal },
        );
        items.push(...r.items);
        if (items.length >= r.total || !r.items.length) break;
      }
      if (!abort.signal.aborted)
        setTargets(items.filter((v) => v.can_edit && v.lifecycle !== 'closed'));
    })().catch((e) => {
      if (!abort.signal.aborted) setError(errorText(e));
    });
    return () => abort.abort();
  }, [workspace, customer, candidate?.id]);
  function edited(next: Candidate) {
    setCandidate(next);
    acceptanceRequest.current = null;
  }
  function close() {
    if (!busy) onClose();
  }
  async function loadMore() {
    if (!customer || loading) return;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ customer_id: customer, offset: String(nextOffset) });
    if (sourceKind) params.set('source_kind', sourceKind);
    if (sourceId) params.set('source_id', sourceId);
    if (sourceRecordIds?.length) params.set('record_ids', sourceRecordIds.join(','));
    const signal = sourceController.current?.signal;
    try {
      const r = await api<SourcePage>(`/prospect-intakes/sources?${params}`, { workspace, signal });
      if (signal?.aborted || sourceController.current?.signal !== signal) return;
      setSources((old) => [
        ...old,
        ...r.sources.filter((s) => !old.some((v) => v.record_id === s.record_id)),
      ]);
      setHasMore(r.has_more);
      setNextOffset(r.next_offset);
    } catch (e) {
      if (!signal?.aborted && sourceController.current?.signal === signal) setError(errorText(e));
    } finally {
      if (sourceController.current?.signal === signal && !signal?.aborted) setLoading(false);
    }
  }
  async function generate() {
    if (!customer || !selected.length || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    generationRequest.current ||= crypto.randomUUID();
    setBusy('generate');
    setError('');
    try {
      const result = await api<{ candidate: Candidate }>('/prospect-intakes/generate', {
        workspace,
        method: 'POST',
        signal: abort.signal,
        body: {
          request_id: generationRequest.current,
          customer_id: customer,
          source_record_ids: selected,
          instruction,
        },
      });
      if (alive.current && !abort.signal.aborted) {
        setCandidate(result.candidate);
        acceptanceRequest.current = null;
      }
    } catch (e) {
      if (alive.current)
        setError(abort.signal.aborted ? '已停止整理，所选材料与输入已保留。' : errorText(e));
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        if (alive.current) setBusy(null);
      }
    }
  }
  async function accept() {
    if (!candidate || busy) return;
    const chosen = targets.find((v) => v.id === target);
    if (mode === 'link' && !chosen) {
      setError('请选择要关联的已有询盘');
      return;
    }
    acceptanceRequest.current ||= crypto.randomUUID();
    setBusy('accept');
    setError('');
    try {
      const result = await api<{ prospect: Prospect }>(`/prospect-intakes/${candidate.id}/accept`, {
        workspace,
        method: 'POST',
        body: {
          request_id: acceptanceRequest.current,
          customer_id: customer,
          candidate_version: candidate.version,
          mode,
          ...(mode === 'new' ? { assign_to_me: true } : {}),
          ...(mode === 'link'
            ? { prospect_id: chosen!.id, prospect_version: chosen!.version }
            : {}),
          title: candidate.title,
          summary: candidate.summary,
          requirements: candidate.requirements,
        },
      });
      if (!alive.current) return;
      callbacks.current.onDirty?.(false);
      callbacks.current.onBusy?.(false);
      onCreated(result.prospect.id);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  return (
    <div className="connection-form prospect-intake">
      <p className="muted">
        先选择客户和已归档材料，AI整理后由你确认新建或关联询盘。未知归属的来信请先完成客户关联。
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!candidate ? (
        <>
          {!customerId && (
            <label>
              查找客户
              <input
                value={query}
                disabled={Boolean(busy)}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCustomerPage(1);
                }}
                placeholder="客户名称"
              />
            </label>
          )}
          <label>
            客户
            <select
              value={customer}
              disabled={Boolean(customerId || busy)}
              onChange={(e) => {
                setCustomer(e.target.value);
                setSelected([]);
                generationRequest.current = null;
              }}
            >
              <option value="">请选择客户</option>
              {customerId && !customers.some((v) => v.id === customerId) && (
                <option value={customerId}>当前已选客户</option>
              )}
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {!customerId && customerMore && (
            <button
              className="text-button"
              disabled={Boolean(busy)}
              onClick={() => setCustomerPage((n) => n + 1)}
            >
              加载更多客户
            </button>
          )}
          <fieldset disabled={Boolean(busy)}>
            <legend>本次材料 · 已选 {selected.length} 份，最多20份</legend>
            {sourceRows.map((s) => (
              <label key={s.record_id} style={{ display: 'block', marginBottom: 10 }}>
                <span>
                  <input
                    type="checkbox"
                    style={{ width: 'auto', marginRight: 6 }}
                    disabled={selected.length >= 20 && !selected.includes(s.record_id)}
                    checked={selected.includes(s.record_id)}
                    onChange={(e) => {
                      setSelected((old) =>
                        e.target.checked
                          ? [...old, s.record_id]
                          : old.filter((id) => id !== s.record_id),
                      );
                      generationRequest.current = null;
                    }}
                  />{' '}
                  {s.title || '业务原文'}
                </span>
                <small style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
                  {s.quote.slice(0, 260)}
                </small>
              </label>
            ))}
            {customer && !loading && !sourceRows.length && (
              <p className="muted">当前范围没有可用的已归档原文。请先关联客户并保存来源。</p>
            )}
            {hasMore && (
              <button disabled={loading} onClick={() => void loadMore()}>
                {loading ? '正在加载…' : '加载更多材料'}
              </button>
            )}
          </fieldset>
          <label>
            整理要求（可选）
            <textarea
              value={instruction}
              maxLength={2000}
              disabled={Boolean(busy)}
              onChange={(e) => {
                setInstruction(e.target.value);
                generationRequest.current = null;
              }}
              placeholder="例如：区分客户已明确的需求和还要问清的问题"
            />
          </label>
          <div className="form-actions">
            <button disabled={Boolean(busy)} onClick={close}>
              取消
            </button>
            <button
              className="primary"
              disabled={!customer || !selected.length || Boolean(busy) || loading}
              onClick={() => void generate()}
            >
              <Sparkles size={14} />
              {busy === 'generate' ? '正在整理…' : 'AI整理录入建议'}
            </button>
            {busy === 'generate' && (
              <button onClick={() => controller.current?.abort()}>停止整理</button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            以下是录入建议，尚未新建或修改询盘。核对原文后可编辑；待补充和未做事项均从“待补充”开始。
          </p>
          <label>
            建议询盘名称（关联时保留原名称）
            <input
              value={candidate.title}
              maxLength={120}
              disabled={Boolean(busy) || mode === 'link'}
              onChange={(e) => edited({ ...candidate, title: e.target.value })}
            />
          </label>
          <label>
            需求与当前认识
            <textarea
              value={candidate.summary}
              maxLength={6000}
              rows={5}
              disabled={Boolean(busy)}
              onChange={(e) => edited({ ...candidate, summary: e.target.value })}
            />
          </label>
          <fieldset disabled={Boolean(busy)}>
            <legend>待补充／待处理事项</legend>
            {candidate.requirements.map((r) => (
              <div key={r.id} style={{ marginBottom: 12 }}>
                <label>
                  {r.kind === 'missing' ? '待确认的信息' : '尚未完成的动作'}
                  <input
                    value={r.title}
                    maxLength={296}
                    onChange={(e) =>
                      edited({
                        ...candidate,
                        requirements: candidate.requirements.map((v) =>
                          v.id === r.id ? { ...v, title: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </label>
                {r.quote && <blockquote style={{ margin: '6px 0' }}>{r.quote}</blockquote>}
                <button
                  className="text-button"
                  onClick={() =>
                    edited({
                      ...candidate,
                      requirements: candidate.requirements.filter((v) => v.id !== r.id),
                    })
                  }
                >
                  <Trash2 size={12} />
                  移除此建议
                </button>
              </div>
            ))}
            {!candidate.requirements.length && <p className="muted">没有建议的未完成事项。</p>}
          </fieldset>
          <details>
            <summary>本次引用原文 · {candidate.source_refs.length} 份</summary>
            {candidate.source_refs.map((r) => (
              <p key={r.record_id}>{r.title || '业务原文'}</p>
            ))}
          </details>
          <label>
            录入方式
            <select
              value={mode}
              disabled={Boolean(busy)}
              onChange={(e) => {
                setMode(e.target.value as 'new' | 'link');
                acceptanceRequest.current = null;
              }}
            >
              <option value="new">新建一笔询盘</option>
              <option value="link">关联本客户已有询盘</option>
            </select>
          </label>
          {mode === 'link' && (
            <label>
              已有询盘
              <select
                value={target}
                disabled={Boolean(busy)}
                onChange={(e) => {
                  setTarget(e.target.value);
                  acceptanceRequest.current = null;
                }}
              >
                <option value="">请选择已有询盘</option>
                {targets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted">
            {mode === 'new'
              ? '确认后建立新咨询，由本人负责跟进（之后可在详情修改），并保留所选原文引用。'
              : '确认后追加摘要、原文引用和待办事项，保留原阶段、已有事项状态及负责人。'}
          </p>
          <div className="form-actions">
            <button disabled={Boolean(busy)} onClick={close}>
              取消
            </button>
            <button
              disabled={Boolean(busy)}
              onClick={() => {
                if (window.confirm('返回会放弃本次编辑，原始材料和整理要求仍会保留。')) {
                  setCandidate(null);
                  generationRequest.current = null;
                }
              }}
            >
              返回选择材料
            </button>
            <button
              className="primary"
              disabled={
                Boolean(busy) ||
                !candidate.title.trim() ||
                !candidate.summary.trim() ||
                candidate.requirements.some((r) => !r.title.trim()) ||
                (mode === 'link' && !target)
              }
              onClick={() => void accept()}
            >
              {busy === 'accept' ? '正在录入…' : '确认录入'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ProspectIntake(props: ProspectIntakeProps) {
  const identity = [
    props.workspace,
    props.customerId || '',
    props.sourceKind || '',
    props.sourceId || '',
    ...(props.sourceRecordIds || []),
  ].join(':');
  return <ProspectIntakeEditor key={identity} {...props} />;
}
