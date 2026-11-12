import { useEffect, useState } from 'react';
import type { MailAccount } from '../shared/connections';
import type { Member } from '../shared/domain';
import { api } from './api';

type Mailbox = Pick<MailAccount, 'id' | 'email' | 'enabled'>;
type SenderGrant = { actor_id: string };
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
const eligible = (member: Member) =>
  member.role === 'member' && member.active && member.workspace_mode !== 'tasks';

export function MailboxSenderPermissions({
  workspace,
  members,
  readOnly,
}: {
  workspace: string;
  members: Member[];
  readOnly: boolean;
}) {
  const [accounts, setAccounts] = useState<Mailbox[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const account = accounts?.find((candidate) => candidate.id === accountId);

  useEffect(() => {
    const controller = new AbortController();
    setAccounts(null);
    setError('');
    api<Mailbox[]>('/mail/accounts', { workspace, signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setAccounts(rows);
          setAccountId((current) =>
            rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? ''),
          );
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [workspace, revision]);

  return (
    <>
      <h4>共享邮箱发信</h4>
      <p className="personal-settings-description">
        成员需要同时拥有该客户的编辑权和此邮箱的发信权。邮箱收件仍按原有权限访问。
      </p>
      {error ? (
        <div className="ba-alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            重新读取邮箱
          </button>
        </div>
      ) : !accounts ? (
        <p className="ba-empty" role="status">
          正在读取邮箱…
        </p>
      ) : accounts.length === 0 ? (
        <p className="ba-empty">请先在「邮件管理 → 邮箱设置」连接邮箱。</p>
      ) : (
        <>
          <label className="field team-settings-mailbox">
            <span>发件邮箱</span>
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              disabled={saving}
            >
              {accounts.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.email}
                  {candidate.enabled ? '' : ' · 已停用'}
                </option>
              ))}
            </select>
          </label>
          {account && (
            <MailboxSenderList
              key={account.id}
              account={account}
              members={members}
              workspace={workspace}
              onSaving={setSaving}
              readOnly={readOnly}
            />
          )}
        </>
      )}
    </>
  );
}

function MailboxSenderList({
  account,
  members,
  workspace,
  onSaving,
  readOnly,
}: {
  account: Mailbox;
  members: Member[];
  workspace: string;
  onSaving: (busy: boolean) => void;
  readOnly: boolean;
}) {
  const [grants, setGrants] = useState<SenderGrant[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const path = `/mail-accounts/${account.id}/senders`;
  const allowedIds = new Set(grants?.map((grant) => grant.actor_id));
  const rows = members.filter((member) => eligible(member) || allowedIds.has(member.actor_id));

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<SenderGrant[]>(path, { workspace, signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setGrants(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [path, workspace, revision]);

  async function change(member: Member, allowed: boolean) {
    if (busy || (allowed && (!account.enabled || !eligible(member)))) return;
    setBusy(true);
    onSaving(true);
    setError('');
    setNotice('');
    try {
      await api(`${path}/${member.actor_id}`, { workspace, method: 'PUT', body: { allowed } });
      setGrants((previous) => {
        const next = (previous || []).filter((grant) => grant.actor_id !== member.actor_id);
        if (allowed) next.push({ actor_id: member.actor_id });
        return next;
      });
      setNotice(allowed ? '发信权限已授予。' : '发信权限已撤销。');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      onSaving(false);
    }
  }

  return (
    <>
      {notice && (
        <p className="ba-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="ba-alert" role="alert">
          {error}
        </p>
      )}
      {!grants ? (
        error ? (
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            重新读取发信权限
          </button>
        ) : (
          <p className="ba-empty" role="status">
            正在读取发信权限…
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="ba-empty">暂无可授权的客户工作台成员。</p>
      ) : (
        <ul className="team-settings-list" aria-label="邮箱发信成员">
          {rows.map((member) => {
            const allowed = allowedIds.has(member.actor_id);
            return (
              <li className="team-settings-row" key={member.actor_id}>
                <div className="team-settings-person">
                  <strong>{member.display_name}</strong>
                  <span>{member.active ? member.email : '成员已停用'}</span>
                </div>
                {(allowed || readOnly) && (
                  <span className="ba-tag">{allowed ? '已授权' : '未授权'}</span>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    disabled={busy || (!allowed && !account.enabled)}
                    aria-label={`${allowed ? '撤销' : '授予'} ${member.display_name} 的发信权限`}
                    onClick={() => void change(member, !allowed)}
                  >
                    {allowed ? '撤销发信权限' : '授权发信'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
