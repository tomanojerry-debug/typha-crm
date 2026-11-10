import { useEffect, useState } from 'react';
import { api } from './api';
import type {
  CustomerList,
  ProjectList,
  RecordList,
  ProjectRow,
  PeopleList,
  RecordRow,
} from '../shared/views';
import { listEntry } from '../shared/views';
export function ListRecordPicker({
  list,
  workspace,
  onDone,
  onClose,
}: {
  list: RecordList;
  workspace: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [selected, setSelected] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      api<CustomerList | ProjectList | PeopleList>(
        `/${list.object}?q=${encodeURIComponent(query)}&sort=name&direction=asc`,
        { workspace, signal: controller.signal },
      )
        .then((result) => {
          setRows(result.items);
          setLoading(false);
          setError('');
        })
        .catch((e) => {
          if (e.name !== 'AbortError') {
            setError(e.message);
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, list.object, workspace]);
  async function add() {
    setBusy(true);
    setError('');
    try {
      await api(`/lists/${list.id}/entries`, {
        workspace,
        method: 'POST',
        body: {
          entries: selected.map(listEntry),
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="list-picker">
        <p>将已有记录加入「{list.name}」。记录可以同时属于多个清单。</p>
        <input
          autoFocus
          aria-label="搜索要加入清单的记录"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={100}
          placeholder="搜索记录名称…"
        />
        <div className="list-picker-results">
          {loading ? (
            <p>正在加载…</p>
          ) : rows.length ? (
            rows.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={selected.some((s) => s.id === r.id)}
                  onChange={(e) =>
                    setSelected((prev) =>
                      e.target.checked ? [...prev, r] : prev.filter((s) => s.id !== r.id),
                    )
                  }
                />
                <span>
                  {r.name}
                  {'customer_id' in r && <small>{r.customer_name}</small>}
                </span>
              </label>
            ))
          ) : (
            <p>没有符合条件的记录。</p>
          )}
        </div>
        <small>最多显示 30 条，可搜索其他记录；重复添加不会复制原记录。</small>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className="form-footer">
        <span>已选择 {selected.length} 条</span>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary" disabled={busy || !selected.length} onClick={() => void add()}>
          {busy ? '添加中…' : '添加到清单'}
        </button>
      </footer>
    </>
  );
}
