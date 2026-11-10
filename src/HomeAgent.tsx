import { ResizableTable, ColumnResizeHandle, ExpandableCell } from './ResizableTable';
import { Dialog } from './WorkspaceUI';
import { ProspectIntake } from './ProspectIntake';
import { prospectsChanged } from './prospect-events';
import { useProspectEditorState } from './useProspectEditorState';
import { AgentAnswer } from './AgentAnswer';
import {
  AgentCandidateCards,
  AgentListedCustomerCards,
  AgentRecordAnswerCard,
  AgentReplyCard,
  AgentReplySources,
} from './AgentReplyCards';
import {
  agentListedCustomerItems,
  agentRecordReplySource,
  agentReplyCopyText,
} from './agent-reply-card-data';
import {
  canOrganizeAnswerAsNote,
  organizeAnswerAsNote,
  openAgentNoteDraft,
} from './note-agent-client';
import { DocumentDetailDialog, DocumentUploadDialog } from './Documents';
import { WeChatReviewDialog, WeChatQueryForm } from './WeChat';
import type { WeChatPreview } from '../shared/wechat';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
} from './components/prompt-kit/prompt-input';
import { Message, MessageContent, MessageActions } from './components/prompt-kit/message';
import { HomeProjects } from './HomeProjects';
import { HomeOverview } from './HomeOverview';
import { HomeWorkflow } from './HomeWorkflow';
import { workflowMailComposerState } from './workflow-mail-ui';
import { MailComposer } from './MailComposer';
import { MailDialog } from './Mail';
import {
  workflowLabels,
  type HomeWorkflow as Workflow,
  type WorkflowKind,
  type WorkflowConfig,
  type WorkflowReplyResponse,
  type WorkflowRunResponse,
  type WorkflowTaskAction,
} from '../shared/home-workflows';
import type { HomeOverviewItem } from '../shared/home-overview';
import type { OutgoingMail } from '../shared/outgoing';
import type { Customer, Person } from '../shared/domain';
import type { DocumentDetail } from '../shared/documents';
import type { AgentCapabilities } from '../shared/agent';
import { activeAgentRun, type AgentRun, type AgentRunResult } from '../shared/agent-runs';
import {
  observeAgentRun,
  onAgentActivity,
  publishAgentActivity,
  runFailure,
  submitAgentRun,
} from './agent-runs-client';
import type { AskSource, AskEvidence } from '../shared/ask';
import type { Selection } from './Workbench';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  ArrowUp,
  ArrowUpRight,
  MessageSquare,
  Building2,
  Check,
  MessageSquareText,
  Mail,
  PencilLine,
  FileText,
  Paperclip,
  Plus,
  Table2,
  X,
} from 'lucide-react';
import { api, streamApi, HttpError } from './api';
import {
  customerTypes,
  customerStatuses,
  projectTypes,
  projectStages,
  sources,
  type Member,
} from '../shared/domain';
import { objectLabels, type RecordObject, type ProjectRow } from '../shared/views';
import {
  importFields,
  parseTable,
  type Chat,
  type ChatDetail,
  type ChatMessage,
  type ImportPlan,
} from '../shared/chat';
import './home.css';
import typhaLogo from './assets/typha-mark.svg';

export type WeChatFollowup = { preview?: WeChatPreview; request?: ChatDetail['wechat_request'] };
type Props = {
  tablePreferenceKey: string;
  runOwner: string;
  foreground: boolean;
  workspace: string;
  admin: boolean;
  chatId: string | null;
  members: Member[];
  refresh: number;
  onProject: (project: ProjectRow) => void;
  onChat: (chat: Chat, followup?: WeChatFollowup) => void;
  wechatFollowup?: WeChatFollowup | null;
  onWeChatFollowupConsumed?: () => void;
  onRecords: (object: RecordObject, listId?: string | null) => void;
  onCustomer: (id: string) => void;
  onSelect?: (selection: Selection) => void;
  onChanged: () => void;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
type Material = { name: string; content: string };
type ChatAction = 'message' | 'overview' | 'activity' | 'web_research';
type PendingMessage = {
  run?: { id: string; chat_id: string };
  workflow?: {
    id: string;
    version: number;
    phase: 'analyze' | 'draft';
    task_action?: WorkflowTaskAction;
  };
  candidate_selection?: { message_id: string; index: number };
  body: string;
  requestBody?: string;
  material: Material | null;
  action: ChatAction;
  answer: string;
  error?: string;
};
async function readFile(file: File): Promise<Material> {
  if (!/\.(csv|tsv|txt|md)$/i.test(file.name))
    throw new Error(
      '支持 CSV、TSV、TXT、Markdown，或通过文档上传接收文字版 PDF、DOCX；旧版 DOC 请另存为 DOCX',
    );
  if (file.size > 40000) throw new Error('一次最多上传 40 KB 的文本资料');
  const content = await file.text();
  if (content.includes('\uFFFD')) throw new Error('请将文件另存为 UTF-8 编码后上传');
  if (!content.trim()) throw new Error('文件内容为空');
  return { name: file.name, content };
}
export function HomeAgent(props: Props) {
  const [data, setData] = useState<ChatDetail | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [workflowEditing, setWorkflowEditing] = useState(false);
  const [stoppingWorkflow, setStoppingWorkflow] = useState(false);
  const [viewWorkspace, setViewWorkspace] = useState(props.workspace);
  const [workflowWeChat, setWorkflowWeChat] = useState(false);
  const [workflowUpload, setWorkflowUpload] = useState(false);
  const [mailSource, setMailSource] = useState<string | null>(null);
  const [compose, setCompose] = useState<{
    person: Pick<Person, 'id' | 'name' | 'email' | 'customer_id' | 'customer_name'>;
    kind: 'people' | 'customers';
    draftId: string;
    reply?: WorkflowReplyResponse;
  } | null>(null);
  const composeReply = useMemo(
    () =>
      compose?.reply?.source
        ? { plan: compose.reply.plan, source: compose.reply.source }
        : undefined,
    [compose],
  );
  const [overviewRefresh, setOverviewRefresh] = useState(0);
  const [loading, setLoading] = useState(Boolean(props.chatId));
  const [error, setError] = useState('');
  const [processing, setBusy] = useState(false);
  const busy = processing || stoppingWorkflow || Boolean(data?.run && activeAgentRun(data.run));
  const [copied, setCopied] = useState<string | null>(null);
  const [noteSaving, setNoteSaving] = useState<string | null>(null);
  const noteRequest = useRef<AbortController | null>(null);
  const noteRequestIds = useRef(new Map<string, string>());
  const [body, setBody] = useState('');
  const [material, setMaterial] = useState<Material | null>(null);
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documentTask, setDocumentTask] = useState<{ id: string; name: string } | null>(null);
  const [openDocument, setOpenDocument] = useState<string | null>(null);
  const [wechatPreview, setWeChatPreview] = useState<WeChatPreview | null>(null);
  const [wechatChoice, setWeChatChoice] = useState<ChatDetail['wechat_request']>();
  const [importing, setImporting] = useState(false);
  const [prospectIntake, setProspectIntake] = useState(false);
  const [prospectIntakeDirty, setProspectIntakeDirty] = useState(false);
  const [prospectIntakeBusy, setProspectIntakeBusy] = useState(false);
  const [prospectLeaving, setProspectLeaving] = useState(false);
  const [prospectNotice, setProspectNotice] = useState('');
  useProspectEditorState(
    props.workspace,
    prospectIntake && prospectIntakeDirty,
    prospectIntake && prospectIntakeBusy,
  );
  useEffect(() => {
    setProspectIntake(false);
    setProspectIntakeDirty(false);
    setProspectIntakeBusy(false);
    setProspectLeaving(false);
    setProspectNotice('');
  }, [props.workspace, props.chatId]);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [modelConnection, setModelConnection] = useState<'unknown' | 'connected' | 'unavailable'>(
    'unknown',
  );
  const modelReady =
    modelConnection !== 'unavailable' && (capabilities?.model || modelConnection === 'connected');
  const [evidence, setEvidence] = useState<AskEvidence | null>(null);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const streamRequest = useRef<AbortController | null>(null);
  const navigationRequest = useRef<AbortController | null>(null);
  const evidenceRequest = useRef<AbortController | null>(null);
  const viewGeneration = useRef(0);
  const alive = useRef(true);
  const foreground = useRef(props.foreground);
  foreground.current = props.foreground;
  const sendRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const created = useRef<Chat | null>(null);
  const creatingChat = useRef<Promise<Chat> | null>(null);
  const submitting = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  function stillHere(generation: number) {
    return alive.current && generation === viewGeneration.current;
  }
  function checkView(generation: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!stillHere(generation)) throw new DOMException('对话页面已切换', 'AbortError');
  }
  function showRun(run: AgentRun) {
    setPending(
      run.status === 'completed'
        ? null
        : {
            run: { id: run.id, chat_id: run.chat_id },
            body: run.question,
            material: null,
            action: 'message',
            answer: activeAgentRun(run) ? run.answer : '',
            ...(!activeAgentRun(run) ? { error: runFailure(run) } : {}),
          },
    );
  }
  function receiveRun(result: AgentRunResult) {
    setData({ ...result.detail, run: result.run });
    showRun(result.run);
    if (result.run.status === 'completed') {
      setModelConnection('connected');
      if (result.detail.wechat_request && foreground.current)
        setWeChatChoice(result.detail.wechat_request);
      setOverviewRefresh((n) => n + 1);
    }
    if (result.run.status === 'failed' || result.run.status === 'interrupted')
      setModelConnection('unavailable');
    if (capabilities?.home_workflows && !result.detail.chat.origin && !activeAgentRun(result.run)) {
      const generation = viewGeneration.current;
      void api<Workflow | null>(`/chats/${result.run.chat_id}/workflow`, {
        workspace: props.workspace,
      })
        .then((next) => {
          if (stillHere(generation))
            setWorkflow((current) =>
              !current || !next || current.id !== next.id || next.version >= current.version
                ? next
                : current,
            );
        })
        .catch((e) => {
          if (stillHere(generation)) setError(errorText(e));
        });
    }
  }
  useEffect(
    () =>
      onAgentActivity(props.runOwner, ({ result }) => {
        if (result && result.detail.chat.id === (props.chatId || created.current?.id))
          receiveRun(result);
      }),
    [props.runOwner, props.chatId, capabilities?.home_workflows],
  );
  useEffect(() => {
    const run = data?.run;
    if (!run || !activeAgentRun(run)) return;
    const controller = new AbortController();
    const generation = viewGeneration.current;
    streamRequest.current = controller;
    void observeAgentRun({
      owner: props.runOwner,
      workspace: props.workspace,
      run,
      signal: controller.signal,
      onRun: (next) => {
        if (!stillHere(generation)) return;
        setData((detail) => (detail ? { ...detail, run: next } : detail));
        showRun(next);
      },
      onDone: (result) => {
        if (stillHere(generation)) receiveRun(result);
      },
      onReconnect: (value) => {
        if (stillHere(generation)) setReconnecting(value);
      },
    }).catch((e) => {
      if (stillHere(generation) && !controller.signal.aborted) {
        setData(null);
        setPending(null);
        setError(errorText(e));
      }
    });
    return () => controller.abort();
  }, [
    data?.run?.id,
    Boolean(data?.run && activeAgentRun(data.run)),
    props.workspace,
    props.runOwner,
    capabilities?.home_workflows,
  ]);
  function receiveFile(file: File) {
    const generation = viewGeneration.current;
    if (/\.(pdf|docx)$/i.test(file.name)) {
      setDocumentFile(file);
      return;
    }
    void readFile(file)
      .then(async (value) => {
        checkView(generation);
        if (workflow && workflow.step !== 'cancelled') {
          const next = await api<Workflow>(`/chats/${workflow.chat_id}/workflow`, {
            workspace: props.workspace,
            method: 'PATCH',
            body: {
              version: workflow.version,
              config: {
                ...workflow.config,
                material: value,
                source_kinds: [...new Set([...workflow.config.source_kinds, 'pasted'])],
              },
            },
          });
          if (stillHere(generation)) setWorkflow(next);
        } else setMaterial(value);
      })
      .catch((e) => {
        if (stillHere(generation) && e.name !== 'AbortError') setError(errorText(e));
      });
  }
  useEffect(() => {
    alive.current = true;
    viewGeneration.current++;
    setEvidence(null);
    return () => {
      alive.current = false;
      viewGeneration.current++;
      streamRequest.current?.abort();
      navigationRequest.current?.abort();
      evidenceRequest.current?.abort();
    };
  }, [props.workspace, props.chatId, props.runOwner]);
  useEffect(() => {
    setCapabilities(null);
    setModelConnection('unknown');
  }, [props.workspace]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [pending?.body, pending?.answer]);
  useEffect(() => {
    if (data) end.current?.scrollIntoView({ block: 'end' });
  }, [data?.chat.id]);
  useEffect(() => {
    if (props.wechatFollowup) {
      if (props.wechatFollowup.preview) setWeChatPreview(props.wechatFollowup.preview);
      if (props.wechatFollowup.request) setWeChatChoice(props.wechatFollowup.request);
      props.onWeChatFollowupConsumed?.();
    }
  }, [props.wechatFollowup]);
  useEffect(() => {
    const controller = new AbortController();
    const generation = viewGeneration.current;
    setLoading(Boolean(props.chatId));
    setWorkflow(null);
    setWorkflowEditing(false);
    void (async () => {
      const capability = api<AgentCapabilities>('/agent/capabilities', {
        workspace: props.workspace,
        signal: controller.signal,
      }).catch((e) => {
        if (stillHere(generation) && e.name !== 'AbortError') {
          setModelConnection('unavailable');
          setError(errorText(e));
        }
        return null;
      });
      try {
        const [caps, detail] = await Promise.all([
          capability,
          props.chatId
            ? api<ChatDetail>(`/chats/${props.chatId}`, {
                workspace: props.workspace,
                signal: controller.signal,
              })
            : Promise.resolve(null),
        ]);
        checkView(generation, controller.signal);
        setCapabilities(caps);
        setData(detail);
        if (detail?.run) showRun(detail.run);
        if (detail?.wechat_request && foreground.current) setWeChatChoice(detail.wechat_request);
        created.current = detail?.chat || null;
        if (detail && !detail.chat.origin && caps?.home_workflows) {
          const task = await api<Workflow | null>(`/chats/${detail.chat.id}/workflow`, {
            workspace: props.workspace,
            signal: controller.signal,
          });
          checkView(generation, controller.signal);
          setWorkflow((current) =>
            !current || !task || current.id !== task.id || task.version >= current.version
              ? task
              : current,
          );
        }
        setViewWorkspace(props.workspace);
      } catch (e) {
        if (stillHere(generation) && !controller.signal.aborted) setError(errorText(e));
      } finally {
        if (stillHere(generation)) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [props.workspace, props.chatId, loadKey]);
  async function ensureChat(title: string) {
    if (created.current) return created.current;
    if (creatingChat.current) return creatingChat.current;
    const promise = api<Chat>('/chats', {
      workspace: props.workspace,
      method: 'POST',
      keepalive: true,
      body: {
        id: crypto.randomUUID(),
        title: title.slice(0, 80),
        customer_id: null,
      },
    });
    creatingChat.current = promise;
    const chat = await promise.finally(() => (creatingChat.current = null));
    created.current = chat;
    return chat;
  }
  async function startWorkflow(kind: WorkflowKind, config?: Partial<WorkflowConfig>) {
    if (busy) return;
    const generation = viewGeneration.current;
    const controller = new AbortController();
    navigationRequest.current = controller;
    setBusy(true);
    setError('');
    try {
      // Related tasks get their own persistent chat, retaining the prior result.
      const chat = await api<Chat>('/chats', {
        workspace: props.workspace,
        signal: controller.signal,
        method: 'POST',
        body: { id: crypto.randomUUID(), title: workflowLabels[kind], customer_id: null },
      });
      checkView(generation, controller.signal);
      let next = await api<Workflow>(`/chats/${chat.id}/workflow`, {
        workspace: props.workspace,
        signal: controller.signal,
        method: 'POST',
        body: { kind },
      });
      checkView(generation, controller.signal);
      if (config)
        next = await api<Workflow>(`/chats/${chat.id}/workflow`, {
          workspace: props.workspace,
          signal: controller.signal,
          method: 'PATCH',
          body: { version: next.version, config: { ...next.config, ...config } },
        });
      checkView(generation, controller.signal);
      setWorkflow(next);
      setPending(null);
      setMaterial(null);
      sendRequest.current = null;
      props.onChat(chat);
    } catch (e) {
      if (stillHere(generation) && !controller.signal.aborted) setError(errorText(e));
    } finally {
      if (stillHere(generation)) setBusy(false);
    }
  }
  async function runWorkflow(
    selected: Workflow,
    question: string,
    phase: 'analyze' | 'draft' = 'analyze',
    taskAction: WorkflowTaskAction = 'message',
    retry?: PendingMessage,
  ) {
    if (busy || submitting.current) return;
    const generation = viewGeneration.current;
    setBusy(true);
    setError('');
    const draft: PendingMessage = {
      body: question,
      action: 'message',
      material: null,
      answer: '',
      workflow: { id: selected.id, version: selected.version, phase, task_action: taskAction },
    };
    setPending(draft);
    setBody('');
    const controller = new AbortController();
    streamRequest.current = controller;
    const fingerprint = JSON.stringify({
      workflow: selected.id,
      version: selected.version,
      question,
      phase,
      task_action: taskAction,
    });
    if (!retry || sendRequest.current?.fingerprint !== fingerprint)
      sendRequest.current = { fingerprint, id: crypto.randomUUID() };
    try {
      if (capabilities?.background_runs) {
        submitting.current = true;
        const requestId = sendRequest.current.id;
        const result = await submitAgentRun(
          props.runOwner,
          props.workspace,
          { id: selected.chat_id },
          `/chats/${selected.chat_id}/runs`,
          {
            kind: 'workflow',
            payload: {
              version: selected.version,
              request_id: requestId,
              body: question,
              phase,
              ...(capabilities?.workflow_task_actions ? { task_action: taskAction } : {}),
            },
          },
          { ref: sendRequest, id: requestId },
        );
        if (stillHere(generation)) receiveRun(result);
        return;
      }
      const result = await streamApi<WorkflowRunResponse>(
        `/chats/${selected.chat_id}/workflow/run`,
        {
          workspace: props.workspace,
          signal: controller.signal,
          body: {
            version: selected.version,
            request_id: sendRequest.current.id,
            body: question,
            phase,
            ...(capabilities?.workflow_task_actions ? { task_action: taskAction } : {}),
          },
          onText: (answer) => setPending((p) => (p ? { ...p, answer } : p)),
        },
      );
      checkView(generation, controller.signal);
      sendRequest.current = null;
      setWorkflow(result.workflow);
      setData(result.detail);
      setPending(null);
      setModelConnection('connected');
      props.onChat(result.detail.chat);
      setOverviewRefresh((n) => n + 1);
    } catch (e) {
      if (stillHere(generation) && !controller.signal.aborted) {
        if (
          capabilities?.background_runs &&
          e instanceof HttpError &&
          e.status === 409 &&
          created.current
        ) {
          const detail = await api<ChatDetail>(`/chats/${created.current.id}`, {
            workspace: props.workspace,
          }).catch(() => null);
          if (stillHere(generation) && detail?.run && activeAgentRun(detail.run)) {
            receiveRun({ run: detail.run, detail });
            setBody(question);
            setError('当前消息仍在处理中，已保留本次输入，请稍后再发送');
            return;
          }
        }
        if (
          e instanceof TypeError ||
          (e instanceof HttpError && [429, 502, 503, 504].includes(e.status))
        )
          setModelConnection('unavailable');
        setPending({ ...draft, error: errorText(e) });
        if (e instanceof HttpError && [403, 404, 409].includes(e.status)) {
          void api<Workflow | null>(`/chats/${selected.chat_id}/workflow`, {
            workspace: props.workspace,
            signal: controller.signal,
          })
            .then((next) => {
              if (stillHere(generation)) setWorkflow(next);
            })
            .catch(() => {
              if (stillHere(generation)) setWorkflow(null);
            });
        }
      }
    } finally {
      submitting.current = false;
      if (stillHere(generation)) setBusy(false);
    }
  }
  async function bindDocument(file: DocumentDetail) {
    const generation = viewGeneration.current;
    setDocumentTask({ id: file.id, name: file.name });
    setOverviewRefresh((n) => n + 1);
    if (!workflow || workflow.step === 'cancelled') return;
    try {
      const current = await api<Workflow>(`/chats/${workflow.chat_id}/workflow`, {
        workspace: props.workspace,
      });
      checkView(generation);
      const next = await api<Workflow>(`/chats/${workflow.chat_id}/workflow`, {
        workspace: props.workspace,
        method: 'PATCH',
        body: { version: current.version, config: { ...current.config, document_id: file.id } },
      });
      if (stillHere(generation)) setWorkflow(next);
    } catch (e) {
      if (stillHere(generation) && (e as Error).name !== 'AbortError') setError(errorText(e));
    }
  }
  async function stopWorkflow() {
    if (!workflow || stoppingWorkflow) return;
    const selected = workflow;
    const generation = viewGeneration.current;
    setStoppingWorkflow(true);
    if (!data?.run) streamRequest.current?.abort();
    try {
      if (data?.run && activeAgentRun(data.run)) {
        const runPath = `/chats/${data.run.chat_id}/runs/${data.run.id}`;
        let result = await api<AgentRunResult>(`${runPath}/cancel`, {
          workspace: props.workspace,
          method: 'POST',
          body: {},
        });
        publishAgentActivity(props.runOwner, result.detail.chat, result);
        if (stillHere(generation)) receiveRun(result);
        while (activeAgentRun(result.run)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          result = await api<AgentRunResult>(runPath, { workspace: props.workspace });
        }
      }
      const endpoint = `/chats/${selected.chat_id}/workflow`;
      let next: Workflow;
      try {
        next = await api<Workflow>(`${endpoint}/cancel`, {
          workspace: props.workspace,
          method: 'POST',
          body: { version: selected.version },
        });
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 409) throw e;
        const current = await api<Workflow | null>(endpoint, { workspace: props.workspace });
        checkView(generation);
        if (
          !current ||
          current.id !== selected.id ||
          JSON.stringify(current.config) !== JSON.stringify(selected.config)
        )
          throw e;
        next =
          current.step === 'cancelled'
            ? current
            : await api<Workflow>(`${endpoint}/cancel`, {
                workspace: props.workspace,
                method: 'POST',
                body: { version: current.version },
              });
      }
      checkView(generation);
      setWorkflow(next);
      setPending(null);
      setBody('');
      sendRequest.current = null;
      setOverviewRefresh((n) => n + 1);
    } catch (e) {
      if (stillHere(generation) && (e as Error).name !== 'AbortError') setError(errorText(e));
    } finally {
      if (stillHere(generation)) {
        setBusy(false);
        setStoppingWorkflow(false);
      }
    }
  }
  async function stopReply() {
    if (!data?.run || !activeAgentRun(data.run) || stoppingWorkflow) return;
    const generation = viewGeneration.current;
    setStoppingWorkflow(true);
    try {
      const result = await api<AgentRunResult>(
        `/chats/${data.run.chat_id}/runs/${data.run.id}/cancel`,
        { workspace: props.workspace, method: 'POST', body: {} },
      );
      publishAgentActivity(props.runOwner, result.detail.chat, result);
      if (stillHere(generation)) receiveRun(result);
    } catch (e) {
      if (stillHere(generation)) setError(errorText(e));
    } finally {
      if (stillHere(generation)) setStoppingWorkflow(false);
    }
  }
  async function openOverview(item: HomeOverviewItem) {
    const generation = viewGeneration.current;
    if (item.kind === 'workflow' && item.chat_id) {
      try {
        const detail = await api<ChatDetail>(`/chats/${item.chat_id}`, {
          workspace: props.workspace,
        });
        checkView(generation);
        props.onChat(detail.chat);
      } catch (e) {
        if (stillHere(generation) && (e as Error).name !== 'AbortError') setError(errorText(e));
      }
      return;
    }
    if (item.kind === 'mail') {
      if (item.customer_id)
        void startWorkflow('reply', {
          customer_id: item.customer_id,
          person_id: item.person_id,
          project_id: item.project_id,
          mail_id: item.id,
          source_kinds: ['mail'],
          date_start: null,
          date_end: null,
        });
      else setMailSource(item.id);
      return;
    }
    if (item.kind === 'document') {
      setOpenDocument(item.id);
      return;
    }
    setError('');
    try {
      if (item.kind === 'wechat') {
        const preview = await api<WeChatPreview>(`/wechat/queries/${item.id}`, {
          workspace: props.workspace,
        });
        checkView(generation);
        setWeChatPreview(preview);
        return;
      }
      const draft = await api<OutgoingMail>(`/outgoing/${item.id}`, { workspace: props.workspace });
      checkView(generation);
      if (draft.person_id) {
        const person = await api<Person>(`/people/${draft.person_id}`, {
          workspace: props.workspace,
        });
        checkView(generation);
        setCompose({ person, kind: 'people', draftId: draft.id });
      } else {
        const customer = await api<Customer>(`/customers/${draft.customer_id}`, {
          workspace: props.workspace,
        });
        checkView(generation);
        setCompose({
          person: {
            id: customer.id,
            customer_id: customer.id,
            name: customer.name,
            customer_name: customer.name,
            email: customer.email,
          },
          kind: 'customers',
          draftId: draft.id,
        });
      }
    } catch (e) {
      if (stillHere(generation) && (e as Error).name !== 'AbortError') setError(errorText(e));
    }
  }
  async function send(action: ChatAction = 'message', retry?: PendingMessage) {
    if (busy || submitting.current) return;
    const generation = viewGeneration.current;
    if (retry?.run && capabilities?.background_runs) {
      submitting.current = true;
      setBusy(true);
      setError('');
      try {
        const result = await submitAgentRun(
          props.runOwner,
          props.workspace,
          { id: retry.run.chat_id },
          `/chats/${retry.run.chat_id}/runs/${retry.run.id}/retry`,
          {},
        );
        if (stillHere(generation)) receiveRun(result);
      } catch (e) {
        if (stillHere(generation)) setPending({ ...retry, answer: '', error: errorText(e) });
      } finally {
        submitting.current = false;
        if (stillHere(generation)) setBusy(false);
      }
      return;
    }
    if (retry?.workflow) {
      if (
        !workflow ||
        workflow.id !== retry.workflow.id ||
        workflow.version !== retry.workflow.version ||
        workflow.step === 'cancelled'
      ) {
        setError('任务条件已变化，请按当前条件重新开始');
        setPending(null);
        return;
      }
      await runWorkflow(
        workflow,
        retry.body,
        retry.workflow.phase,
        retry.workflow.task_action || 'message',
        retry,
      );
      return;
    }
    if (!retry && action === 'message' && workflow && workflow.step !== 'cancelled') {
      if (workflowEditing) {
        setError('请先在任务卡中确认当前条件，再开始处理');
        return;
      }
      await runWorkflow(
        workflow,
        body.trim(),
        workflow.kind === 'reply' && workflow.result ? 'draft' : 'analyze',
      );
      return;
    }
    if (action !== 'message' && !data?.chat.customer_id) {
      setError('请先输入公司名称或邮箱查询，再点击匹配结果中的“就此客户提问”。');
      return;
    }
    setBusy(true);
    submitting.current = true;
    setError('');
    const draft = retry || { body, material, action, answer: '' };
    const draftBody = retry?.requestBody ?? draft.body;
    const label =
      draftBody.trim() ||
      {
        overview: '查看客户档案',
        activity: '查看客户最近动态',
        web_research: '研究公司公开信息',
        message: draft.material?.name || '分析资料',
      }[action];
    setPending({ ...draft, body: label, requestBody: draftBody, answer: '', error: undefined });
    if (!retry) {
      setBody('');
      setMaterial(null);
    }
    const controller = new AbortController();
    streamRequest.current = controller;
    let modelRequestPending = false;
    try {
      const title =
        draftBody.trim() ||
        {
          overview: '客户档案',
          activity: '客户动态',
          web_research: '公司研究',
          message: draft.material?.name || '新对话',
        }[action];
      const chat = await ensureChat(title);
      if (!capabilities?.background_runs) checkView(generation, controller.signal);
      const fingerprint = JSON.stringify({
        chat: chat.id,
        action,
        body: draftBody,
        material: draft.material,
        candidate_selection: draft.candidate_selection,
      });
      if (sendRequest.current?.fingerprint !== fingerprint)
        sendRequest.current = { fingerprint, id: crypto.randomUUID() };
      modelRequestPending = true;
      const payload = {
        request_id: sendRequest.current.id,
        action,
        body: draftBody,
        ...(draft.candidate_selection ? { candidate_selection: draft.candidate_selection } : {}),
        ...(draft.material ? { material: draft.material } : {}),
      };
      if (capabilities?.background_runs) {
        publishAgentActivity(props.runOwner, { ...chat, run_status: 'queued' });
        const result = await submitAgentRun(
          props.runOwner,
          props.workspace,
          chat,
          `/chats/${chat.id}/runs`,
          { kind: 'message', payload },
          { ref: sendRequest, id: payload.request_id },
        );
        if (stillHere(generation)) {
          receiveRun(result);
          if (!props.chatId && foreground.current) props.onChat(result.detail.chat);
        }
        return;
      }
      const next = await streamApi<ChatDetail>(`/chats/${chat.id}/messages`, {
        workspace: props.workspace,
        signal: controller.signal,
        onText: (answer) => setPending((p) => (p ? { ...p, answer } : p)),
        body: payload,
      });
      checkView(generation, controller.signal);
      modelRequestPending = false;
      sendRequest.current = null;
      setModelConnection('connected');
      setData(next);
      setPending(null);
      const newPreview = next.wechat_previews?.find(
        (p) => !data?.wechat_previews?.some((v) => v.id === p.id),
      );
      const previewForFollowup = newPreview
        ? await api<WeChatPreview>(`/wechat/queries/${newPreview.id}`, {
            workspace: props.workspace,
          })
        : undefined;
      checkView(generation, controller.signal);
      if (previewForFollowup) setWeChatPreview(previewForFollowup);
      if (next.wechat_request) setWeChatChoice(next.wechat_request);
      props.onChat(next.chat, { preview: previewForFollowup, request: next.wechat_request });
      setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50);
    } catch (e) {
      if (stillHere(generation) && !controller.signal.aborted) {
        if (
          capabilities?.background_runs &&
          e instanceof HttpError &&
          e.status === 409 &&
          created.current
        ) {
          const detail = await api<ChatDetail>(`/chats/${created.current.id}`, {
            workspace: props.workspace,
          }).catch(() => null);
          if (stillHere(generation) && detail?.run && activeAgentRun(detail.run)) {
            receiveRun({ run: detail.run, detail });
            setBody(draftBody);
            setMaterial(draft.material);
            setError('当前消息仍在处理中，已保留本次输入，请稍后再发送');
            return;
          }
        }
        if (
          modelRequestPending &&
          (e instanceof TypeError ||
            (e instanceof HttpError && [429, 502, 503, 504].includes(e.status)))
        )
          setModelConnection('unavailable');
        if (e instanceof HttpError && [403, 404].includes(e.status)) setData(null);
        setPending({
          ...draft,
          body: label,
          requestBody: draftBody,
          answer: '',
          error: errorText(e),
        });
      }
    } finally {
      submitting.current = false;
      if (stillHere(generation)) setBusy(false);
    }
  }
  async function commit(plan: ImportPlan) {
    if (busy || !data) return;
    setBusy(true);
    setError('');
    try {
      await api(`/chats/${data.chat.id}/imports/${plan.id}/commit`, {
        workspace: props.workspace,
        method: 'POST',
        body: {},
      });
      const next = await api<ChatDetail>(`/chats/${data.chat.id}`, { workspace: props.workspace });
      setData(next);
      props.onChat(next.chat);
      props.onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const customerId = data?.chat.customer_id;
  const customerName = data?.chat.customer_name;
  const askOrigin = data?.chat.origin;
  useEffect(() => {
    setNoteSaving(null);
    return () => noteRequest.current?.abort();
  }, [props.workspace, props.chatId, props.runOwner]);
  async function organizeReplyAsNote(message: ChatMessage) {
    if (
      busy ||
      noteSaving ||
      (noteRequest.current && !noteRequest.current.signal.aborted) ||
      !data ||
      !canOrganizeAnswerAsNote(message.sources)
    )
      return;
    const generation = viewGeneration.current;
    const key = `${data.chat.id}:${message.id}`;
    const requestId = noteRequestIds.current.get(key) || crypto.randomUUID();
    noteRequestIds.current.set(key, requestId);
    const controller = new AbortController();
    noteRequest.current = controller;
    setNoteSaving(message.id);
    setError('');
    try {
      const result = await organizeAnswerAsNote(
        props.workspace,
        { request_id: requestId, chat_id: data.chat.id, message_id: message.id },
        controller.signal,
      );
      if (stillHere(generation) && foreground.current && !controller.signal.aborted)
        openAgentNoteDraft(
          props.workspace,
          result.draft,
          props.runOwner.slice(props.workspace.length + 1),
        );
    } catch (e) {
      if (stillHere(generation) && !controller.signal.aborted) setError(errorText(e));
    } finally {
      if (noteRequest.current === controller) noteRequest.current = null;
      if (stillHere(generation) && !controller.signal.aborted) setNoteSaving(null);
    }
  }
  async function startCustomerChat(source: AskSource) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const chat = await api<Chat>('/chats', {
        workspace: props.workspace,
        method: 'POST',
        body: {
          id: crypto.randomUUID(),
          title: `${source.title} · 客户对话`.slice(0, 80),
          customer_id: source.customer_id,
        },
      });
      props.onChat(chat);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function openSource(source: AskSource) {
    if (source.kind === 'entity') {
      if (props.onSelect)
        props.onSelect({
          customerId: source.customer_id,
          full: true,
          ...(source.object === 'people' ? { personId: source.id } : {}),
          ...(source.object === 'projects' ? { projectId: source.id } : {}),
        });
      else props.onCustomer(source.customer_id);
      return;
    }
    evidenceRequest.current?.abort();
    const controller = new AbortController();
    evidenceRequest.current = controller;
    const generation = viewGeneration.current;
    setEvidence(null);
    try {
      const result = await api<AskEvidence>('/ask/source', {
        workspace: props.workspace,
        method: 'POST',
        signal: controller.signal,
        body: {
          scope: askOrigin?.scope || {
            kind: 'entity',
            object: 'customers',
            customer_id: source.customer_id,
            record_id: source.customer_id,
          },
          kind: source.kind,
          id: source.id,
        },
      });
      if (stillHere(generation) && !controller.signal.aborted) setEvidence(result);
    } catch (e) {
      if (stillHere(generation) && !controller.signal.aborted) setError(errorText(e));
    }
  }
  if (loading || viewWorkspace !== props.workspace)
    return <div className="agent-loading">正在打开对话…</div>;
  if (props.chatId && !data && !pending)
    return (
      <div className="agent-loading">
        <p role="alert">{error || '对话不可用'}</p>
        <button
          onClick={() => {
            setLoading(true);
            setLoadKey((k) => k + 1);
          }}
        >
          重新加载
        </button>
      </div>
    );
  return (
    <div
      className={`agent-page ${data || pending ? 'has-conversation' : ''}`}
      onDragOver={(e) => {
        if (!busy && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        if (busy) return;
        if (e.dataTransfer.files.length > 1) {
          setError('请一次添加一个文件');
          return;
        }
        receiveFile(e.dataTransfer.files[0]);
      }}
    >
      {prospectIntake && (
        <Dialog
          title="从资料识别咨询与跟进状态"
          className="prospect-intake-dialog"
          onClose={() => {
            if (prospectIntakeBusy) return;
            if (prospectIntakeDirty) setProspectLeaving(true);
            else setProspectIntake(false);
          }}
        >
          <ProspectIntake
            workspace={props.workspace}
            customerId={customerId || undefined}
            onDirty={setProspectIntakeDirty}
            onBusy={setProspectIntakeBusy}
            onCreated={() => {
              prospectsChanged(props.workspace);
              setProspectIntakeDirty(false);
              setProspectIntake(false);
              setProspectNotice('咨询已录入资料库“潜在客户”，已分派的未完成条件会显示在待办。');
            }}
            onClose={() => {
              if (!prospectIntakeBusy) {
                if (prospectIntakeDirty) setProspectLeaving(true);
                else setProspectIntake(false);
              }
            }}
          />
        </Dialog>
      )}
      {prospectLeaving && (
        <Dialog title="本次推荐尚未录入" onClose={() => setProspectLeaving(false)}>
          <p className="dialog-copy">本次候选和修改尚未写入正式跟进状态。</p>
          <footer className="form-footer">
            <button onClick={() => setProspectLeaving(false)}>继续整理</button>
            <button
              onClick={() => {
                setProspectLeaving(false);
                setProspectIntakeDirty(false);
                setProspectIntake(false);
              }}
            >
              放弃本次编辑并关闭
            </button>
          </footer>
        </Dialog>
      )}
      {compose && (
        <MailComposer
          workspace={props.workspace}
          person={compose.person}
          kind={compose.kind}
          draftId={compose.draftId}
          reply={composeReply}
          onClose={() => {
            setCompose(null);
            setOverviewRefresh((n) => n + 1);
          }}
          onChanged={() => {
            setOverviewRefresh((n) => n + 1);
          }}
        />
      )}
      {mailSource && (
        <MailDialog
          workspace={props.workspace}
          id={mailSource}
          onClose={() => {
            setMailSource(null);
            setOverviewRefresh((n) => n + 1);
          }}
          onSelect={props.onSelect}
          onAssigned={() => setOverviewRefresh((n) => n + 1)}
        />
      )}
      {workflowWeChat && workflow && (
        <Dialog title="读取指定微信记录" onClose={() => setWorkflowWeChat(false)}>
          <WeChatQueryForm
            workspace={props.workspace}
            chatId={workflow.chat_id}
            workflowVersion={workflow.version}
            initial={{
              start: workflow.config.date_start || '',
              end: workflow.config.date_end || '',
            }}
            onResult={(result) => {
              if (result.preview) {
                setWorkflowWeChat(false);
                setWeChatPreview(result.preview);
                setOverviewRefresh((n) => n + 1);
                if (result.preview.state === 'associated') {
                  const preview = result.preview;
                  const generation = viewGeneration.current;
                  void api<Workflow | null>(`/chats/${workflow.chat_id}/workflow`, {
                    workspace: props.workspace,
                  })
                    .then(async (current) => {
                      checkView(generation);
                      if (!current || current.step === 'cancelled') return;
                      const next = await api<Workflow>(`/chats/${current.chat_id}/workflow`, {
                        workspace: props.workspace,
                        method: 'PATCH',
                        body: {
                          version: current.version,
                          config: {
                            ...current.config,
                            source_kinds: [...new Set([...current.config.source_kinds, 'wechat'])],
                            ...(!current.config.mail_id && !current.config.document_id
                              ? { date_start: preview.start, date_end: preview.end }
                              : {}),
                          },
                        },
                      });
                      checkView(generation);
                      setWorkflow(next);
                    })
                    .catch((e) => {
                      if (stillHere(generation) && e.name !== 'AbortError') setError(errorText(e));
                    });
                }
              }
            }}
          />
        </Dialog>
      )}
      {(documentFile || workflowUpload) && (
        <DocumentUploadDialog
          workspace={props.workspace}
          initialFile={documentFile || undefined}
          customer={
            workflow?.config.customer_id
              ? { id: workflow.config.customer_id, name: workflow.customer_name || '当前公司' }
              : customerId
                ? { id: customerId, name: customerName || '当前公司' }
                : undefined
          }
          project={
            workflow?.config.project_id
              ? { id: workflow.config.project_id, name: workflow.project_name || '当前项目' }
              : undefined
          }
          onClose={() => {
            setDocumentFile(null);
            setWorkflowUpload(false);
          }}
          onUploaded={(file) => void bindDocument(file)}
        />
      )}
      {openDocument && (
        <DocumentDetailDialog
          workspace={props.workspace}
          id={openDocument}
          onClose={() => setOpenDocument(null)}
          onSelect={props.onSelect}
        />
      )}
      {evidence && (
        <Dialog
          title={evidence.title}
          className="ask-evidence-dialog"
          onClose={() => setEvidence(null)}
        >
          <div className="ask-evidence-body">{evidence.body}</div>
        </Dialog>
      )}
      {wechatPreview && (
        <WeChatReviewDialog
          key={wechatPreview.id}
          preview={wechatPreview}
          workspace={props.workspace}
          onClose={() => setWeChatPreview(null)}
          onAssociated={(p) => {
            setWeChatPreview(p);
            setData((d) =>
              d
                ? { ...d, wechat_previews: d.wechat_previews?.map((v) => (v.id === p.id ? p : v)) }
                : d,
            );
            props.onChanged();
            setOverviewRefresh((n) => n + 1);
            if (workflow && workflow.step !== 'cancelled')
              void api<Workflow | null>(`/chats/${workflow.chat_id}/workflow`, {
                workspace: props.workspace,
              })
                .then((current) => {
                  if (!current) return;
                  return api<Workflow>(`/chats/${current.chat_id}/workflow`, {
                    workspace: props.workspace,
                    method: 'PATCH',
                    body: {
                      version: current.version,
                      config: {
                        ...current.config,
                        source_kinds: [...new Set([...current.config.source_kinds, 'wechat'])],
                      },
                    },
                  });
                })
                .then((next) => {
                  if (next) setWorkflow(next);
                })
                .catch((e) => setError(errorText(e)));
          }}
        />
      )}
      {wechatChoice && (
        <Dialog title="选择微信身份与查询日期" onClose={() => setWeChatChoice(undefined)}>
          <p className="dialog-copy">匹配到多个身份，请确认具体联系人后读取。</p>
          <WeChatQueryForm
            workspace={props.workspace}
            initial={wechatChoice.request}
            initialCandidates={wechatChoice.candidates}
            chatId={data?.chat.id}
            onResult={(r) => {
              if (r.preview) {
                setWeChatChoice(undefined);
                setWeChatPreview(r.preview);
                setData((d) =>
                  d ? { ...d, wechat_previews: [r.preview, ...(d.wechat_previews || [])] } : d,
                );
              }
            }}
          />
        </Dialog>
      )}
      <div className="agent-thread">
        {!data && !pending && (
          <header className="agent-greeting">
            <h1>
              <span className="agent-brand-logo" aria-hidden="true">
                <img src={typhaLogo} alt="" />
              </span>
              <span className="agent-brand-wordmark">
                <span>Typha</span> <span className="agent-brand-descriptor">AI CRM</span>
              </span>
            </h1>
          </header>
        )}
        <div className={data || pending ? 'chat-transcript' : undefined}>
          <div className={data || pending ? 'chat-transcript-content' : undefined}>
            {(data || pending) && (
              <div className="chat-messages" aria-live="polite">
                {(data?.messages || []).map((m) => (
                  <Message
                    key={m.id}
                    className={m.role}
                    aria-label={m.role === 'assistant' ? '助手回复' : '你的消息'}
                  >
                    {m.role === 'assistant' &&
                      (m.action === 'overview' || m.action === 'activity') &&
                      !agentRecordReplySource(m, customerId) && (
                        <div className="chat-source-chip">
                          <Check size={12} />
                          {m.action === 'overview' ? '已读取客户档案' : '已读取客户动态'}
                        </div>
                      )}
                    <MessageContent>
                      {m.role === 'assistant' ? (
                        m.retrieval?.status === 'candidates' ? (
                          <AgentCandidateCards
                            retrieval={m.retrieval}
                            busy={busy}
                            inactive={data?.messages.at(-1)?.id !== m.id}
                            onSelect={(index) =>
                              void send('message', {
                                body: `选择第${index}个候选`,
                                material: null,
                                action: 'message',
                                answer: '',
                                candidate_selection: { message_id: m.id, index },
                              })
                            }
                          />
                        ) : m.retrieval?.status === 'listed' ? (
                          <AgentListedCustomerCards
                            retrieval={m.retrieval}
                            disabled={busy}
                            onOpen={(source) => void openSource(source)}
                          />
                        ) : (
                          <ChatReply
                            message={m}
                            customerId={customerId}
                            onOpen={(source) => void openSource(source)}
                            disabled={busy}
                          />
                        )
                      ) : (
                        m.body
                      )}
                    </MessageContent>
                    {m.role === 'assistant' && !!m.sources?.length && (
                      <AgentReplySources
                        sources={m.sources}
                        exclude={
                          m.retrieval?.status === 'candidates'
                            ? m.retrieval.candidates
                            : agentListedCustomerItems(m.retrieval)
                        }
                        disabled={busy}
                        onOpen={(source) => void openSource(source)}
                        onCustomerChat={
                          m.lookup ? (source) => void startCustomerChat(source) : undefined
                        }
                      />
                    )}
                    {m.role === 'assistant' && (
                      <MessageActions>
                        <button
                          className="icon-button"
                          aria-label="复制回复"
                          title="复制回复"
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(agentReplyCopyText(m.body, m.retrieval))
                              .then(() => setCopied(m.id))
                              .catch(() => setError('复制失败，请选中文字后复制'))
                          }
                        >
                          {copied === m.id ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                        {copied === m.id && <span>已复制</span>}
                        {capabilities?.notes &&
                          m.model &&
                          m.retrieval?.status !== 'candidates' &&
                          m.retrieval?.status !== 'listed' &&
                          canOrganizeAnswerAsNote(m.sources) && (
                            <button
                              className="text-button"
                              disabled={busy || Boolean(noteSaving)}
                              title="按当前授权来源重新整理为本人草稿，过目保存后才供同事和 Agent 使用"
                              onClick={() => void organizeReplyAsNote(m)}
                            >
                              <FileText size={13} />
                              {noteSaving === m.id ? '正在整理…' : '整理为笔记'}
                            </button>
                          )}
                      </MessageActions>
                    )}
                    {m.material && (
                      <details className="chat-material">
                        <summary>
                          <FileText size={14} />
                          {m.material.name}
                        </summary>
                        <pre>{m.material.content}</pre>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            setMaterial(m.material);
                            setImporting(true);
                          }}
                        >
                          作为表格导入
                          <Table2 size={13} />
                        </button>
                      </details>
                    )}
                  </Message>
                ))}
                {pending && (
                  <>
                    <Message className="user" aria-label="你的消息">
                      <MessageContent>{pending.body}</MessageContent>
                      {pending.material && <small>{pending.material.name}</small>}
                    </Message>
                    <Message className="assistant" aria-label="助手回复" aria-busy={busy}>
                      {busy && workflow && workflow.step !== 'cancelled' && (
                        <button
                          className="text-button"
                          disabled={stoppingWorkflow}
                          onClick={() => void stopWorkflow()}
                        >
                          {stoppingWorkflow ? '正在停止…' : '停止并取消流程'}
                        </button>
                      )}
                      {busy && data?.run && !workflow && (
                        <button
                          className="text-button"
                          disabled={stoppingWorkflow || data.run.status === 'cancelling'}
                          onClick={() => void stopReply()}
                        >
                          {stoppingWorkflow || data.run.status === 'cancelling'
                            ? '正在停止…'
                            : '停止回复'}
                        </button>
                      )}
                      {pending.error ? (
                        <div className="chat-stream-error" role="alert">
                          <p>{pending.error}</p>
                          <button
                            disabled={busy}
                            onClick={() => void send(pending.action, pending)}
                          >
                            重试
                          </button>
                        </div>
                      ) : pending.answer ? (
                        <>
                          <small className="chat-stream-label">
                            {reconnecting ? '正在恢复连接，任务继续处理中' : '正在回复'}
                          </small>
                          <MessageContent>
                            <AgentAnswer body={pending.answer} />
                          </MessageContent>
                        </>
                      ) : (
                        <div className="chat-working" role="status">
                          <span />
                          {reconnecting
                            ? '正在恢复连接，任务继续处理中'
                            : data?.run?.status === 'cancelling'
                              ? '正在停止…'
                              : '正在思考'}
                        </div>
                      )}
                    </Message>
                  </>
                )}
              </div>
            )}
            {data?.wechat_previews?.map((p) => (
              <div className="agent-reply-entry" key={p.id}>
                <AgentReplyCard
                  title={p.identity.remark || p.identity.name}
                  typeLabel="微信会话"
                  icon={<MessageSquare size={19} strokeWidth={1.6} />}
                  fields={[
                    { label: '日期范围', value: `${p.start} 至 ${p.end}` },
                    { label: '归属状态', value: p.state === 'associated' ? '已归档' : '待关联' },
                  ]}
                  footer="来自本次指定读取"
                  action={{
                    label: '查看会话',
                    onClick: () =>
                      void api<WeChatPreview>(`/wechat/queries/${p.id}`, {
                        workspace: props.workspace,
                      })
                        .then(setWeChatPreview)
                        .catch((e) => setError(e.message)),
                  }}
                />
              </div>
            ))}
            {data?.imports.map((plan) => (
              <ImportCard
                key={plan.id}
                plan={plan}
                tablePreferenceKey={props.tablePreferenceKey}
                busy={busy}
                onCommit={() => void commit(plan)}
                onOpen={() => props.onRecords(plan.object, plan.result?.list_id)}
              />
            ))}
            {data && customerId && !askOrigin && !workflow && (
              <div className="chat-next-actions">
                <button disabled={busy} onClick={() => void send('activity')}>
                  <ArrowUpRight size={13} />
                  查看这家客户的最近动态
                </button>
                <button onClick={() => props.onCustomer(customerId)}>
                  <ArrowUpRight size={13} />
                  打开客户档案，继续完善资料
                </button>
                <button disabled={busy} onClick={() => setImporting(true)}>
                  <ArrowUpRight size={13} />
                  导入关联联系人或项目
                </button>
              </div>
            )}
            {workflow && (
              <HomeWorkflow
                key={workflow.id}
                workspace={props.workspace}
                actorKey={props.runOwner}
                workflow={workflow}
                busy={busy}
                members={props.members}
                templateWorkflows={capabilities?.mail_template_workflows}
                onEditingChange={setWorkflowEditing}
                onWorkflow={(next) => {
                  setWorkflow(next);
                  setPending(null);
                  sendRequest.current = null;
                  setOverviewRefresh((n) => n + 1);
                }}
                onRun={runWorkflow}
                onCancel={() => {
                  setPending(null);
                  setBody('');
                  sendRequest.current = null;
                }}
                onOpenMail={(result) => {
                  setWorkflow(result.workflow);
                  setCompose(workflowMailComposerState(result));
                  setOverviewRefresh((n) => n + 1);
                }}
                onRelated={(kind, config) =>
                  void startWorkflow(kind, {
                    ...config,
                    instruction: '',
                    field_ids: [],
                  })
                }
                onUpload={() => setWorkflowUpload(true)}
                onReadWeChat={() => setWorkflowWeChat(true)}
              />
            )}
            {busy && !pending && (
              <div className="chat-working" role="status">
                <span />
                正在处理…
              </div>
            )}
            <div ref={end} />
          </div>
        </div>
        {documentTask && (
          <div className="agent-reply-entry is-upload">
            <AgentReplyCard
              title={documentTask.name}
              typeLabel="上传文件"
              icon={<FileText size={19} strokeWidth={1.6} />}
              description="文件已保存，可从左侧“文件”页持续查看处理状态"
              footer="来自本次上传"
              action={{ label: '查看文件', onClick: () => setOpenDocument(documentTask.id) }}
            />
          </div>
        )}
        <PromptInput
          className="agent-composer"
          value={body}
          onValueChange={setBody}
          onSubmit={() => void send()}
          disabled={busy}
          canSubmit={Boolean(body.trim() || material) && !workflowEditing}
        >
          <label className="sr-only" htmlFor="agent-prompt">
            向助手描述需求
          </label>
          <PromptInputTextarea
            id="agent-prompt"
            placeholder={
              workflowEditing
                ? '先在上方任务卡选择条件并开始，之后可在这里继续补充…'
                : askOrigin
                  ? `继续询问${askOrigin.label}…`
                  : '向 Typha 提问，或添加客户资料…'
            }
            maxLength={askOrigin ? 2000 : 10000}
          />
          {material && (
            <div className="attached-material">
              <FileText size={14} />
              <span>{material.name}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="移除附件"
                disabled={busy}
                onClick={() => setMaterial(null)}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <PromptInputActions className="composer-tools">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt,.md,.pdf,.docx"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) receiveFile(f);
                e.target.value = '';
              }}
            />
            {!askOrigin && (
              <button
                className="icon-button"
                type="button"
                title="上传 PDF、DOCX（10 MB 内），或 CSV、TSV、TXT、Markdown（40 KB 内）；也可拖入"
                aria-label="上传资料"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={16} />
              </button>
            )}
            {(data || created.current) &&
              (askOrigin ? (
                <span className="composer-scope" title="本次对话继续使用来源页面的查询范围">
                  <MessageSquare size={13} />
                  {askOrigin.label}
                </span>
              ) : customerId ? (
                <button
                  type="button"
                  className="scope-button"
                  onClick={() => props.onCustomer(customerId)}
                >
                  <Building2 size={13} />
                  {customerName}
                  <ArrowUpRight size={11} />
                </button>
              ) : (
                <span className="composer-scope">
                  <FileText size={13} />
                  资料收件区
                </span>
              ))}
            <span
              className={`model-status${modelReady ? ' is-ready' : ''}`}
              title={
                modelConnection === 'unavailable'
                  ? 'AI 服务连接异常，请重试'
                  : 'AI 服务由系统统一提供'
              }
            >
              <i />
              {modelConnection === 'unavailable'
                ? busy
                  ? '正在重新连接'
                  : 'AI 连接异常'
                : modelReady
                  ? 'M3.1 Flash'
                  : capabilities
                    ? 'AI 服务暂未就绪'
                    : '连接服务中'}
            </span>
            <button
              className="send-message"
              type="submit"
              aria-label="发送消息"
              disabled={busy || workflowEditing || (!body.trim() && !material)}
            >
              <ArrowUp size={17} />
            </button>
          </PromptInputActions>
        </PromptInput>
        {error && (
          <p role="alert" className="error agent-error">
            {error}
          </p>
        )}
        {capabilities?.home_workflows && !askOrigin && !data && !pending && (
          <div className="agent-shortcuts" role="group" aria-label="开始一项工作">
            <button type="button" disabled={busy} onClick={() => void startWorkflow('summary')}>
              <MessageSquareText size={14} strokeWidth={1.7} aria-hidden="true" />
              总结沟通信息
            </button>
            <button type="button" disabled={busy} onClick={() => void startWorkflow('reply')}>
              <Mail size={14} strokeWidth={1.7} aria-hidden="true" />
              处理客户来信
            </button>
            <button type="button" disabled={busy} onClick={() => void startWorkflow('update')}>
              <PencilLine size={14} strokeWidth={1.7} aria-hidden="true" />
              更新客户资料
            </button>
            {capabilities.prospect_intake && (
              <button type="button" disabled={busy} onClick={() => setProspectIntake(true)}>
                <PencilLine size={14} strokeWidth={1.7} aria-hidden="true" />
                录入潜在客户
              </button>
            )}
          </div>
        )}
        {prospectNotice && (
          <p className="muted" role="status">
            {prospectNotice}
          </p>
        )}
        {capabilities?.home_workflows && !data && !pending && (
          <HomeOverview
            workspace={props.workspace}
            refresh={props.refresh + overviewRefresh}
            onItem={(item) => void openOverview(item)}
          />
        )}
        {!data && !pending && (
          <HomeProjects
            workspace={props.workspace}
            refresh={props.refresh}
            members={props.members}
            onOpen={props.onProject}
            onAll={() => props.onRecords('projects')}
          />
        )}
      </div>
      {importing && (
        <ImportDialog
          workspace={props.workspace}
          admin={props.admin}
          customerId={customerId || null}
          material={material}
          onClose={() => setImporting(false)}
          onPreview={async (input) => {
            const chat = await ensureChat(
              `导入${objectLabels[input.object]}${input.list_name ? ` · ${input.list_name}` : ''}`,
            );
            await api(`/chats/${chat.id}/imports`, {
              workspace: props.workspace,
              method: 'POST',
              body: input,
            });
            const next = await api<ChatDetail>(`/chats/${chat.id}`, { workspace: props.workspace });
            setData(next);
            setImporting(false);
            setMaterial(null);
            props.onChat(next.chat);
          }}
        />
      )}
    </div>
  );
}
function ChatReply({
  message,
  customerId,
  onOpen,
  disabled,
}: {
  message: ChatMessage;
  customerId?: string | null;
  onOpen: (source: AskSource) => void;
  disabled: boolean;
}) {
  const source = agentRecordReplySource(message, customerId);
  if (
    source ||
    (message.action === 'overview' && customerId) ||
    (message.lookup && message.lookup.total > 0 && message.sources?.length)
  )
    return (
      <AgentRecordAnswerCard
        source={source}
        body={message.body}
        onOpen={onOpen}
        disabled={disabled}
      />
    );
  return <AgentAnswer body={message.body} overview={message.action === 'overview'} />;
}
function displayValue(plan: ImportPlan, key: string, value: unknown) {
  const labels: Record<string, string> | undefined =
    key === 'type'
      ? plan.object === 'customers'
        ? customerTypes
        : projectTypes
      : key === 'source'
        ? sources
        : key === 'status'
          ? customerStatuses
          : key === 'stage'
            ? projectStages
            : undefined;
  return labels?.[String(value)] || String(value ?? '—');
}
function ImportCard({
  plan,
  tablePreferenceKey,
  busy,
  onCommit,
  onOpen,
}: {
  plan: ImportPlan;
  tablePreferenceKey: string;
  busy: boolean;
  onCommit: () => void;
  onOpen: () => void;
}) {
  const invalid = plan.rows.filter((r) => r.error).length;
  const labels: Record<string, string> = {
    ...importFields[plan.object],
    type: '类型',
    source: '来源',
    status: '合作状态',
    stage: '项目阶段',
  };
  return (
    <AgentReplyCard
      className="is-wide import-card"
      title={objectLabels[plan.object]}
      typeLabel={plan.result ? '导入完成' : '导入预览'}
      icon={<Table2 size={19} strokeWidth={1.6} />}
      description={`${plan.rows.length} 条记录 · ${plan.list_name ? `新增记录，并加入新清单「${plan.list_name}」` : '新增到资料库'} · 不覆盖已有记录`}
      footer={
        plan.result ? (
          <span className="import-success">
            <Check size={15} />
            已创建 {plan.result.count} 条记录
          </span>
        ) : invalid ? (
          `${invalid} 行需要修正，请重新导入预览`
        ) : (
          '检查上面的名称、字段和目标后再写入'
        )
      }
      action={
        plan.result
          ? { label: `打开${plan.result.list_id ? '清单' : '记录'}`, onClick: onOpen }
          : {
              label: busy ? '处理中…' : `创建 ${plan.rows.length} 条记录`,
              onClick: onCommit,
              disabled: busy || invalid > 0,
              primary: true,
            }
      }
    >
      <div className="import-table-wrap">
        <ResizableTable
          storageKey={`${tablePreferenceKey}:import:${plan.object}`}
          columns={[
            { id: '_row', label: '序号', width: 44, fixed: true },
            ...plan.columns.map((id) => ({
              id,
              label: labels[id] || id,
              width: id === 'name' || id === 'email' ? 240 : 170,
            })),
            { id: '_check', label: '检查', width: 220 },
          ]}
        >
          <thead>
            <tr>
              <th>#</th>
              {plan.columns.map((k) => (
                <th key={k}>
                  {labels[k] || k}
                  <ColumnResizeHandle columnId={k} />
                </th>
              ))}
              <th>
                检查
                <ColumnResizeHandle columnId="_check" />
              </th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                {plan.columns.map((k) => (
                  <ExpandableCell key={k} label={labels[k] || k}>
                    {displayValue(plan, k, r.values[k])}
                  </ExpandableCell>
                ))}
                <ExpandableCell label="检查" className={r.error ? 'error' : 'import-valid'}>
                  {r.error || '可以创建'}
                </ExpandableCell>
              </tr>
            ))}
          </tbody>
        </ResizableTable>
      </div>
    </AgentReplyCard>
  );
}
type PreviewInput = {
  request_id: string;
  object: RecordObject;
  raw: string;
  mapping: Record<string, number>;
  defaults: { type?: string; source?: string };
  list_name: string | null;
};
function ImportDialog({
  admin,
  customerId,
  material,
  onClose,
  onPreview,
}: {
  workspace: string;
  admin: boolean;
  customerId: string | null;
  material: Material | null;
  onClose: () => void;
  onPreview: (input: PreviewInput) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [object, setObject] = useState<RecordObject>(customerId ? 'people' : 'customers');
  const [raw, setRaw] = useState(material?.content || '');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [type, setType] = useState('');
  const [source, setSource] = useState('');
  const [listName, setListName] = useState('');
  const [addList, setAddList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [parseError, setParseError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  useEffect(() => {
    setParseError('');
    if (!raw.trim()) {
      setHeaders([]);
      return;
    }
    try {
      const { headers: h } = parseTable(raw);
      setHeaders(h);
      const mapping: Record<string, number> = {};
      for (const [key, label] of Object.entries(importFields[object])) {
        const index = h.findIndex(
          (s) =>
            s.toLowerCase() === key ||
            s === label ||
            (key === 'name' &&
              ['名称', '公司', '联系人', '项目', 'Company', 'Person', 'Name'].includes(s)),
        );
        if (index >= 0) mapping[key] = index;
      }
      setMapping(mapping);
    } catch (e) {
      setHeaders([]);
      setParseError(errorText(e));
    }
  }, [raw, object]);
  return (
    <dialog
      ref={dialog}
      className="modal import-dialog"
      aria-label="导入表格"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>
          <Table2 size={18} />
          导入表格
        </h2>
        <button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭导入">
          <X size={18} />
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void onPreview({
            request_id: crypto.randomUUID(),
            object,
            raw,
            mapping,
            defaults: {
              ...(type ? { type } : {}),
              ...(source && object === 'customers' ? { source } : {}),
            },
            list_name: addList ? listName.trim() : null,
          })
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy}>
          <p className="import-intro">将表格转为可持续更新的记录。下一步先预览，不会立即写入。</p>
          <label>
            记录类型
            <select
              value={object}
              onChange={(e) => {
                setObject(e.target.value as RecordObject);
                setType('');
              }}
            >
              {!customerId && admin && <option value="customers">Companies · 公司</option>}
              {customerId && (
                <>
                  <option value="people">People · 联系人</option>
                  <option value="projects">Projects · 项目</option>
                </>
              )}
            </select>
          </label>
          {!customerId && !admin && (
            <p className="error">
              新增公司需要管理员权限。请关闭窗口，选择有编辑权限的客户后导入联系人或项目。
            </p>
          )}
          <div className="import-upload">
            <input
              ref={file}
              hidden
              type="file"
              accept=".csv,.tsv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void readFile(f)
                    .then((m) => setRaw(m.content))
                    .catch((e) => setError(errorText(e)));
                e.target.value = '';
              }}
            />
            <button type="button" onClick={() => file.current?.click()}>
              <Plus size={14} />
              选择 CSV / TSV
            </button>
            <span>或从电子表格复制，粘贴到下方 · 最多 100 行、40 KB</span>
          </div>
          <label>
            表格内容（第一行为表头）
            <textarea
              aria-label="导入表格内容"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={
                object === 'customers'
                  ? '公司名称,地区,邮箱\n示例公司,上海,hello@example.com'
                  : object === 'people'
                    ? '联系人姓名,职位,邮箱\n示例联系人,采购,sample@example.com'
                    : '项目名称,截止日期\n示例项目,2026-12-01'
              }
            />
          </label>
          {parseError && (
            <p className="error" role="alert">
              {parseError}
            </p>
          )}
          {!!headers.length && (
            <>
              <h3>字段对应</h3>
              <div className="import-mapping">
                {Object.entries(importFields[object]).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    {key === 'name' ? ' *' : ''}
                    <select
                      required={key === 'name'}
                      value={mapping[key] ?? ''}
                      onChange={(e) =>
                        setMapping((m) => {
                          const next = { ...m };
                          if (e.target.value === '') delete next[key];
                          else next[key] = Number(e.target.value);
                          return next;
                        })
                      }
                    >
                      <option value="">{key === 'name' ? '请选择列' : '不导入'}</option>
                      {headers.map((h, i) => (
                        <option value={i} key={i}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </>
          )}
          {object !== 'people' && (
            <div className="import-mapping">
              <label>
                本批次{object === 'customers' ? '公司' : '项目'}类型
                <select required value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">请选择</option>
                  {Object.entries(object === 'customers' ? customerTypes : projectTypes).map(
                    ([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ),
                  )}
                </select>
              </label>
              {object === 'customers' && (
                <label>
                  客源
                  <select required value={source} onChange={(e) => setSource(e.target.value)}>
                    <option value="">请选择</option>
                    {Object.entries(sources).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <label className="import-list-choice">
            <input
              type="checkbox"
              checked={addList}
              onChange={(e) => setAddList(e.target.checked)}
            />
            同时加入一个新 List
          </label>
          {addList && (
            <label>
              清单名称
              <input
                required
                maxLength={80}
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                placeholder="例如：秋季展会跟进"
              />
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button
              className="primary"
              disabled={!headers.length || (!customerId && !admin)}
              type="submit"
            >
              {busy ? '检查中…' : '生成导入预览'}
            </button>
          </footer>
        </fieldset>
      </form>
    </dialog>
  );
}
