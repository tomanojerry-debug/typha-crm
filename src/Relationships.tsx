import { useEffect, useState } from 'react';
import { Building2, Plus, Unlink } from 'lucide-react';
import { api } from './api';
import {
  cardinalities,
  objectNames,
  type ObjectKind,
  type RelatedRecord,
  type RelationDefinition,
} from '../shared/connections';
import type { Selection } from './Workbench';
import './connections.css';
export function RecordRelations({
  workspace,
  customerId,
  object,
  id,
  editable,
  onSelect,
}: {
  workspace: string;
  customerId: string;
  object: ObjectKind;
  id: string;
  editable: boolean;
  onSelect: (s: Selection) => void;
}) {
  const [data, setData] = useState<{
      definitions: RelationDefinition[];
      items: RelatedRecord[];
    } | null>(null),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0),
    [adding, setAdding] = useState(false),
    [choice, setChoice] = useState(''),
    [query, setQuery] = useState(''),
    [target, setTarget] = useState(''),
    [candidates, setCandidates] = useState<{ id: string; name: string }[]>([]),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    api<typeof data>(`/relationships/records/${object}/${id}`, { workspace, signal: c.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, [workspace, object, id, refresh]);
  const choices =
    data?.definitions.flatMap((d) => [
      ...(d.source_object === object
        ? [
            {
              value: `${d.id}:source`,
              label: d.source_label,
              object: d.target_object,
              d,
              side: 'source',
            },
          ]
        : []),
      ...(d.target_object === object
        ? [
            {
              value: `${d.id}:target`,
              label: d.target_label,
              object: d.source_object,
              d,
              side: 'target',
            },
          ]
        : []),
    ]) || [];
  const selected = choices.find((c) => c.value === choice);
  useEffect(() => {
    setCandidates([]);
    setTarget('');
    if (!selected || !adding) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      api<{ id: string; name: string }[]>(
        `/customers/${customerId}/relationship-candidates?object=${selected.object}&q=${encodeURIComponent(query)}`,
        { workspace, signal: c.signal },
      )
        .then(setCandidates)
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    }, 150);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [workspace, customerId, selected?.object, choice, query, adding]);
  function open(object: ObjectKind, id: string) {
    onSelect({
      customerId,
      ...(object === 'people' ? { personId: id } : object === 'projects' ? { projectId: id } : {}),
      full: true,
    });
  }
  return (
    <section className="record-relations">
      <div className="section-heading">
        <div>
          <h2>关联记录</h2>
          <p className="muted">从任一端维护，另一端同步显示。</p>
        </div>
        {editable && choices.length > 0 && (
          <button
            onClick={() => {
              setAdding(!adding);
              setChoice(choices[0].value);
            }}
          >
            <Plus size={14} />
            添加关联
          </button>
        )}
      </div>
      <div className="builtin-links">
        <Building2 size={16} />
        {object === 'customers' ? (
          <>
            <button onClick={() => onSelect({ customerId, customerTab: 'people', full: true })}>
              查看公司联系人 →
            </button>
            <button onClick={() => onSelect({ customerId, customerTab: 'projects', full: true })}>
              查看公司项目 →
            </button>
          </>
        ) : (
          <button onClick={() => open('customers', customerId)}>查看所属公司 →</button>
        )}
        <small>系统归属</small>
      </div>
      {adding && (
        <form
          className="connection-form compact"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!selected) return;
            setBusy(true);
            setError('');
            try {
              await api('/relationship-edges', {
                workspace,
                method: 'POST',
                body: {
                  definition_id: selected.d.id,
                  source_id: selected.side === 'source' ? id : target,
                  target_id: selected.side === 'source' ? target : id,
                },
              });
              setAdding(false);
              setRefresh((x) => x + 1);
            } catch (e) {
              setError(e instanceof Error ? e.message : '添加失败');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            关系
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label} · {objectNames[c.object]}
                </option>
              ))}
            </select>
          </label>
          <label>
            搜索记录
            <input
              placeholder="搜索同一客户下的记录…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            关联到
            <select required value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">选择记录</option>
              {candidates
                .filter((c) => c.id !== id || selected?.object !== object)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="connection-actions">
            <button type="button" onClick={() => setAdding(false)}>
              取消
            </button>
            <button disabled={busy || !target} className="primary">
              添加关联
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data ? (
        <p className="muted">正在加载关联…</p>
      ) : (
        choices.map((c) => (
          <div className="relation-group" key={c.value}>
            <h3>
              {c.label}
              <small>{cardinalities[c.d.cardinality]}</small>
            </h3>
            {data.items
              .filter((r) => r.definition_id === c.d.id && r.side === c.side)
              .map((r) => (
                <div className="related-row" key={r.edge_id}>
                  <button onClick={() => open(r.object, r.id)}>
                    <span className="record-icon">{objectNames[r.object].slice(0, 1)}</span>
                    <strong>{r.name}</strong>
                    {r.archived_at && <small>已归档</small>}
                    <span>→</span>
                  </button>
                  {editable && (
                    <button
                      className="icon-button"
                      aria-label={`移除 ${r.name} 的${c.label}关联`}
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          await api(`/relationship-edges/${r.edge_id}`, {
                            workspace,
                            method: 'DELETE',
                            body: {},
                          });
                          setRefresh((x) => x + 1);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : '移除失败');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Unlink size={14} />
                    </button>
                  )}
                </div>
              ))}
            {!data.items.some((r) => r.definition_id === c.d.id && r.side === c.side) && (
              <p className="muted">暂无关联</p>
            )}
          </div>
        ))
      )}
      {data && !choices.length && (
        <p className="overview-empty">管理员可在“实体与关系”中为此对象创建新的关联类型。</p>
      )}
    </section>
  );
}
