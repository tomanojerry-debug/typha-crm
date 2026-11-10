import { useEffect, useRef, useState } from 'react';
import { Plus, UserRound, X } from 'lucide-react';
import { PersonRecord } from './PersonRecord';
import { MailComposer } from './MailComposer';
import { api, transientReadFailure } from './api';
import type { Customer, Person } from '../shared/domain';
import type { CustomerList, PeopleList } from '../shared/views';
import type { Selection } from './Workbench';
export function PersonForm({
  workspace,
  value,
  customer,
  onClose,
  onSaved,
}: {
  workspace: string;
  value?: Person;
  customer?: { id: string; name: string };
  onClose: () => void;
  onSaved: (p: Person) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [customerId, setCustomerId] = useState(value?.customer_id || customer?.id || '');
  const [query, setQuery] = useState(''),
    [rows, setRows] = useState<Customer[]>([]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const el = ref.current!;
    const prev = document.activeElement as HTMLElement;
    el.showModal();
    return () => {
      el.close();
      if (prev?.isConnected) prev.focus();
    };
  }, []);
  useEffect(() => {
    if (value || customer) return;
    const c = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api<CustomerList>(
        `/customers?editable=true&q=${encodeURIComponent(query)}&sort=name&direction=asc`,
        { workspace, signal: c.signal },
      )
        .then((r) => {
          setRows(r.items);
          setLoading(false);
        })
        .catch((e) => {
          if (e.name !== 'AbortError') {
            setError(e.message);
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [query, workspace, value, customer]);
  return (
    <dialog
      ref={ref}
      className="modal person-form"
      aria-label={value ? '编辑联系人' : '新建记录 · 联系人'}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>{value ? '编辑联系人' : '新建记录 · 联系人'}</h2>
        <button className="icon-button" aria-label="关闭弹窗" disabled={busy} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <form
        autoComplete="off"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          const f = new FormData(e.currentTarget);
          const body = Object.fromEntries(f.entries());
          const companyName = String(f.get('customer_name') ?? '').trim();
          delete body.customer_name;
          try {
            const saved = await api<Person>(value ? `/people/${value.id}` : '/people', {
              workspace,
              method: value ? 'PATCH' : 'POST',
              body: {
                ...body,
                ...(value ? { version: value.version } : { customer_id: customerId }),
                ...(value && companyName !== value.customer_name
                  ? { customer_name: companyName, customer_version: value.customer_version }
                  : {}),
              },
            });
            onSaved(saved);
          } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-fields">
          <label>
            公司 / 客户
            {value ? (
              <>
                <input
                  name="customer_name"
                  required
                  maxLength={120}
                  defaultValue={value.customer_name}
                  aria-describedby="person-company-help"
                />
                <small id="person-company-help">修改名称会同步更新公司档案。</small>
              </>
            ) : customer ? (
              <input readOnly value={customer.name} />
            ) : (
              <>
                <input
                  aria-label="搜索关联公司或客户"
                  placeholder="搜索已有公司或客户…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  aria-label="关联公司或客户"
                  required
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                >
                  <option value="">{loading ? '正在加载…' : '选择公司 / 客户'}</option>
                  {rows.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </label>
          <label>
            姓名
            <input name="name" required maxLength={200} defaultValue={value?.name} />
          </label>
          <label>
            职位
            <input
              name="job_title"
              maxLength={200}
              defaultValue={value?.job_title}
              placeholder="例如：采购负责人"
            />
          </label>
          <div className="person-form-pair">
            <label>
              邮箱
              <input name="email" type="email" maxLength={254} defaultValue={value?.email} />
            </label>
            <label>
              电话
              <input name="phone" maxLength={60} defaultValue={value?.phone} />
            </label>
          </div>
          <label>
            备注
            <textarea
              name="description"
              maxLength={5000}
              defaultValue={value?.description}
              rows={3}
            />
          </label>
          <p>联系人沿用所属公司 / 客户的访问权限。</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="form-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !customerId}>
            {busy ? '保存中…' : '保存记录'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
export function PersonDetail({
  id,
  workspace,
  refresh,
  onSelect,
  notify,
}: {
  id: string;
  workspace: string;
  refresh: number;
  onSelect: (s: Selection) => void;
  notify: (m: string) => void;
}) {
  const [person, setPerson] = useState<Person | null>(null),
    [reload, setReload] = useState(0),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false),
    [compose, setCompose] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    // Refresh in place so the selected detail tab stays open.
    setPerson((current) =>
      current?.id === id && current.workspace_id === workspace ? current : null,
    );
    setError('');
    api<Person>(`/people/${id}`, { workspace, signal: c.signal })
      .then((value) => {
        if (!c.signal.aborted) setPerson(value);
      })
      .catch((e) => {
        if (!c.signal.aborted && e.name !== 'AbortError') {
          if (!transientReadFailure(e)) setPerson(null);
          setError(e.message);
        }
      });
    return () => c.abort();
  }, [id, workspace, refresh, reload]);
  if (!person || person.id !== id || person.workspace_id !== workspace)
    return (
      <div className="detail-loading">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          '正在加载联系人…'
        )}
      </div>
    );
  return (
    <PersonRecord
      key={`${workspace}:${person.id}`}
      person={person}
      workspace={workspace}
      refresh={refresh + reload}
      onRefresh={() => setReload((n) => n + 1)}
      busy={busy}
      error={error}
      onSelect={onSelect}
      onEdit={() => setEditing(true)}
      onCompose={(draftId) => setCompose(draftId || 'new')}
      onArchive={async () => {
        setBusy(true);
        setError('');
        try {
          const saved = await api<Person>(`/people/${id}`, {
            workspace,
            method: 'PATCH',
            body: { version: person.version, archived: !person.archived_at },
          });
          setPerson(saved);
          notify(person.archived_at ? '联系人已恢复' : '联系人已归档');
        } catch (e) {
          setError(e instanceof Error ? e.message : '操作失败');
        } finally {
          setBusy(false);
        }
      }}
    >
      {compose && (
        <MailComposer
          key={`${workspace}:${person.id}:${compose}`}
          workspace={workspace}
          person={person}
          draftId={compose === 'new' ? undefined : compose}
          onClose={() => setCompose(null)}
          onChanged={() => setReload((n) => n + 1)}
        />
      )}
      {editing && (
        <PersonForm
          workspace={workspace}
          value={person}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setPerson(saved);
            notify('联系人已保存');
          }}
        />
      )}
    </PersonRecord>
  );
}
export function CompanyPeople({
  customer,
  workspace,
  refresh,
  onSelect,
  notify,
}: {
  customer: Customer;
  workspace: string;
  refresh: number;
  onSelect: (s: Selection) => void;
  notify: (m: string) => void;
}) {
  const [rows, setRows] = useState<Person[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(1),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError('');
    api<PeopleList>(
      `/people?customer_id=${customer.id}&sort=name&direction=asc&page=${page}&archived=${!!customer.archived_at}`,
      { workspace, signal: c.signal },
    )
      .then((r) => {
        setRows(r.items);
        setTotal(r.total);
        setLoading(false);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => c.abort();
  }, [customer.id, customer.archived_at, workspace, refresh, page]);
  return (
    <>
      <div className="section-heading">
        <h2>
          联系人 <small>{total}</small>
        </h2>
        {customer.can_edit && !customer.archived_at && (
          <button aria-label="新建记录 · 联系人" onClick={() => setCreating(true)}>
            <Plus size={14} />
            新建记录
          </button>
        )}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="muted">正在加载…</p>
      ) : (
        <>
          <div className="company-people-list">
            {rows.map((p) => (
              <button
                key={p.id}
                onClick={() => onSelect({ customerId: customer.id, personId: p.id, full: true })}
              >
                <UserRound size={16} />
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.job_title || '职位未填写'}</small>
                </span>
                <span>{p.email || p.phone || '联系方式未填写'}</span>
                <span>→</span>
              </button>
            ))}
          </div>
          {!rows.length && <p className="muted">还没有联系人。</p>}
          {total > 30 && (
            <div className="table-footer">
              <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <span>
                {page} / {Math.ceil(total / 30)}
              </span>
              <button disabled={page * 30 >= total} onClick={() => setPage((p) => p + 1)}>
                下一页
              </button>
            </div>
          )}
        </>
      )}
      {creating && (
        <PersonForm
          workspace={workspace}
          customer={customer}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            notify('联系人已创建');
          }}
        />
      )}
    </>
  );
}
