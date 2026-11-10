import { useEffect, useState } from 'react';
import { api } from './api';
import { Dialog } from './WorkspaceUI';
import type { Customer, Person, Project } from '../shared/domain';
import type { WeChatPreview } from '../shared/wechat';
import './wechat.css';
const date = (v: string) =>
  new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function WeChatReviewDialog({
  preview,
  workspace,
  onClose,
  onAssociated,
}: {
  preview: WeChatPreview;
  workspace: string;
  onClose: () => void;
  onAssociated?: (p: WeChatPreview) => void;
}) {
  const [data, setData] = useState(preview),
    [customers, setCustomers] = useState<Customer[]>([]),
    [customer, setCustomer] = useState(''),
    [people, setPeople] = useState<Person[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [person, setPerson] = useState(''),
    [project, setProject] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (data.state === 'associated') return;
    const controller = new AbortController();
    api<{ items: Customer[] }>('/customers?editable=true&page=1', {
      workspace,
      signal: controller.signal,
    })
      .then((r) => setCustomers(r.items.filter((c) => !c.archived_at)))
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [workspace, data.state]);
  useEffect(() => {
    setPeople([]);
    setProjects([]);
    setPerson('');
    setProject('');
    if (!customer) return;
    const controller = new AbortController();
    Promise.all([
      api<{ items: Person[] }>(`/people?customer_id=${customer}`, {
        workspace,
        signal: controller.signal,
      }),
      api<Project[]>(`/customers/${customer}/projects`, { workspace, signal: controller.signal }),
    ])
      .then(([p, j]) => {
        setPeople(p.items.filter((v) => !v.archived_at));
        setProjects(j.filter((v) => !v.archived_at));
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [workspace, customer]);
  return (
    <Dialog
      title={data.state === 'associated' ? '微信归档信息' : '关联微信对话归属'}
      onClose={onClose}
      className="wechat-review-dialog"
    >
      <div className="wechat-preview-heading">
        <strong>{data.identity.remark || data.identity.name}</strong>
        <span>
          {data.start} 至 {data.end} · 北京时间 · {data.message_count} 条文字
        </span>
      </div>
      {data.warnings.map((warning) => (
        <p className="wechat-note" key={warning}>
          {warning}
        </p>
      ))}
      {!data.message_count && <p className="wechat-note">指定日期内没有可整理的文字消息。</p>}
      {data.state === 'associated' ? (
        <p role="status" className="connection-notice">
          本次文字已归档为 {data.record_count || 1}{' '}
          条业务记录，完整保留说话人、时间和原文来源，可供客户授权成员检索。新文字会在下次读取时按客户及联系人归属自动整理；项目仅作用于本次，不沿用到后续对话。客户原话及本方发言不代表公司正式确认。
        </p>
      ) : (
        <form
          className="connection-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              const next = await api<WeChatPreview>(`/wechat/queries/${data.id}/associate`, {
                workspace,
                method: 'POST',
                body: {
                  customer_id: customer,
                  person_id: person || null,
                  project_id: project || null,
                },
              });
              setData(next);
              onAssociated?.(next);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="wechat-note">
            文字已整理在本人待关联区。选择一次档案归属后，本次全部文字和以后读取到的此对话文字会自动归档，不需要逐条核对；已有记录不会重复保存。项目只关联本次文字，后续默认保存在客户层级。
          </p>
          <label>
            公司 / 客户
            <select
              required
              value={customer}
              onChange={(event) => setCustomer(event.target.value)}
              disabled={busy}
            >
              <option value="">选择已有客户</option>
              {customers.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="wechat-field-pair">
            <label>
              联系人（可选）
              <select
                value={person}
                onChange={(event) => setPerson(event.target.value)}
                disabled={!customer || busy}
              >
                <option value="">仅关联客户</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              项目（可选，仅本次）
              <select
                value={project}
                onChange={(event) => setProject(event.target.value)}
                disabled={!customer || busy}
              >
                <option value="">客户层级，不指定项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <footer className="form-footer">
            <button type="button" onClick={onClose}>
              稍后关联
            </button>
            <button className="primary" disabled={busy || !customer || !data.message_count}>
              {busy ? '正在归档…' : '关联对话并自动归档'}
            </button>
          </footer>
        </form>
      )}
      <details className="wechat-original">
        <summary>查看本次读取的完整文字</summary>
        {data.messages.map((message) => (
          <article key={message.id}>
            <small>
              {date(message.at)} · {message.speaker}
            </small>
            <p>{message.text}</p>
          </article>
        ))}
      </details>
    </Dialog>
  );
}
