import type { ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  ChevronRight,
  FileText,
  Folder,
  Mail,
  Search,
  UserRound,
  UsersRound,
} from 'lucide-react';
import type { AskSource } from '../shared/ask';
import type { ChatRetrieval } from '../shared/chat-intent';
import { AgentAnswer } from './AgentAnswer';
import {
  agentDirectoryCompany,
  agentListedCustomerItems,
  agentListedCustomerSummary,
  agentRecordDisplayBody,
  agentSourceKey,
  uniqueAgentSources,
} from './agent-reply-card-data';
import './agent-reply-cards.css';

export type AgentCardAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
};

export function AgentReplyCard({
  title,
  typeLabel,
  icon,
  fields = [],
  description,
  footer,
  action,
  secondaryAction,
  state,
  children,
  className = '',
}: {
  title: string;
  typeLabel: string;
  icon: ReactNode;
  fields?: { label: string; value: ReactNode }[];
  description?: string;
  footer: ReactNode;
  action?: AgentCardAction;
  secondaryAction?: AgentCardAction;
  state?: { label: string; description: string };
  children?: ReactNode;
  className?: string;
}) {
  const renderAction = (value: AgentCardAction, secondary = false) => (
    <button
      type="button"
      className={`agent-card-action${value.primary ? ' is-primary' : ''}${secondary ? ' is-secondary' : ''}`}
      disabled={value.disabled}
      onClick={value.onClick}
    >
      {value.label}
      {value.primary ? <ArrowRight size={14} /> : <ArrowUpRight size={13} />}
    </button>
  );
  return (
    <section className={`agent-reply-card ${className}`} aria-label={`${typeLabel}：${title}`}>
      <header className="agent-card-heading">
        <span className="agent-card-avatar" aria-hidden="true">
          {icon}
        </span>
        <div className="agent-card-identity">
          <strong>{title}</strong>
          <span>{typeLabel}</span>
        </div>
      </header>
      {(fields.length > 0 || description || children) && (
        <div className="agent-card-body">
          {fields.length > 0 && (
            <dl className="agent-card-fields">
              {fields.map((field, index) => (
                <div key={`${field.label}:${index}`}>
                  <dt>{field.label}</dt>
                  <dd>{typeof field.value === 'boolean' ? String(field.value) : field.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {description && <p className="agent-card-description">{description}</p>}
          {children}
        </div>
      )}
      <footer className="agent-card-footer">
        <div className="agent-card-provenance">{footer}</div>
        {(action || secondaryAction || state) && (
          <div className="agent-card-actions">
            {state && (
              <span
                className="agent-card-state"
                role="status"
                title={state.description}
                aria-label={state.description}
              >
                {state.label}
              </span>
            )}
            {secondaryAction && renderAction(secondaryAction, true)}
            {action && renderAction(action)}
          </div>
        )}
      </footer>
    </section>
  );
}

function sourcePresentation(source: AskSource) {
  if (source.kind === 'mail') return { type: '邮件', origin: '来自邮件记录', Icon: Mail };
  if (source.kind === 'record') return { type: '业务记录', origin: '来自原始记录', Icon: FileText };
  if (source.object === 'people')
    return { type: '联系人', origin: '来自联系人目录', Icon: UserRound };
  if (source.object === 'projects') return { type: '项目', origin: '来自项目目录', Icon: Folder };
  if (source.object === 'customers')
    return { type: '公司', origin: '来自公司目录', Icon: Building2 };
  return { type: '档案记录', origin: '来自授权档案', Icon: FileText };
}

function sourceAvatar(source: AskSource) {
  const { Icon } = sourcePresentation(source);
  const initial =
    source.kind === 'entity' && source.object === 'people'
      ? Array.from(source.title.trim())[0]
      : undefined;
  return initial && /[\p{L}\p{N}]/u.test(initial) ? (
    <span className="agent-card-initial">{initial}</span>
  ) : (
    <Icon size={19} strokeWidth={1.6} />
  );
}

export function AgentSourceCard({
  source,
  action,
  secondaryAction,
  ordinal,
  hideDescription = false,
  allowLegacyDirectory = false,
  state,
}: {
  source: AskSource;
  action?: AgentCardAction;
  secondaryAction?: AgentCardAction;
  ordinal?: number;
  hideDescription?: boolean;
  allowLegacyDirectory?: boolean;
  state?: { label: string; description: string };
}) {
  const { type, origin } = sourcePresentation(source);
  const company = agentDirectoryCompany(source, allowLegacyDirectory);
  const directoryDescription =
    allowLegacyDirectory &&
    source.kind === 'entity' &&
    source.description.startsWith(`候选目录 · ${type}`);
  const description =
    hideDescription || directoryDescription
      ? ''
      : agentRecordDisplayBody(source.description, source).trim();
  const redundantDescription = [source.title, type, `${type}档案`, `${type}资料`].includes(
    description,
  );
  return (
    <AgentReplyCard
      title={source.title}
      typeLabel={ordinal ? `${type} · 候选 ${ordinal}` : type}
      icon={sourceAvatar(source)}
      fields={[
        ...(company ? [{ label: '所属公司', value: company }] : []),
        ...(source.directory_fields || []),
      ]}
      description={redundantDescription ? undefined : description}
      footer={origin}
      action={action}
      secondaryAction={secondaryAction}
      state={state}
    />
  );
}

export function AgentReplySources({
  sources,
  exclude = [],
  onOpen,
  disabled = false,
  onCustomerChat,
  label = '回答依据',
}: {
  sources: AskSource[];
  exclude?: AskSource[];
  onOpen: (source: AskSource) => void;
  disabled?: boolean;
  onCustomerChat?: (source: AskSource) => void;
  label?: string;
}) {
  const items = uniqueAgentSources(sources, exclude);
  if (!items.length) return null;
  return (
    <details className="agent-reply-sources">
      <summary>
        <ChevronRight size={13} aria-hidden="true" />
        {label} · {items.length}
      </summary>
      <div className="agent-reply-card-list">
        {items.map((source) => (
          <AgentSourceCard
            key={agentSourceKey(source)}
            source={source}
            action={{
              label: source.kind === 'entity' ? '打开档案' : '查看原文',
              disabled,
              onClick: () => onOpen(source),
            }}
            secondaryAction={
              onCustomerChat
                ? { label: '就此客户提问', disabled, onClick: () => onCustomerChat(source) }
                : undefined
            }
          />
        ))}
      </div>
    </details>
  );
}

export function AgentRecordAnswerCard({
  source,
  body,
  onOpen,
  disabled = false,
}: {
  source?: AskSource;
  body: string;
  onOpen: (source: AskSource) => void;
  disabled?: boolean;
}) {
  const type = source ? sourcePresentation(source).type : '查询结果';
  return (
    <AgentReplyCard
      className="agent-record-answer"
      title={source?.title || '查询结果'}
      typeLabel={source ? `${type}资料` : '授权目录'}
      icon={source ? sourceAvatar(source) : <Search size={19} strokeWidth={1.6} />}
      footer="来自授权资料"
      action={source ? { label: '打开档案', disabled, onClick: () => onOpen(source) } : undefined}
    >
      <AgentAnswer body={source ? agentRecordDisplayBody(body, source) : body} fields />
    </AgentReplyCard>
  );
}

export function AgentListedCustomerCards({
  retrieval,
  onOpen,
  disabled = false,
}: {
  retrieval: ChatRetrieval;
  onOpen: (source: AskSource) => void;
  disabled?: boolean;
}) {
  if (retrieval.status !== 'listed') return null;
  const items = agentListedCustomerItems(retrieval);
  return (
    <div className="agent-candidate-result agent-customer-list-result">
      <p className="agent-candidate-heading">
        <Building2 size={15} aria-hidden="true" />
        {agentListedCustomerSummary(retrieval)}
      </p>
      {retrieval.total === 0 && <p>当前没有符合此范围的客户。</p>}
      <div className="agent-reply-card-list">
        {items.map((source) => (
          <AgentSourceCard
            key={agentSourceKey(source)}
            source={source}
            hideDescription
            action={{ label: '打开档案', disabled, onClick: () => onOpen(source) }}
          />
        ))}
      </div>
    </div>
  );
}

export function AgentCandidateCards({
  retrieval,
  busy,
  inactive,
  onSelect,
}: {
  retrieval: ChatRetrieval;
  busy: boolean;
  inactive: boolean;
  onSelect: (index: number) => void;
}) {
  const candidates = retrieval.candidates;
  const people = candidates.every((source) => source.object === 'people');
  const companies = candidates.every((source) => source.object === 'customers');
  const projects = candidates.every((source) => source.object === 'projects');
  const Icon = people ? UsersRound : companies ? Building2 : projects ? Folder : Search;
  const unit = people ? '位联系人' : companies ? '家公司' : projects ? '个项目' : '条记录';
  return (
    <div className="agent-candidate-result">
      <p className="agent-candidate-heading">
        <Icon size={15} aria-hidden="true" />
        找到 {retrieval.total} {unit}
        {retrieval.truncated && (
          <span className="agent-candidate-limit">仅显示前 10 项，可补充条件缩小范围</span>
        )}
      </p>
      <div className="agent-reply-card-list">
        {candidates.map((source, index) => (
          <AgentSourceCard
            key={`${agentSourceKey(source)}:${index}`}
            source={source}
            ordinal={candidates.length > 1 ? index + 1 : undefined}
            allowLegacyDirectory
            hideDescription={!!source.company_name || source.object === 'customers'}
            action={
              inactive
                ? undefined
                : {
                    label: '选择并继续',
                    disabled: busy,
                    primary: true,
                    onClick: () => onSelect(index + 1),
                  }
            }
            state={
              inactive
                ? { label: '历史候选', description: '此候选列表已结束，请使用最新查询结果。' }
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
