import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  FileText,
  Folder,
  Mail,
  MessageSquareText,
  PencilLine,
  Search,
  Upload,
  X,
} from 'lucide-react';
import {
  workflowLabels,
  type HomeWorkflow as Workflow,
  type WorkflowCandidate,
  type WorkflowConfig,
  type WorkflowKind,
  type WorkflowOptions,
  type WorkflowReplyResponse,
  type WorkflowFillOutcome,
  type WorkflowMailTemplate,
  type WorkflowTemplateChoice,
  type WorkflowTaskAction,
} from '../shared/home-workflows';
import { api } from './api';
import { customerTypes, customerStatuses, sources, type Member } from '../shared/domain';
import { WorkflowMailDraftCard, WorkflowMailTemplateCard } from './WorkflowMailCards';
import {
  isMailWorkflow,
  workflowDraftsAfterTemplateChoice,
  workflowEditorInitiallyOpen,
  workflowMailPresentation,
  workflowNeedsTemplate,
} from './workflow-mail-ui';
import { useWorkflowMailStatus } from './useWorkflowMailStatus';
import './home-workflow.css';

export type HomeWorkflowProps = {
  workspace: string;
  actorKey?: string;
  workflow: Workflow;
  members?: Member[];
  busy?: boolean;
  error?: string;
  templateWorkflows?: boolean;
  onWorkflow: (workflow: Workflow) => void;
  onRun: (
    workflow: Workflow,
    body: string,
    phase?: 'analyze' | 'draft',
    taskAction?: WorkflowTaskAction,
  ) => Promise<void>;
  onEditingChange?: (editing: boolean) => void;
  onCancel?: (workflow: Workflow) => void;
  onOpenMail: (response: WorkflowReplyResponse) => void;
  onRelated?: (kind: WorkflowKind, config: WorkflowConfig) => void;
  onUpload?: () => void;
  onReadWeChat?: () => void;
};

const stepLabels: Record<Workflow['step'], string> = {
  configure: '选择对象与资料',
  template: '待选择邮件模板',
  ready: '可以开始',
  decision: '待补充答复口径',
  review: '待确认资料变更',
  completed: '已完成',
  cancelled: '已取消',
};
const sourceLabels = { mail: '已有邮件', wechat: '已归档微信', pasted: '粘贴内容' };
const fillStatusLabels: Record<WorkflowFillOutcome['status'], string> = {
  filled: '已填写',
  missing: '无相关信息',
  conflict: '待核对冲突',
  preserved: '已有值保留',
  failed: '整理失败',
};
const defaultQuestions: Record<WorkflowKind, string> = {
  summary:
    '请总结所选范围的沟通信息，区分客户需求、已经明确的事项、变化或分歧、仍待确认的问题，并标明原文来源。',
  reply:
    '请处理这封客户来信，整理客户提出的问题、已有答复依据和需要我决定的事项；价格、交期等缺少依据时请明确列出。',
  compose: '请根据我的写信要求和已选模板生成一份可编辑的客户邮件草稿，缺乏依据的信息保持待确认。',
  update:
    '请根据所选资料检查客户已有字段，提出有依据的资料变更，区分客户诉求和公司确认；不要新增字段或直接修改现有值。',
};
const currentMailDraftRequest = '请按本次模板选择和已保存的要求生成当前邮件草稿';
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
const displayValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '未填写';
  if (Array.isArray(value)) return value.length ? value.map(displayValue).join('、') : '未填写';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};
const formatDate = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));

function dateRange(days: number) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { date_start: start.toISOString().slice(0, 10), date_end: today };
}

function rangePreset(config: WorkflowConfig) {
  if (!config.date_start && !config.date_end) return 'all';
  for (const days of [7, 30]) {
    const dates = dateRange(days);
    if (config.date_start === dates.date_start && config.date_end === dates.date_end)
      return String(days);
  }
  return 'custom';
}

export function HomeWorkflow(props: HomeWorkflowProps) {
  const { workflow, workspace } = props;
  const prefix = useId();
  const mounted = useRef(true);
  const currentWorkflow = useRef(workflow);
  currentWorkflow.current = workflow;
  const actionPending = useRef(false);
  const [config, setConfig] = useState<WorkflowConfig>(workflow.config);
  const [editing, setEditing] = useState(() => workflowEditorInitiallyOpen(workflow));
  const [inputStep, setInputStep] = useState<'target' | 'materials'>(() =>
    workflow.config.customer_id || workflow.config.document_id || workflow.config.material
      ? 'materials'
      : 'target',
  );
  const [scopeExpanded, setScopeExpanded] = useState(false);
  const guideHeading = useRef<HTMLHeadingElement>(null);
  const previousInputStep = useRef(inputStep);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<WorkflowCandidate[]>([]);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateError, setCandidateError] = useState('');
  const [searched, setSearched] = useState(false);
  const [selectedName, setSelectedName] = useState(
    workflow.person_name || workflow.customer_name || '',
  );
  const [selectedCompany, setSelectedCompany] = useState(workflow.customer_name || '');
  const [options, setOptions] = useState<WorkflowOptions | null>(null);
  const [mailQuery, setMailQuery] = useState('');
  const [optionError, setOptionError] = useState('');
  const [optionRevision, setOptionRevision] = useState(0);
  const [range, setRange] = useState(() => rangePreset(workflow.config));
  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedChanges, setSelectedChanges] = useState<string[]>([]);
  const [templates, setTemplates] = useState<WorkflowMailTemplate[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [templateRevision, setTemplateRevision] = useState(0);
  const [updateMode, setUpdateMode] = useState<'changes' | 'fill'>(() =>
    workflow.result?.fill_results ? 'fill' : 'changes',
  );
  const busy = Boolean(props.busy || localBusy);
  const endpoint = `/chats/${workflow.chat_id}/workflow`;
  const pasted = config.source_kinds.includes('pasted');
  const cancelled = workflow.step === 'cancelled';
  const hasResult = Boolean(workflow.result);
  const mailing = isMailWorkflow(workflow);
  const guided = workflow.kind !== 'compose';
  const showEditor = editing && !props.busy;
  const guideStep = showEditor ? (inputStep === 'target' ? 0 : 1) : 2;
  const templateEnabled = Boolean(props.templateWorkflows && mailing);
  const needsTemplate = workflowNeedsTemplate(workflow, templateEnabled);
  const templateUnavailable = Boolean(
    templateEnabled &&
    workflow.config.template_choice &&
    workflow.config.template_choice.kind !== 'none' &&
    !templateLoading &&
    !templateError &&
    !templates.some(
      (template) =>
        workflow.config.template_choice?.kind !== 'none' &&
        template.kind === workflow.config.template_choice?.kind &&
        template.id === workflow.config.template_choice?.id,
    ),
  );
  const filling = workflow.kind === 'update' && updateMode === 'fill';
  const companyFillBlocked =
    filling &&
    !config.document_id &&
    Boolean(config.person_id || config.project_id || config.mail_id || config.material);
  const mailStatus = useWorkflowMailStatus(
    mailing && workflow.draft_id && workflow.config.customer_id && !cancelled
      ? {
          workspace,
          actorKey: props.actorKey || 'current-session',
          workflowId: workflow.id,
          draftId: workflow.draft_id,
          customerId: workflow.config.customer_id,
          personId: workflow.config.person_id,
        }
      : null,
    `${workflow.version}:${workflow.updated_at}`,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    props.onEditingChange?.(editing && !cancelled);
    return () => props.onEditingChange?.(false);
  }, [editing, cancelled, props.onEditingChange]);

  useEffect(() => {
    setConfig(workflow.config);
    setSelectedName(workflow.person_name || workflow.customer_name || '');
    setSelectedCompany(workflow.customer_name || '');
    setRange(rangePreset(workflow.config));
    setSelectedChanges([]);
    setLocalError('');
    setEditing(workflowEditorInitiallyOpen(workflow));
    if (workflow.result?.fill_results) setUpdateMode('fill');
  }, [workflow.id, workflow.version, workflow.step, workflow.result?.message_id]);

  useEffect(() => {
    setInputStep(
      workflow.config.customer_id || workflow.config.document_id || workflow.config.material
        ? 'materials'
        : 'target',
    );
    setScopeExpanded(false);
  }, [workflow.id]);

  useEffect(() => {
    if (previousInputStep.current !== inputStep) guideHeading.current?.focus();
    previousInputStep.current = inputStep;
  }, [inputStep]);

  useEffect(() => {
    setTemplates([]);
    setTemplateError('');
    if (!templateEnabled || cancelled) {
      setTemplateLoading(false);
      return;
    }
    const controller = new AbortController();
    setTemplateLoading(true);
    api<WorkflowMailTemplate[]>(`${endpoint}/templates`, {
      workspace,
      signal: controller.signal,
    })
      .then((catalog) => {
        if (!controller.signal.aborted) setTemplates(catalog);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setTemplateError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setTemplateLoading(false);
      });
    return () => controller.abort();
  }, [
    workspace,
    endpoint,
    templateEnabled,
    cancelled,
    workflow.config.customer_id,
    templateRevision,
  ]);

  useEffect(() => {
    const trimmed = query.trim();
    setCandidateError('');
    setCandidates([]);
    setSearched(false);
    if (!trimmed) {
      setCandidateBusy(false);
      return;
    }
    const controller = new AbortController();
    setCandidateBusy(true);
    const timer = setTimeout(() => {
      api<WorkflowCandidate[]>(`/home-workflows/directory?${new URLSearchParams({ q: trimmed })}`, {
        workspace,
        signal: controller.signal,
      })
        .then((values) => {
          if (controller.signal.aborted) return;
          setCandidates(values);
          setSearched(true);
        })
        .catch((error) => {
          if (error.name !== 'AbortError') setCandidateError(errorText(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setCandidateBusy(false);
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, workspace, workflow.kind]);

  useEffect(() => {
    setMailQuery('');
  }, [workspace, config.customer_id, config.person_id, config.project_id, pasted]);

  useEffect(() => {
    setOptions(null);
    setOptionError('');
    if (!config.customer_id) return;
    const controller = new AbortController();
    const search = new URLSearchParams({ customer_id: config.customer_id });
    if (config.person_id) search.set('person_id', config.person_id);
    if (config.project_id) search.set('project_id', config.project_id);
    if (mailQuery.trim()) search.set('mail_query', mailQuery.trim());
    const timer = setTimeout(
      () => {
        api<WorkflowOptions>(`/home-workflows/options?${search}`, {
          workspace,
          signal: controller.signal,
        })
          .then((values) => {
            if (!controller.signal.aborted) setOptions(values);
          })
          .catch((error) => {
            if (error.name !== 'AbortError') setOptionError(errorText(error));
          });
      },
      mailQuery.trim() ? 220 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    workspace,
    config.customer_id,
    config.person_id,
    config.project_id,
    mailQuery,
    optionRevision,
  ]);

  function change(next: Partial<WorkflowConfig>) {
    setConfig((value) => ({
      ...value,
      ...next,
      ...(templateEnabled &&
      ['customer_id', 'person_id', 'project_id'].some(
        (key) =>
          key in next && next[key as keyof WorkflowConfig] !== value[key as keyof WorkflowConfig],
      )
        ? {
            template_choice: null,
            template_digest: null,
            selected_template_name: null,
            history_scope: null,
          }
        : {}),
    }));
    setLocalError('');
    setNotice('');
  }

  function selectCandidate(candidate: WorkflowCandidate) {
    change({
      customer_id: candidate.customer_id,
      person_id: candidate.object === 'people' ? candidate.id : null,
      project_id: null,
      mail_id: null,
      document_id: null,
      field_ids: [],
    });
    setSelectedName(candidate.name);
    setSelectedCompany(candidate.customer_name);
    setQuery('');
    setScopeExpanded(false);
    setInputStep('materials');
  }

  async function saveConfig() {
    const next = await api<Workflow>(endpoint, {
      workspace,
      method: 'PATCH',
      body: { version: workflow.version, config },
    });
    if (!mounted.current) throw new DOMException('任务页面已离开', 'AbortError');
    props.onWorkflow(next);
    return next;
  }

  async function perform(action: () => Promise<void>) {
    if (busy || actionPending.current) return;
    actionPending.current = true;
    setLocalBusy(true);
    setLocalError('');
    setNotice('');
    try {
      await action();
    } catch (error) {
      if (mounted.current) setLocalError(errorText(error));
    } finally {
      actionPending.current = false;
      if (mounted.current) setLocalBusy(false);
    }
  }

  function selectTemplate(choice: WorkflowTemplateChoice) {
    void perform(async () => {
      const next = await api<Workflow>(`${endpoint}/template`, {
        workspace,
        method: 'POST',
        body: { version: workflow.version, choice },
      });
      if (!mounted.current) return;
      if (currentWorkflow.current.id !== next.id || currentWorkflow.current.version > next.version)
        throw new Error('任务条件已变化，请按当前条件重新选择模板');
      props.onWorkflow(next);
      setEditing(next.kind === 'compose' && !next.config.customer_id);
      if (workflowDraftsAfterTemplateChoice(next))
        await props.onRun(next, currentMailDraftRequest, 'draft', 'draft_current');
    });
  }

  function openMail() {
    void perform(async () => {
      const response = await api<WorkflowReplyResponse>(`${endpoint}/reply-draft`, {
        workspace,
        method: 'POST',
        body: { version: workflow.version },
      });
      if (!mounted.current) return;
      props.onWorkflow(response.workflow);
      props.onOpenMail(response);
    });
  }

  function start(event: FormEvent) {
    event.preventDefault();
    if (guided && inputStep === 'target') {
      if (config.customer_id) setInputStep('materials');
      return;
    }
    void perform(async () => {
      if (!config.customer_id && !config.document_id && !config.material?.content.trim())
        throw new Error('请搜索并选择客户，或先粘贴需要处理的内容');
      if (!filling && pasted && !config.material?.content.trim())
        throw new Error('请粘贴需要处理的内容');
      if (workflow.kind === 'reply' && !pasted && !config.mail_id)
        throw new Error('请先选择一封客户来信');
      if (config.date_start && config.date_end && config.date_start > config.date_end)
        throw new Error('开始日期不能晚于结束日期');
      if (
        config.history_scope?.enabled &&
        config.history_scope.date_start &&
        config.history_scope.date_end &&
        config.history_scope.date_start > config.history_scope.date_end
      )
        throw new Error('参考资料的开始日期不能晚于结束日期');
      if (workflow.kind === 'update' && !config.customer_id)
        throw new Error('更新资料前请先选择具体客户');
      if (workflow.kind === 'compose' && !config.customer_id)
        throw new Error('新建邮件前请先选择具体客户或联系人');
      if (filling && companyFillBlocked)
        throw new Error('请明确切换为公司范围，或选择仅用于本次整理的文档');
      if (filling && !config.field_ids.length) throw new Error('请选择需要整理的空白 AI 字段');
      if (filling && config.field_ids.length > 10) throw new Error('一次最多整理10个 AI 字段');
      const next = await saveConfig();
      if (workflow.kind === 'compose') {
        setEditing(false);
        if (workflowNeedsTemplate(next, Boolean(props.templateWorkflows))) return;
        await props.onRun(next, currentMailDraftRequest, 'draft', 'draft_current');
        return;
      }
      if (workflow.kind === 'update' && updateMode === 'fill') {
        const response = await api<{
          workflow: Workflow;
          results: WorkflowFillOutcome[];
        }>(`${endpoint}/fill`, {
          workspace,
          method: 'POST',
          body: { version: next.version, field_ids: config.field_ids },
        });
        if (!mounted.current) return;
        props.onWorkflow(response.workflow);
        const failed = response.results.filter((result) => result.error);
        setNotice(response.workflow.result?.body || '本次字段整理已结束');
        if (failed.length) setLocalError(failed.map((result) => result.error).join('；'));
        setOptionRevision((value) => value + 1);
        return;
      }
      await props.onRun(next, config.instruction.trim() || defaultQuestions[workflow.kind]);
    });
  }

  function toggleSource(source: WorkflowConfig['source_kinds'][number]) {
    const included = config.source_kinds.includes(source);
    if (included && config.source_kinds.length === 1) {
      setLocalError('请至少选择一种资料来源');
      return;
    }
    change({
      source_kinds: included
        ? config.source_kinds.filter((item) => item !== source)
        : [...config.source_kinds, source],
      ...(source === 'pasted' && included ? { material: null } : {}),
    });
  }

  function setReplySource(value: 'mail' | 'pasted') {
    change({
      source_kinds: [value],
      mail_id: null,
      ...(value === 'mail' ? { material: null } : {}),
    });
  }

  const emptyAI = options?.fields.filter((field) => field.ai_enabled && field.empty) || [];
  const changesClosed =
    workflow.kind === 'update' && workflow.step === 'completed' && !workflow.result?.fill_results;
  const unapplied = changesClosed
    ? []
    : workflow.result?.changes.filter((item) => !workflow.result?.applied_keys.includes(item.key));
  const selectedMail = options?.mails.find((mail) => mail.id === config.mail_id);
  const selectedDocument = options?.documents?.find(
    (document) => document.id === config.document_id,
  );
  const statusLabel =
    !cancelled && mailing && workflow.result?.draft_body && !needsTemplate
      ? workflowMailPresentation(workflow, mailStatus.state).headingLabel
      : workflow.step === 'ready' && workflow.result
        ? workflow.kind === 'summary'
          ? '总结已生成'
          : '结果已生成'
        : stepLabels[workflow.step];
  function displayFieldValue(key: string, value: unknown): string {
    if (key === 'owner_id') {
      if (value === null || value === undefined || value === '') return '未分配负责人';
      return (
        props.members?.find((member) => member.actor_id === value && member.active)?.display_name ||
        '已不可用负责人'
      );
    }
    const labels: Record<string, Readonly<Record<string, string>>> = {
      type: customerTypes,
      status: customerStatuses,
      source: sources,
    };
    return typeof value === 'string' && labels[key]?.[value]
      ? labels[key][value]
      : displayValue(value);
  }
  const scopeSummary = [
    filling
      ? config.document_id
        ? '仅根据所选文件整理'
        : '公司全部授权资料'
      : workflow.kind === 'reply'
        ? pasted
          ? '粘贴来信'
          : selectedMail?.subject || '所选来信'
        : config.source_kinds
            .filter((source) => source === 'pasted' || Boolean(config.customer_id))
            .map((source) => sourceLabels[source])
            .join('、'),
    !filling &&
    workflow.kind !== 'reply' &&
    config.customer_id &&
    config.source_kinds.some((source) => source !== 'pasted')
      ? config.date_start || config.date_end
        ? `${config.date_start || '不限'} 至 ${config.date_end || '不限'}（北京时间）`
        : '全部时间'
      : null,
    config.person_id ? `来源联系人：${selectedName}` : null,
    config.project_id
      ? `项目：${options?.projects.find((project) => project.id === config.project_id)?.name || workflow.project_name || '已选项目'}`
      : null,
    config.document_id ? `文件：${selectedDocument?.name || '已选文件'}` : null,
    workflow.kind === 'reply' && config.history_scope?.enabled
      ? `参考其他沟通：${config.history_scope.source_kinds.map((source) => sourceLabels[source]).join('、')}，${config.history_scope.date_start || '不限'} 至 ${config.history_scope.date_end || '不限'}（北京时间）`
      : null,
    workflow.kind === 'update' ? (filling ? '补全空白 AI 字段' : '检查变更建议') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const actionHint =
    workflow.kind === 'summary'
      ? '整理需求、变化和待确认事项'
      : workflow.kind === 'reply'
        ? '先梳理问题，需要你决定时再询问'
        : workflow.kind === 'update'
          ? filling
            ? '保留已有值，仅整理选中的空字段'
            : '先给出建议，由你选定后保存'
          : '';
  const guideQuestion =
    inputStep === 'target'
      ? workflow.kind === 'summary'
        ? '这次想整理哪位客户的沟通？'
        : workflow.kind === 'reply'
          ? '这次要处理哪位客户的来信？'
          : '要检查哪家公司的资料？'
      : workflow.kind === 'summary'
        ? '好，接下来整理哪些内容？'
        : workflow.kind === 'reply'
          ? '把要处理的来信交给我。'
          : '你想重点检查什么？';
  const guideDescription =
    inputStep === 'target'
      ? '输入名称或邮箱，选好后继续。'
      : workflow.kind === 'summary'
        ? '可以直接开始，也可以告诉我想关注的重点。'
        : workflow.kind === 'reply'
          ? '先梳理客户的问题和答复依据，再一起准备回复。'
          : filling
            ? '选择要整理的空白 AI 字段，已有值会保留。'
            : '先从所选资料找出变化，再由你确认是否保存。';
  const titleIcon = mailing ? (
    <Mail size={18} />
  ) : workflow.kind === 'update' ? (
    <PencilLine size={18} />
  ) : (
    <MessageSquareText size={18} />
  );

  return (
    <section className="home-workflow" aria-label={workflowLabels[workflow.kind]} aria-busy={busy}>
      <header className="home-workflow-heading">
        <span className="home-workflow-icon" aria-hidden="true">
          {titleIcon}
        </span>
        <div>
          <h2>{workflowLabels[workflow.kind]}</h2>
          {(!guided || !showEditor) && <span>{statusLabel}</span>}
        </div>
        {!cancelled && (
          <button
            type="button"
            className="text-button home-workflow-cancel"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const next = await api<Workflow>(`${endpoint}/cancel`, {
                  workspace,
                  method: 'POST',
                  body: { version: workflow.version },
                });
                if (!mounted.current) return;
                props.onWorkflow(next);
                props.onCancel?.(next);
              })
            }
          >
            <X size={12} /> 取消流程
          </button>
        )}
      </header>

      {guided && !cancelled && (
        <>
          <ol className="home-workflow-steps" aria-label="任务步骤">
            {['选择对象', '确认资料', '处理与结果'].map((label, index) => (
              <li
                key={label}
                className={index === guideStep ? 'is-current' : index < guideStep ? 'is-done' : ''}
                aria-current={index === guideStep ? 'step' : undefined}
              >
                <span aria-hidden="true">
                  {index < guideStep ? <Check size={11} /> : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
          {showEditor && (
            <div className="home-workflow-guide">
              <h3 ref={guideHeading} tabIndex={-1}>
                {guideQuestion}
              </h3>
              <p>{guideDescription}</p>
            </div>
          )}
          {props.busy && (
            <p className="home-workflow-running" role="status">
              正在处理所选资料，可以离开页面，稍后回来继续。
            </p>
          )}
        </>
      )}

      {cancelled ? (
        <p className="home-workflow-note">此流程已取消。此前已经保存的资料和草稿仍保留。</p>
      ) : showEditor ? (
        <form onSubmit={start} className="home-workflow-form">
          {(!guided || inputStep === 'target') && (
            <>
              <div className="home-workflow-field">
                <label
                  htmlFor={config.customer_id && selectedName ? undefined : `${prefix}-customer`}
                >
                  {workflow.kind === 'update' ? '要更新的公司' : '客户／联系人'}
                </label>
                {config.customer_id && selectedName ? (
                  <div className="home-workflow-selection">
                    <Building2 size={14} aria-hidden="true" />
                    <span>
                      {workflow.kind === 'update' ? selectedCompany || selectedName : selectedName}
                      {config.person_id && selectedCompany && (
                        <small>
                          {workflow.kind === 'update'
                            ? `资料来源联系人：${selectedName}`
                            : selectedCompany}
                        </small>
                      )}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        change({
                          customer_id: null,
                          person_id: null,
                          project_id: null,
                          mail_id: null,
                          document_id: null,
                          field_ids: [],
                        });
                        setSelectedName('');
                      }}
                    >
                      更换
                    </button>
                  </div>
                ) : (
                  <div className="home-workflow-search">
                    <Search size={14} aria-hidden="true" />
                    <input
                      id={`${prefix}-customer`}
                      value={query}
                      disabled={busy}
                      autoComplete="off"
                      placeholder={
                        workflow.kind === 'update'
                          ? '搜索公司；也可通过联系人限定资料来源'
                          : '输入名称片段、姓氏或邮箱'
                      }
                      onChange={(event) => setQuery(event.target.value)}
                      aria-describedby={`${prefix}-search-state`}
                    />
                  </div>
                )}
                <div
                  id={`${prefix}-search-state`}
                  aria-live="polite"
                  className="home-workflow-search-state"
                >
                  {candidateBusy && '正在搜索授权目录…'}
                  {!candidateBusy &&
                    searched &&
                    !candidates.length &&
                    '未找到匹配项，请补充名称或邮箱'}
                </div>
                {workflow.kind === 'update' && (
                  <p className="home-workflow-note">更新公司已有字段；联系人仅用于限定资料来源。</p>
                )}
                {candidateError && (
                  <p role="alert" className="error">
                    {candidateError}
                  </p>
                )}
                {candidates.length > 0 && (
                  <div className="home-workflow-candidates" aria-label="匹配的客户和联系人">
                    {candidates.map((candidate) => (
                      <button
                        key={`${candidate.object}:${candidate.id}`}
                        type="button"
                        disabled={busy}
                        onClick={() => selectCandidate(candidate)}
                      >
                        <span>
                          <strong>{candidate.name}</strong>
                          <small>
                            {candidate.object === 'people'
                              ? `联系人 · ${candidate.customer_name}`
                              : '公司'}
                            {candidate.email ? ` · ${candidate.email}` : ''}
                          </small>
                        </span>
                        <ArrowRight size={14} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {guided && (
                <footer className="home-workflow-form-footer home-workflow-target-footer">
                  {workflow.kind !== 'update' && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        change({ source_kinds: ['pasted'], mail_id: null });
                        setInputStep('materials');
                      }}
                    >
                      直接粘贴{workflow.kind === 'reply' ? '来信' : '内容'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !config.customer_id}
                    onClick={() => setInputStep('materials')}
                  >
                    下一步 <ArrowRight size={14} />
                  </button>
                </footer>
              )}
            </>
          )}
          {(!guided || inputStep === 'materials') && (
            <>
              {guided && (
                <div className="home-workflow-chosen">
                  <span>
                    <Building2 size={14} aria-hidden="true" />
                    {workflow.kind === 'update'
                      ? selectedCompany || selectedName || '待选择公司'
                      : selectedName || (config.document_id ? '本人上传的文件' : '本次粘贴内容')}
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => setInputStep('target')}
                  >
                    {config.customer_id ? '更换对象' : '选择客户'}
                  </button>
                </div>
              )}
              {optionError && (
                <p className="error home-workflow-option-error" role="alert">
                  {optionError}
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => setOptionRevision((value) => value + 1)}
                  >
                    重试加载
                  </button>
                </p>
              )}

              {workflow.kind === 'reply' && (
                <fieldset className="home-workflow-choice-group" disabled={busy}>
                  <legend>来信来源</legend>
                  <label>
                    <input
                      type="radio"
                      name={`${prefix}-reply-source`}
                      checked={!pasted}
                      onChange={() => setReplySource('mail')}
                    />
                    已有邮件
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`${prefix}-reply-source`}
                      checked={pasted}
                      onChange={() => setReplySource('pasted')}
                    />
                    粘贴来信
                  </label>
                </fieldset>
              )}
              {workflow.kind === 'reply' && !pasted && (
                <div className="home-workflow-field">
                  <label htmlFor={`${prefix}-mail-query`}>搜索发件人或主题</label>
                  <div className="home-workflow-search">
                    <Search size={14} aria-hidden="true" />
                    <input
                      id={`${prefix}-mail-query`}
                      type="search"
                      value={mailQuery}
                      maxLength={200}
                      autoComplete="off"
                      disabled={busy || !config.customer_id}
                      placeholder="输入发件人或邮件主题关键词"
                      onChange={(event) => {
                        setMailQuery(event.target.value);
                        setOptions(null);
                        change({ mail_id: null });
                      }}
                    />
                  </div>
                  <label htmlFor={`${prefix}-mail`}>选择一封客户来信</label>
                  <select
                    id={`${prefix}-mail`}
                    value={config.mail_id || ''}
                    disabled={busy || !options}
                    onChange={(event) =>
                      change({
                        mail_id: event.target.value || null,
                        date_start: null,
                        date_end: null,
                      })
                    }
                  >
                    <option value="">
                      {config.customer_id ? '请选择来信' : '先搜索并选择客户'}
                    </option>
                    {config.mail_id &&
                      !options?.mails.some((mail) => mail.id === config.mail_id) && (
                        <option value={config.mail_id}>已选来信 · 保留当前选择</option>
                      )}
                    {options?.mails.map((mail) => (
                      <option key={mail.id} value={mail.id}>
                        {mail.subject || '无主题'} · {mail.sender} · {formatDate(mail.sent_at)}
                      </option>
                    ))}
                  </select>
                  {options && !options.mails.length && (
                    <p className="home-workflow-note" role="status">
                      {mailQuery.trim()
                        ? '当前范围没有匹配来信，请调整关键词。'
                        : '当前范围暂无可选来信，也可以粘贴内容。'}
                    </p>
                  )}
                  {options?.mails_total !== undefined &&
                    options.mails_total > options.mails.length && (
                      <p className="home-workflow-note" role="status">
                        共 {options.mails_total} 封匹配来信，当前显示最近 {options.mails.length}{' '}
                        封。 请用发件人或主题关键词缩小范围。
                      </p>
                    )}
                </div>
              )}

              {pasted && !filling && (
                <div className="home-workflow-field">
                  <label htmlFor={`${prefix}-material`}>
                    {workflow.kind === 'reply' ? '来信正文' : '粘贴的沟通内容'}
                  </label>
                  <textarea
                    id={`${prefix}-material`}
                    value={config.material?.content || ''}
                    disabled={busy}
                    maxLength={40000}
                    rows={5}
                    placeholder="保留必要的说话人和时间，方便核对原话"
                    onChange={(event) =>
                      change({
                        material: {
                          name:
                            config.material?.name ||
                            (workflow.kind === 'reply' ? '粘贴来信' : '粘贴沟通资料'),
                          content: event.target.value,
                        },
                      })
                    }
                  />
                  {!config.customer_id && (
                    <p className="home-workflow-note">尚未选择客户的内容保留在本人对话中。</p>
                  )}
                </div>
              )}

              {workflow.kind === 'update' && updateMode === 'fill' ? (
                <fieldset
                  className="home-workflow-field-list"
                  disabled={busy || !options?.can_edit}
                >
                  <legend>选择空白 AI 字段</legend>
                  {companyFillBlocked && (
                    <div className="home-workflow-fill-scope">
                      <p>
                        当前限定了
                        {[
                          config.person_id ? '联系人' : '',
                          config.project_id ? '项目' : '',
                          config.mail_id ? '单封来信' : '',
                          config.material ? '粘贴内容' : '',
                        ]
                          .filter(Boolean)
                          .join('、')}
                        。按公司资料补全需要你切换范围，也可以选择一份参考文档。
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          change({
                            person_id: null,
                            project_id: null,
                            mail_id: null,
                            material: null,
                            source_kinds: ['mail', 'wechat'],
                            date_start: null,
                            date_end: null,
                          });
                          setSelectedName(
                            selectedCompany || workflow.customer_name || selectedName,
                          );
                          setRange('all');
                        }}
                      >
                        切换为公司范围
                      </button>
                    </div>
                  )}
                  {emptyAI.map((field) => (
                    <label key={field.key}>
                      <input
                        type="checkbox"
                        disabled={
                          companyFillBlocked ||
                          (!config.field_ids.includes(field.key) && config.field_ids.length >= 10)
                        }
                        checked={config.field_ids.includes(field.key)}
                        onChange={(event) =>
                          change({
                            field_ids: event.target.checked
                              ? [...config.field_ids, field.key]
                              : config.field_ids.filter((key) => key !== field.key),
                          })
                        }
                      />
                      {field.label}
                    </label>
                  ))}
                  {config.customer_id && options && !emptyAI.length && (
                    <p className="home-workflow-note">当前没有可整理的空白 AI 字段。</p>
                  )}
                  <p className="home-workflow-note">
                    {config.document_id
                      ? '仅根据所选文档原文及属性指引整理，保留已有值。'
                      : '按该公司全部授权资料及属性指引整理，保留已有值。'}
                    一次最多10项。
                  </p>
                </fieldset>
              ) : (
                <div className="home-workflow-field">
                  <label htmlFor={`${prefix}-instruction`}>
                    {mailing
                      ? workflow.kind === 'compose'
                        ? '写信要求'
                        : '答复要求 · 可选'
                      : workflow.kind === 'update'
                        ? '需要检查或修改什么'
                        : '总结重点 · 可选'}
                  </label>
                  <textarea
                    id={`${prefix}-instruction`}
                    rows={2}
                    maxLength={10000}
                    value={config.instruction}
                    disabled={busy}
                    placeholder={
                      mailing
                        ? workflow.kind === 'compose'
                          ? '例如：介绍新品并询问客户希望了解的款式'
                          : '例如：先答复尺码问题，报价需要内部确认'
                        : workflow.kind === 'update'
                          ? '例如：核对这家公司的联系邮箱是否变更，其他资料保持原值'
                          : '例如：按需求、已明确事项和待确认问题整理'
                    }
                    onChange={(event) => change({ instruction: event.target.value })}
                  />
                </div>
              )}

              <div className={guided ? 'home-workflow-scope' : undefined}>
                {guided && (
                  <>
                    <div className="home-workflow-scope-summary">
                      <p>{scopeSummary}</p>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        aria-expanded={scopeExpanded}
                        aria-controls={`${prefix}-scope`}
                        onClick={() => setScopeExpanded((value) => !value)}
                      >
                        调整范围{' '}
                        <ChevronDown size={13} className={scopeExpanded ? 'is-open' : ''} />
                      </button>
                    </div>
                  </>
                )}
                <div
                  id={`${prefix}-scope`}
                  className="home-workflow-scope-fields"
                  hidden={guided && !scopeExpanded}
                >
                  {config.customer_id && !filling && (
                    <div className="home-workflow-field">
                      <label htmlFor={`${prefix}-project`}>关联项目 · 可选</label>
                      <select
                        id={`${prefix}-project`}
                        value={config.project_id || ''}
                        disabled={busy || !options}
                        onChange={(event) =>
                          change({
                            project_id: event.target.value || null,
                            mail_id: null,
                            document_id: null,
                          })
                        }
                      >
                        <option value="">客户层级资料，不指定项目</option>
                        {options?.projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {workflow.kind !== 'reply' && workflow.kind !== 'compose' && !filling && (
                    <fieldset className="home-workflow-choice-group" disabled={busy}>
                      <legend>资料来源</legend>
                      {(Object.keys(sourceLabels) as (keyof typeof sourceLabels)[]).map(
                        (source) => (
                          <label key={source}>
                            <input
                              type="checkbox"
                              checked={config.source_kinds.includes(source)}
                              onChange={() => toggleSource(source)}
                            />
                            {sourceLabels[source]}
                          </label>
                        ),
                      )}
                    </fieldset>
                  )}
                  {templateEnabled && workflow.kind === 'reply' && config.customer_id && (
                    <fieldset className="home-workflow-history" disabled={busy}>
                      <legend>答复参考资料 · 可选</legend>
                      <label className="home-workflow-history-toggle">
                        <input
                          type="checkbox"
                          checked={Boolean(config.history_scope?.enabled)}
                          onChange={(event) =>
                            change({
                              history_scope: event.target.checked
                                ? {
                                    enabled: true,
                                    ...dateRange(30),
                                    source_kinds: ['mail'],
                                    person_id: config.person_id,
                                    project_id: config.project_id,
                                  }
                                : null,
                            })
                          }
                        />
                        参考所选客户／联系人／项目的其他已保存沟通
                      </label>
                      {config.history_scope?.enabled && (
                        <>
                          <div className="home-workflow-date-pair">
                            <label>
                              参考开始日期
                              <input
                                type="date"
                                value={config.history_scope.date_start || ''}
                                onChange={(event) =>
                                  change({
                                    history_scope: {
                                      ...config.history_scope!,
                                      date_start: event.target.value || null,
                                    },
                                  })
                                }
                              />
                            </label>
                            <label>
                              参考结束日期
                              <input
                                type="date"
                                value={config.history_scope.date_end || ''}
                                onChange={(event) =>
                                  change({
                                    history_scope: {
                                      ...config.history_scope!,
                                      date_end: event.target.value || null,
                                    },
                                  })
                                }
                              />
                            </label>
                          </div>
                          <div className="home-workflow-choice-group">
                            {(['mail', 'wechat'] as const).map((source) => (
                              <label key={source}>
                                <input
                                  type="checkbox"
                                  checked={config.history_scope!.source_kinds.includes(source)}
                                  onChange={(event) => {
                                    const current = config.history_scope!;
                                    const next = event.target.checked
                                      ? [...current.source_kinds, source]
                                      : current.source_kinds.filter((item) => item !== source);
                                    if (!next.length) {
                                      setLocalError('请至少选择一种参考来源');
                                      return;
                                    }
                                    change({
                                      history_scope: { ...current, source_kinds: next },
                                    });
                                  }}
                                />
                                {sourceLabels[source]}
                              </label>
                            ))}
                          </div>
                          <p className="home-workflow-note">
                            仅在以上范围内查找答复依据，日期按北京时间计算。
                          </p>
                        </>
                      )}
                    </fieldset>
                  )}

                  {Boolean(config.document_id || options?.documents?.length) && (
                    <div className="home-workflow-field">
                      <label htmlFor={`${prefix}-document`}>参考文件 · 可选</label>
                      {config.customer_id ? (
                        <select
                          id={`${prefix}-document`}
                          value={config.document_id || ''}
                          disabled={busy || !options}
                          onChange={(event) => change({ document_id: event.target.value || null })}
                        >
                          <option value="">不附加文件</option>
                          {config.document_id &&
                            !options?.documents?.some(
                              (document) => document.id === config.document_id,
                            ) && <option value={config.document_id}>已选文件</option>}
                          {options?.documents
                            ?.filter(
                              (document) =>
                                !config.project_id || document.project_id === config.project_id,
                            )
                            .map((document) => (
                              <option key={document.id} value={document.id}>
                                {document.name}
                              </option>
                            ))}
                        </select>
                      ) : (
                        <div className="home-workflow-selection">
                          <FileText size={14} aria-hidden="true" />
                          <span>本人上传的待关联文件</span>
                          <button
                            className="text-button"
                            type="button"
                            disabled={busy}
                            onClick={() => change({ document_id: null })}
                          >
                            移除
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {workflow.kind !== 'reply' && workflow.kind !== 'compose' && !filling && (
                    <div className="home-workflow-field">
                      <label htmlFor={`${prefix}-range`}>沟通时间范围 · 北京时间</label>
                      <select
                        id={`${prefix}-range`}
                        value={range}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.target.value;
                          setRange(value);
                          if (value === '7' || value === '30') change(dateRange(Number(value)));
                          else if (value === 'all') change({ date_start: null, date_end: null });
                        }}
                      >
                        <option value="7">最近7天</option>
                        <option value="30">最近30天</option>
                        <option value="all">全部已保存沟通</option>
                        <option value="custom">自定义日期</option>
                      </select>
                      {range === 'custom' && (
                        <div className="home-workflow-date-pair">
                          <label>
                            开始日期
                            <input
                              type="date"
                              disabled={busy}
                              value={config.date_start || ''}
                              onChange={(event) =>
                                change({ date_start: event.target.value || null })
                              }
                            />
                          </label>
                          <label>
                            结束日期
                            <input
                              type="date"
                              disabled={busy}
                              value={config.date_end || ''}
                              onChange={(event) => change({ date_end: event.target.value || null })}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  )}

                  {workflow.kind === 'update' && (
                    <fieldset
                      className="home-workflow-choice-group home-workflow-update-modes"
                      disabled={busy}
                    >
                      <legend>希望怎样更新</legend>
                      <label>
                        <input
                          type="radio"
                          name={`${prefix}-update-mode`}
                          checked={updateMode === 'changes'}
                          onChange={() => setUpdateMode('changes')}
                        />
                        检查资料变更，选定后保存
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`${prefix}-update-mode`}
                          checked={updateMode === 'fill'}
                          onChange={() => setUpdateMode('fill')}
                        />
                        整理已有空白 AI 字段
                      </label>
                    </fieldset>
                  )}

                  {!filling &&
                    workflow.kind !== 'compose' &&
                    (props.onReadWeChat || props.onUpload) && (
                      <div className="home-workflow-extra-actions">
                        {props.onReadWeChat && (
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              void perform(async () => {
                                await saveConfig();
                                props.onReadWeChat?.();
                              })
                            }
                          >
                            <MessageSquareText size={13} />
                            读取指定微信记录
                          </button>
                        )}
                        {props.onUpload && (
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              void perform(async () => {
                                await saveConfig();
                                props.onUpload?.();
                              })
                            }
                          >
                            <Upload size={13} />
                            上传文字 PDF／DOCX
                          </button>
                        )}
                      </div>
                    )}
                </div>
              </div>
              <footer className="home-workflow-form-footer">
                {guided && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => setInputStep('target')}
                  >
                    <ChevronLeft size={14} /> 上一步
                  </button>
                )}
                <span>{hasResult ? '修改条件后会重新生成结果' : actionHint}</span>
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    busy ||
                    (guided && workflow.kind === 'update' && !config.customer_id) ||
                    (workflow.kind === 'reply' && !pasted && !config.mail_id) ||
                    (pasted && !filling && !config.material?.content.trim()) ||
                    companyFillBlocked ||
                    (filling && !config.field_ids.length) ||
                    (workflow.kind === 'update' && options !== null && !options.can_edit)
                  }
                >
                  {busy
                    ? '正在处理…'
                    : workflow.kind === 'summary'
                      ? '帮我总结'
                      : workflow.kind === 'reply'
                        ? '帮我分析这封来信'
                        : workflow.kind === 'compose'
                          ? config.template_choice
                            ? '保存并生成草稿'
                            : '保存并选择模板'
                          : updateMode === 'fill'
                            ? config.document_id
                              ? '从此文档补全空 AI 字段'
                              : '按公司资料补全空 AI 字段'
                            : '帮我检查资料'}
                  {!busy && <ArrowRight size={14} />}
                </button>
              </footer>
            </>
          )}
        </form>
      ) : (
        <>
          <div className="home-workflow-context">
            {workflow.customer_name && (
              <span>
                <Building2 size={12} />
                {workflow.customer_name}
              </span>
            )}
            {workflow.person_name && <span>{workflow.person_name}</span>}
            <span>
              <Folder size={12} />
              {workflow.project_name ||
                (workflow.config.customer_id ? '客户层级 · 未指定项目' : '本人私有资料')}
            </span>
            {workflow.kind !== 'compose' && (
              <span>
                <FileText size={12} />
                {workflow.result?.fill_results
                  ? workflow.config.document_id
                    ? '仅根据所选文档整理'
                    : '公司全部授权资料'
                  : workflow.config.source_kinds.map((source) => sourceLabels[source]).join('、')}
              </span>
            )}
            {!workflow.result?.fill_results &&
              (workflow.config.date_start || workflow.config.date_end) && (
                <span>
                  {workflow.config.date_start || '不限'} 至 {workflow.config.date_end || '不限'}
                </span>
              )}
            {selectedMail && <span>{selectedMail.subject || '无主题'}</span>}
            {workflow.config.document_id && (
              <span>
                <FileText size={12} />
                {selectedDocument?.name || '已选文件'}
              </span>
            )}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              修改条件
            </button>
          </div>

          {workflow.result?.decisions.length ? (
            <div className="home-workflow-decisions">
              <h3>需要你决定</h3>
              <ul>
                {workflow.result.decisions.map((decision, index) => (
                  <li key={index}>{decision}</li>
                ))}
              </ul>
              <p>在下方对话里补充口径，Typha 会继续处理。</p>
            </div>
          ) : null}

          {workflow.kind === 'update' && workflow.result && (
            <div className="home-workflow-changes">
              <h3 className="home-workflow-target-heading">
                公司资料 · {workflow.customer_name || '所选公司'}
              </h3>
              {workflow.result.fill_results ? (
                <div className="home-workflow-fill-results">
                  <p>{workflow.result.body}</p>
                  {workflow.result.fill_results.map((result) => (
                    <div key={result.key}>
                      <strong>
                        {options?.fields.find((field) => field.key === result.key)?.label ||
                          '原字段'}
                      </strong>
                      <span className={result.status === 'failed' ? 'error' : undefined}>
                        {fillStatusLabels[result.status]}
                      </span>
                      {(result.explanation || result.error) && (
                        <small>{result.explanation || result.error}</small>
                      )}
                    </div>
                  ))}
                </div>
              ) : workflow.result.changes.length ? (
                workflow.result.changes.map((item) => {
                  const applied = workflow.result!.applied_keys.includes(item.key);
                  return (
                    <article className="home-workflow-change" key={item.key}>
                      <label>
                        <input
                          type="checkbox"
                          disabled={busy || applied || changesClosed || options?.can_edit === false}
                          checked={applied || selectedChanges.includes(item.key)}
                          onChange={(event) =>
                            setSelectedChanges((current) =>
                              event.target.checked
                                ? [...current, item.key]
                                : current.filter((key) => key !== item.key),
                            )
                          }
                        />
                        <strong>{item.label}</strong>
                        {applied && (
                          <small>
                            <Check size={12} />
                            已保存
                          </small>
                        )}
                        {changesClosed && !applied && <small>保持原值</small>}
                      </label>
                      <dl>
                        <div>
                          <dt>原值</dt>
                          <dd>{displayFieldValue(item.key, item.old_value)}</dd>
                        </div>
                        <div>
                          <dt>建议新值</dt>
                          <dd>{displayFieldValue(item.key, item.value)}</dd>
                        </div>
                        <div>
                          <dt>依据</dt>
                          <dd>
                            {item.reason}
                            {item.quote && <q>{item.quote}</q>}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  );
                })
              ) : (
                <p className="home-workflow-note">本次没有生成可保存的资料变更，可继续补充信息。</p>
              )}
              {changesClosed && (
                <p className="home-workflow-note">
                  选中修改已保存；未选项保持原值。继续修改时，请修改条件后重新生成建议。
                </p>
              )}
              {Boolean(unapplied?.length) && (
                <div className="home-workflow-change-actions">
                  <span>仅保存你选中的修改</span>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !selectedChanges.length || options?.can_edit === false}
                    onClick={() =>
                      void perform(async () => {
                        const next = await api<Workflow>(`${endpoint}/apply`, {
                          workspace,
                          method: 'POST',
                          body: { version: workflow.version, keys: selectedChanges },
                        });
                        if (!mounted.current) return;
                        props.onWorkflow(next);
                        setNotice(`已保存 ${selectedChanges.length} 项修改`);
                        setOptionRevision((value) => value + 1);
                      })
                    }
                  >
                    保存选中修改
                  </button>
                </div>
              )}
            </div>
          )}

          {templateEnabled && (
            <div className="home-workflow-mail-cards">
              <WorkflowMailTemplateCard
                choice={workflow.config.template_choice}
                selectedName={workflow.config.selected_template_name}
                draftOnChoose={workflow.kind === 'compose' && Boolean(workflow.config.customer_id)}
                templates={templates}
                loading={templateLoading}
                error={templateError}
                disabled={busy}
                onChoose={selectTemplate}
                onReload={() => setTemplateRevision((value) => value + 1)}
              />
            </div>
          )}

          {mailing && workflow.result?.draft_body && !needsTemplate && (
            <div className="home-workflow-mail-cards">
              <WorkflowMailDraftCard
                workflow={workflow}
                mailState={mailStatus.state}
                disabled={busy || (!workflow.draft_id && templateUnavailable)}
                onOpen={openMail}
                onReload={mailStatus.refresh}
              />
            </div>
          )}

          <footer className="home-workflow-result-actions">
            {workflow.kind === 'summary' && props.onRelated && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => props.onRelated?.('update', workflow.config)}
                >
                  根据总结更新资料
                  <ArrowRight size={13} />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => props.onRelated?.('reply', workflow.config)}
                >
                  准备回复
                  <ArrowRight size={13} />
                </button>
              </>
            )}
            {mailing && (
              <>
                <span>
                  {needsTemplate
                    ? '先选择模板或不使用模板，再继续拟稿。'
                    : '可以在对话里补充口径或修改要求。'}
                </span>
                {!workflow.result?.draft_body && !needsTemplate && (
                  <button
                    type="button"
                    disabled={busy || templateUnavailable || !workflow.config.customer_id}
                    onClick={() =>
                      void perform(() =>
                        props.onRun(workflow, currentMailDraftRequest, 'draft', 'draft_current'),
                      )
                    }
                  >
                    {workflow.kind === 'compose' ? '生成邮件草稿' : '生成回复草稿'}
                    <ArrowRight size={13} />
                  </button>
                )}
              </>
            )}
            {workflow.kind === 'update' && workflow.result?.applied_keys.length ? (
              <span>
                <Check size={13} />
                已保存 {workflow.result.applied_keys.length} 项修改
              </span>
            ) : null}
          </footer>
        </>
      )}
      {(notice || workflow.notice) && (
        <p className="home-workflow-notice" role="status">
          {notice || workflow.notice}
        </p>
      )}
      {(localError || props.error) && (
        <p className="error home-workflow-error" role="alert">
          {localError || props.error}
        </p>
      )}
    </section>
  );
}
