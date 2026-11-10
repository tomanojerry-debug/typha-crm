import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  FileText,
  Link2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { Customer, Member, Person, Project } from '../shared/domain';
import type { CustomerList, PeopleList } from '../shared/views';
import {
  noteLimits,
  type NoteBlock,
  type NoteBlockKind,
  type NoteContent,
  type NoteDetail,
  type NoteDraft,
  type NoteListResponse,
  type NoteSourceRef,
  type NoteSummary,
  type NoteTemplate,
} from '../shared/notes';
import { api, HttpError } from './api';
import { ProspectSourceButton } from './ProspectSourceButton';
import { Dialog } from './WorkspaceUI';
import { WorkspacePageHeader, WorkspacePageTabs } from './WorkspacePage';
import { RecordEvidence } from './RecordEvidence';
import {
  editNoteBlock,
  NoteDraftWriter,
  noteCanPublish,
  noteContentOf,
  safeNoteHref,
} from './note-editor-state';
import './notes.css';

type Named = { id: string; name: string };
type SourceOption = NoteSourceRef & { person_ids?: string[]; person_scope_complete?: boolean };
export type OpenNoteRequest = {
  workspaceId?: string;
  actorId?: string;
  noteId?: string;
  draftId?: string;
  customerId?: string;
  projectId?: string;
  personId?: string;
};
const openEvent = 'crm:open-note';
const changedEvent = 'crm:notes-changed';
export function openNote(detail: OpenNoteRequest) {
  window.dispatchEvent(new CustomEvent(openEvent, { detail }));
}
function notesChanged(workspace: string) {
  window.dispatchEvent(new CustomEvent(changedEvent, { detail: { workspace } }));
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
const time = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
const knowledgeLabels: Record<NoteSummary['knowledge_state'], string> = {
  ready: '知识可检索',
  pending: '知识整理中',
  failed: '知识整理失败',
  not_required: '已关联原始来源',
  unavailable: '知识整理尚未启用',
};
const blockLabels: Record<NoteBlockKind, string> = {
  paragraph: '正文',
  heading: '小标题',
  bullet: '项目列表',
  numbered: '编号列表',
  quote: '引用段落',
};
function blankBlock(type: NoteBlockKind = 'paragraph'): NoteBlock {
  return { id: crypto.randomUUID(), type, text: '', origin: 'original', sources: [] };
}
function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**'))
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        const href = link ? safeNoteHref(link[2]) : null;
        return href && link ? (
          <a key={index} href={href} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        ) : (
          part
        );
      })}
    </>
  );
}
function ReadBlock({ block }: { block: NoteBlock }) {
  const content = <InlineText text={block.text} />;
  if (block.type === 'heading') return <h3>{content}</h3>;
  if (block.type === 'bullet')
    return (
      <ul>
        <li>{content}</li>
      </ul>
    );
  if (block.type === 'numbered')
    return (
      <ol>
        <li>{content}</li>
      </ol>
    );
  if (block.type === 'quote') return <blockquote>{content}</blockquote>;
  return <p>{content}</p>;
}

function useDirectory(workspace: string, customerId?: string | null, editable = false) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setCustomers([]);
    setError('');
    const load = async () => {
      const rows: Customer[] = [];
      for (let page = 1; page <= 20; page++) {
        const result = await api<CustomerList>(
          `/customers?sort=name&direction=asc&page=${page}${editable ? '&editable=true' : ''}`,
          { workspace, signal: controller.signal },
        );
        rows.push(...result.items);
        if (rows.length >= result.total || !result.items.length) break;
      }
      if (!controller.signal.aborted) setCustomers(rows);
    };
    void load().catch((e) => {
      if (!controller.signal.aborted) setError(errorText(e));
    });
    return () => controller.abort();
  }, [workspace, editable]);
  useEffect(() => {
    const controller = new AbortController();
    setProjects([]);
    setPeople([]);
    if (customerId) {
      const load = async () => {
        const projectRows = await api<Project[]>(`/customers/${customerId}/projects`, {
          workspace,
          signal: controller.signal,
        });
        const rows: Person[] = [];
        for (let page = 1; page <= 20; page++) {
          const result = await api<PeopleList>(`/people?customer_id=${customerId}&page=${page}`, {
            workspace,
            signal: controller.signal,
          });
          rows.push(...result.items);
          if (rows.length >= result.total || !result.items.length) break;
        }
        if (!controller.signal.aborted) {
          setProjects(projectRows.filter((p) => !p.archived_at));
          setPeople(rows.filter((p) => !p.archived_at));
        }
      };
      void load().catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    }
    return () => controller.abort();
  }, [workspace, customerId]);
  return { customers, projects, people, error };
}

const noteCapabilities = new Map<string, { at: number; value: Promise<boolean> }>();
export function useNotesAvailable(workspace: string, actorId = '') {
  const key = `${workspace}:${actorId}`;
  const [state, setState] = useState({ key: '', available: false });
  useEffect(() => {
    let active = true;
    const load = () => {
      const cached = noteCapabilities.get(key);
      const value =
        cached && Date.now() - cached.at < 5000
          ? cached.value
          : api<{ notes?: boolean }>('/agent/capabilities', { workspace })
              .then((result) => result.notes === true)
              .catch(() => false);
      noteCapabilities.set(key, { at: Date.now(), value });
      void value.then((available) => {
        if (active) setState({ key, available });
      });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, [workspace, key]);
  return state.key === key && state.available;
}

export function NotesWorkspace({ workspace, actorId }: { workspace: string; actorId?: string }) {
  const available = useNotesAvailable(workspace, actorId);
  return available ? (
    <NotesList key={workspace} workspace={workspace} />
  ) : (
    <p className="notes-empty">笔记服务尚未加载。</p>
  );
}
export function EntityNotes({
  workspace,
  customer,
  project,
  person,
  canCreate = false,
}: {
  workspace: string;
  customer: Named;
  project?: Named;
  person?: Named;
  canCreate?: boolean;
}) {
  const available = useNotesAvailable(workspace);
  if (!available) return <p className="notes-empty">笔记服务尚未加载。</p>;
  return (
    <NotesList
      key={`${workspace}:${customer.id}:${project?.id || ''}:${person?.id || ''}`}
      workspace={workspace}
      customer={customer}
      project={project}
      person={person}
      canCreate={canCreate}
    />
  );
}
function NotesList({
  workspace,
  customer,
  project,
  person,
  canCreate = true,
}: {
  workspace: string;
  customer?: Named;
  project?: Named;
  person?: Named;
  canCreate?: boolean;
}) {
  const [view, setView] = useState<'all' | 'drafts'>('all');
  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState(customer?.id || '');
  const [projectId, setProjectId] = useState(project?.id || '');
  const [personId, setPersonId] = useState(person?.id || '');
  const [archived, setArchived] = useState(false);
  const [authorId, setAuthorId] = useState('');
  const [updatedFrom, setUpdatedFrom] = useState('');
  const [updatedTo, setUpdatedTo] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<NoteListResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const directory = useDirectory(workspace, customerId);
  useEffect(() => {
    const controller = new AbortController();
    api<Member[]>('/members', { workspace, signal: controller.signal })
      .then(setMembers)
      .catch(() => {});
    return () => controller.abort();
  }, [workspace]);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ workspace: string }>).detail.workspace === workspace) refresh();
    };
    window.addEventListener(changedEvent, onChanged);
    return () => window.removeEventListener(changedEvent, onChanged);
  }, [workspace, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setData(null);
    const q = new URLSearchParams({ view, offset: String(page * 20), limit: '20', search });
    if (customerId) q.set('customer_id', customerId);
    if (projectId) q.set('project_id', projectId);
    if (personId) q.set('person_id', personId);
    if (archived) q.set('archived', 'true');
    if (authorId && view === 'all') q.set('author_id', authorId);
    if (updatedFrom) q.set('updated_from', updatedFrom);
    if (updatedTo) q.set('updated_to', updatedTo);
    const timer = setTimeout(() => {
      void api<NoteListResponse>(`/notes?${q}`, { workspace, signal: controller.signal })
        .then((result) => {
          setData(result);
          setBusy(false);
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(errorText(e));
            setBusy(false);
          }
        });
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    workspace,
    customerId,
    projectId,
    personId,
    view,
    search,
    archived,
    authorId,
    updatedFrom,
    updatedTo,
    page,
    revision,
  ]);
  const select = (fn: () => void) => {
    setPage(0);
    fn();
  };
  const headingDescription = person
    ? `仅展示明确关联${person.name}的笔记`
    : project
      ? `${project.name}的跟进与交接记录`
      : '记录跟进、沟通要点和内部交接，保留每次修改与依据。';
  const createAction = canCreate && (
    <button
      className="primary"
      onClick={() =>
        openNote({
          customerId: customerId || undefined,
          projectId: projectId || undefined,
          personId: personId || undefined,
        })
      }
    >
      <Plus size={15} />
      新建笔记
    </button>
  );
  const viewTabs = (
    <>
      <button
        role="tab"
        aria-selected={view === 'all'}
        className={view === 'all' ? 'active' : ''}
        onClick={() => select(() => setView('all'))}
      >
        全部笔记
      </button>
      <button
        role="tab"
        aria-selected={view === 'drafts'}
        className={view === 'drafts' ? 'active' : ''}
        onClick={() =>
          select(() => {
            setView('drafts');
            setArchived(false);
          })
        }
      >
        我的草稿
      </button>
    </>
  );
  return (
    <section className={`notes-workspace ${customer ? 'notes-entity' : 'workspace-page'}`}>
      {customer ? (
        <div className="notes-heading">
          <div>
            <h1>
              <FileText size={22} />
              笔记
            </h1>
            <p>{headingDescription}</p>
          </div>
          {createAction}
        </div>
      ) : (
        <WorkspacePageHeader title="笔记" description={headingDescription} actions={createAction} />
      )}
      {customer ? (
        <div className="notes-view-tabs" role="tablist" aria-label="笔记范围">
          {viewTabs}
        </div>
      ) : (
        <WorkspacePageTabs label="笔记范围">{viewTabs}</WorkspacePageTabs>
      )}
      <div className="notes-toolbar">
        <label className="notes-search">
          <Search size={15} />
          <input
            aria-label="搜索笔记标题或正文"
            placeholder="搜索标题或正文"
            value={search}
            onChange={(e) => select(() => setSearch(e.target.value))}
          />
        </label>
        {!customer && (
          <select
            aria-label="按公司筛选笔记"
            value={customerId}
            onChange={(e) =>
              select(() => {
                setCustomerId(e.target.value);
                setProjectId('');
                setPersonId('');
              })
            }
          >
            <option value="">全部公司</option>
            {directory.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {customerId && !project && (
          <select
            aria-label="按项目筛选笔记"
            value={projectId}
            onChange={(e) => select(() => setProjectId(e.target.value))}
          >
            <option value="">全部项目</option>
            {directory.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {customerId && !person && (
          <select
            aria-label="按联系人筛选笔记"
            value={personId}
            onChange={(e) => select(() => setPersonId(e.target.value))}
          >
            <option value="">全部联系人</option>
            {directory.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {view === 'all' && (
          <select
            aria-label="笔记归档状态"
            value={String(archived)}
            onChange={(e) => select(() => setArchived(e.target.value === 'true'))}
          >
            <option value="false">未归档</option>
            <option value="true">已归档</option>
          </select>
        )}
        {view === 'all' && (
          <select
            aria-label="按作者筛选笔记"
            value={authorId}
            onChange={(e) => select(() => setAuthorId(e.target.value))}
          >
            <option value="">全部作者</option>
            {members
              .filter((m) => m.active)
              .map((m) => (
                <option key={m.actor_id} value={m.actor_id}>
                  {m.display_name}
                </option>
              ))}
          </select>
        )}
        <label className="notes-date-filter">
          更新自
          <input
            aria-label="笔记更新开始日期"
            type="date"
            value={updatedFrom}
            onChange={(e) => select(() => setUpdatedFrom(e.target.value))}
          />
        </label>
        <label className="notes-date-filter">
          至
          <input
            aria-label="笔记更新结束日期"
            type="date"
            value={updatedTo}
            min={updatedFrom || undefined}
            onChange={(e) => select(() => setUpdatedTo(e.target.value))}
          />
        </label>
        <button className="icon-button" aria-label="刷新笔记" onClick={refresh} disabled={busy}>
          <RefreshCw size={15} />
        </button>
      </div>
      {(error || directory.error) && (
        <p className="notes-error" role="alert">
          {error || directory.error}
        </p>
      )}
      {busy && (
        <div className="notes-empty" role="status">
          正在读取笔记…
        </div>
      )}
      {!busy && !error && !data?.total && (
        <div className="notes-empty">
          <FileText size={30} strokeWidth={1.3} />
          <h3>{view === 'drafts' ? '还没有私人草稿' : '还没有符合条件的笔记'}</h3>
          <p>
            {view === 'drafts'
              ? '编辑中的内容自动保存到这里，正式保存后同事和 Agent 才能使用。'
              : '新建一篇笔记，写下客户跟进或交接事项。'}
          </p>
        </div>
      )}
      <div className="notes-list">
        {data?.notes.map((note) => (
          <button
            className="notes-list-row"
            key={note.id}
            onClick={() => openNote({ noteId: note.id })}
          >
            <span className="notes-row-icon">
              <FileText size={18} />
            </span>
            <span className="notes-row-main">
              <strong>{note.title}</strong>
              <span className="notes-excerpt">{note.excerpt || '查看笔记正文'}</span>
              <span className="notes-row-meta">
                {note.customer_name}
                {note.project_name ? ` · ${note.project_name}` : ''}
                {note.people.length ? ` · ${note.people.map((p) => p.name).join('、')}` : ''}
              </span>
            </span>
            <span className="notes-row-end">
              <span>
                {note.edited_by_name} · {time(note.updated_at)}
              </span>
              <small>
                v{note.revision_version ?? note.version} · {knowledgeLabels[note.knowledge_state]}
              </small>
            </span>
            <ArrowRight size={15} />
          </button>
        ))}
        {data?.drafts.map((draft) => (
          <button
            className="notes-list-row"
            key={draft.id}
            onClick={() => openNote({ draftId: draft.id })}
          >
            <span className="notes-row-icon">
              <FileText size={18} />
            </span>
            <span className="notes-row-main">
              <strong>{draft.title || '未命名草稿'}</strong>
              <span className="notes-excerpt">
                {draft.blocks
                  .map((b) => b.text)
                  .join(' ')
                  .slice(0, 120) || '继续编辑这篇笔记'}
              </span>
              <span className="notes-row-meta">
                仅本人可见{draft.note_id ? ' · 已发布笔记的编辑稿' : ''}
              </span>
            </span>
            <span className="notes-row-end">{time(draft.updated_at)}</span>
            <ArrowRight size={15} />
          </button>
        ))}
      </div>
      {Boolean(data?.total) && (
        <footer className="notes-pagination">
          <span>共 {data?.total} 篇 · 按更新时间倒序</span>
          <div>
            <button
              className="icon-button"
              aria-label="上一页笔记"
              disabled={!page || busy}
              onClick={() => setPage((n) => n - 1)}
            >
              <ArrowLeft size={15} />
            </button>
            <span>{page + 1}</span>
            <button
              className="icon-button"
              aria-label="下一页笔记"
              disabled={!data?.has_more || busy}
              onClick={() => setPage((n) => n + 1)}
            >
              <ArrowRight size={15} />
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

export function NoteEditorHost({ workspace, actorId }: { workspace: string; actorId?: string }) {
  const available = useNotesAvailable(workspace, actorId);
  const [opened, setOpened] = useState<(OpenNoteRequest & { key: string }) | null>(null);
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const pending = useRef<OpenNoteRequest | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<OpenNoteRequest>).detail;
      if (
        !available ||
        !request ||
        typeof request !== 'object' ||
        (request.workspaceId && request.workspaceId !== workspace) ||
        (request.actorId && request.actorId !== actorId)
      )
        return;
      if (openedRef.current) {
        pending.current = request;
        return;
      }
      setOpened({ ...request, key: crypto.randomUUID() });
    };
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        !available ||
        event.key !== 'n' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        openedRef.current ||
        document.querySelector('dialog[open]') ||
        target?.closest('input,textarea,select,[contenteditable="true"]')
      )
        return;
      event.preventDefault();
      setOpened({ key: crypto.randomUUID() });
    };
    window.addEventListener(openEvent, open);
    document.addEventListener('keydown', shortcut);
    return () => {
      window.removeEventListener(openEvent, open);
      document.removeEventListener('keydown', shortcut);
      pending.current = null;
    };
  }, [workspace, actorId, available]);
  return (
    available &&
    opened && (
      <NoteEditor
        key={opened.key}
        workspace={workspace}
        request={opened}
        onClose={() => {
          const next = pending.current;
          pending.current = null;
          setOpened(next ? { ...next, key: crypto.randomUUID() } : null);
        }}
      />
    )
  );
}

function NoteEditor({
  workspace,
  request,
  onClose,
}: {
  workspace: string;
  request: OpenNoteRequest;
  onClose: () => void;
}) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [content, setContent] = useState<NoteContent>({
    title: '',
    customer_id: request.customerId || null,
    project_id: request.projectId || null,
    person_ids: request.personId ? [request.personId] : [],
    blocks: [blankBlock()],
  });
  const current = useRef(content);
  current.current = content;
  const [editing, setEditing] = useState(!request.noteId);
  const [loading, setLoading] = useState(Boolean(request.noteId || request.draftId));
  const [error, setError] = useState('');
  const [status, setStatus] = useState('草稿仅自己可见');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [autosaving, setAutosaving] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const [draftId, setDraftId] = useState(request.draftId || crypto.randomUUID());
  const [baseRevision, setBaseRevision] = useState(0);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourceError, setSourceError] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [permissionLost, setPermissionLost] = useState(false);
  const [conflictNote, setConflictNote] = useState<NoteDetail | null>(null);
  const [history, setHistory] = useState<
    | {
        revision_id: string;
        version: number;
        content_hash: string;
        edited_by: string;
        created_at: string;
        current: boolean;
      }[]
    | null
  >(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const archiveRequest = useRef<{ key: string; request_id: string } | null>(null);
  const organizeRequest = useRef<{ key: string; request_id: string } | null>(null);
  const targetNote = useRef(request.noteId || null);
  const sourceRead = useRef(0);
  const baseRef = useRef(baseRevision);
  baseRef.current = baseRevision;
  const alive = useRef(true);
  const writer = useRef<NoteDraftWriter | null>(null);
  const publishRequest = useRef<{
    request_id: string;
    draft_id: string;
    draft_version: number;
    base_revision: number;
  } | null>(null);
  const directory = useDirectory(workspace, content.customer_id, true);
  const installWriter = useCallback(
    (id: string, value: NoteContent, version: number, target: string | null, base: number) => {
      writer.current?.dispose();
      writer.current = new NoteDraftWriter(id, target, base, version, value, (draft, body) =>
        api<NoteDraft>(`/note-drafts/${draft}`, { workspace, method: 'PUT', body }),
      );
    },
    [workspace],
  );
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const options = { workspace, signal: controller.signal };
    const load = async () => {
      if (request.draftId) {
        const draft = await api<NoteDraft>(`/note-drafts/${request.draftId}`, options);
        if (controller.signal.aborted) return;
        setContent(noteContentOf(draft));
        setDraftVersion(draft.version);
        setBaseRevision(draft.base_revision);
        targetNote.current = draft.note_id;
        installWriter(draft.id, draft, draft.version, draft.note_id, draft.base_revision);
        if (draft.note_id) {
          const published = await api<NoteDetail>(`/notes/${draft.note_id}`, options);
          if (!controller.signal.aborted) setNote(published);
        }
        setStatus('草稿已保存 · 仅自己可见');
      } else if (request.noteId) {
        const published = await api<NoteDetail>(`/notes/${request.noteId}`, options);
        if (controller.signal.aborted) return;
        setNote(published);
        setContent({
          ...noteContentOf(published),
          blocks: published.blocks.length ? published.blocks : [blankBlock()],
        });
        setBaseRevision(published.version);
      } else installWriter(draftId, current.current, 0, null, 0);
      if (!controller.signal.aborted) setLoading(false);
    };
    void load().catch((e) => {
      if (!controller.signal.aborted) {
        setLoading(false);
        setError(errorText(e));
        if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
          setPermissionLost(true);
          setContent({
            title: '',
            customer_id: null,
            project_id: null,
            person_ids: [],
            blocks: [],
          });
        }
      }
    });
    return () => {
      alive.current = false;
      controller.abort();
      writer.current?.dispose();
    };
    // Only an explicit editor identity initializes content; background refreshes do not.
  }, [workspace, request.noteId, request.draftId, installWriter]);
  useEffect(() => {
    const controller = new AbortController();
    api<{ templates: NoteTemplate[] }>('/note-templates', { workspace, signal: controller.signal })
      .then((result) => setTemplates(result.templates))
      .catch(() => {});
    return () => controller.abort();
  }, [workspace]);
  const associationKey = `${content.customer_id}:${content.project_id}:${[...content.person_ids].sort().join(',')}`;
  useEffect(() => {
    sourceRead.current++;
    setSources([]);
    setSelectedSources([]);
    setSourceOpen(false);
    setSourceLoading(false);
  }, [associationKey]);
  const handleError = useCallback(
    (e: unknown) => {
      if (!alive.current) return;
      setError(errorText(e));
      setStatus('尚未保存，请重试');
      if (e instanceof HttpError && e.status === 409 && targetNote.current) {
        void api<NoteDetail>(`/notes/${targetNote.current}`, { workspace })
          .then((latest) => {
            if (alive.current && latest.version !== baseRef.current) setConflictNote(latest);
          })
          .catch(() => {});
      }
      if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
        writer.current?.dispose();
        setPermissionLost(true);
        setContent({ title: '', customer_id: null, project_id: null, person_ids: [], blocks: [] });
        setSources([]);
        setSelectedSources([]);
      }
    },
    [workspace],
  );
  const saveDraft = useCallback(
    async (force = false) => {
      const queue = writer.current;
      if (!queue || permissionLost) throw new Error('笔记当前不可编辑，请重新打开');
      queue.update(current.current);
      setAutosaving(true);
      setStatus('正在保存私人草稿…');
      try {
        const result = await queue.flush(force);
        if (alive.current) {
          setDraftVersion(queue.version);
          setStatus('草稿已保存 · 仅自己可见');
          setError('');
        }
        return result;
      } finally {
        if (alive.current) setAutosaving(false);
      }
    },
    [permissionLost],
  );
  useEffect(() => {
    if (!editing || loading || permissionLost || busy) return;
    writer.current?.update(content);
    if (!writer.current?.dirty) return;
    setStatus('有修改待保存 · 仅自己可见');
    const timer = setTimeout(() => {
      void saveDraft().catch(handleError);
    }, 650);
    return () => clearTimeout(timer);
  }, [content, editing, loading, permissionLost, busy, saveDraft, handleError]);
  useEffect(() => {
    if (!editing) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      writer.current?.update(current.current);
      if (writer.current?.dirty || busyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editing]);
  useEffect(() => {
    if (loading || permissionLost) return;
    let active = true;
    const verify = async () => {
      if (busyRef.current) return;
      const customerId = current.current.customer_id;
      if (!customerId) return;
      try {
        const company = await api<Customer>(`/customers/${customerId}`, { workspace });
        if (!active) return;
        if (company.archived_at || (editing && !company.can_edit))
          throw new HttpError('当前客户已归档或编辑权限已变化', 403);
        if (targetNote.current) {
          const latest = await api<NoteDetail>(`/notes/${targetNote.current}`, { workspace });
          if (!active) return;
          if (editing && latest.archived_at) throw new HttpError('笔记已归档，当前编辑已停止', 403);
          if (!editing && note && latest.version === note.version)
            setNote((previous) =>
              previous
                ? {
                    ...previous,
                    knowledge_state: latest.knowledge_state,
                    archived_at: latest.archived_at,
                  }
                : previous,
            );
        }
      } catch (e) {
        if (active && e instanceof HttpError && [401, 403, 404].includes(e.status)) handleError(e);
      }
    };
    const timer = setInterval(() => {
      void verify();
    }, 15000);
    const focus = () => {
      void verify();
    };
    window.addEventListener('focus', focus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [workspace, loading, permissionLost, editing, note?.id, note?.version, handleError]);
  const update = (patch: Partial<NoteContent>) => {
    publishRequest.current = null;
    organizeRequest.current = null;
    setContent((value) => ({ ...value, ...patch }));
  };
  const close = async () => {
    if (busyRef.current) return;
    if (!editing || permissionLost || loading) {
      onClose();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      writer.current?.update(current.current);
      if (writer.current?.dirty || autosaving) await saveDraft();
      onClose();
    } catch (e) {
      handleError(e);
    } finally {
      if (alive.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const publish = async () => {
    if (busyRef.current || !noteCanPublish(current.current)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await saveDraft(true);
      const version = writer.current!.version;
      if (!publishRequest.current || publishRequest.current.draft_version !== version)
        publishRequest.current = {
          request_id: crypto.randomUUID(),
          draft_id: draftId,
          draft_version: version,
          base_revision: baseRevision,
        };
      const saved = await api<NoteDetail>('/notes/publish', {
        workspace,
        method: 'POST',
        body: publishRequest.current,
      });
      if (!alive.current) return;
      writer.current?.dispose();
      writer.current = null;
      setNote(saved);
      targetNote.current = saved.id;
      setConflictNote(null);
      setContent(noteContentOf(saved));
      setBaseRevision(saved.version);
      setEditing(false);
      setStatus('笔记已保存');
      setError('');
      notesChanged(workspace);
    } catch (e) {
      handleError(e);
    } finally {
      if (alive.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const beginEdit = () => {
    if (!note?.can_edit || note.archived_at) return;
    const id = crypto.randomUUID();
    const value = noteContentOf(note);
    setContent(value);
    setDraftId(id);
    setDraftVersion(0);
    setBaseRevision(note.version);
    installWriter(id, value, 0, note.id, note.version);
    setEditing(true);
    setStatus('编辑稿仅自己可见 · 同事仍读取已保存版本');
    setError('');
  };
  const discard = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (autosaving) await saveDraft();
      const version = writer.current?.version || draftVersion;
      if (version)
        await api(`/note-drafts/${draftId}`, { workspace, method: 'DELETE', body: { version } });
      writer.current?.dispose();
      writer.current = null;
      setConfirmDiscard(false);
      notesChanged(workspace);
      if (note) {
        setContent(noteContentOf(note));
        setEditing(false);
        setError('');
      } else onClose();
    } catch (e) {
      handleError(e);
      setConfirmDiscard(false);
    } finally {
      if (alive.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const archive = async () => {
    if (!note || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const action = note.archived_at ? 'restore' : 'archive';
      const key = `${note.id}:${note.version}:${action}`;
      if (archiveRequest.current?.key !== key)
        archiveRequest.current = { key, request_id: crypto.randomUUID() };
      const changed = await api<NoteDetail>(
        `/notes/${note.id}/${note.archived_at ? 'restore' : 'archive'}`,
        {
          workspace,
          method: 'POST',
          body: { version: note.version, request_id: archiveRequest.current.request_id },
        },
      );
      if (!alive.current) return;
      setNote(changed);
      archiveRequest.current = null;
      notesChanged(workspace);
      setError('');
    } catch (e) {
      handleError(e);
    } finally {
      if (alive.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const loadSources = async () => {
    if (!content.customer_id) return;
    setSourceOpen((value) => !value);
    if (sourceOpen) return;
    const readId = ++sourceRead.current;
    const sourceScope = `${content.customer_id}:${content.project_id || ''}:${[...content.person_ids].sort().join(',')}`;
    setSourceLoading(true);
    setSourceError('');
    const q = new URLSearchParams({ customer_id: content.customer_id });
    if (content.project_id) q.set('project_id', content.project_id);
    if (content.person_ids.length === 1) q.set('person_id', content.person_ids[0]);
    try {
      const result = await api<{ sources: SourceOption[] }>(`/notes/sources?${q}`, { workspace });
      if (
        alive.current &&
        readId === sourceRead.current &&
        sourceScope ===
          `${current.current.customer_id}:${current.current.project_id || ''}:${[...current.current.person_ids].sort().join(',')}`
      )
        setSources(
          result.sources.filter(
            (source) =>
              content.person_ids.every((id) => source.person_ids?.includes(id)) &&
              (!content.person_ids.length || source.person_scope_complete !== false),
          ),
        );
    } catch (e) {
      if (alive.current && readId === sourceRead.current) setSourceError(errorText(e));
    } finally {
      if (alive.current && readId === sourceRead.current) setSourceLoading(false);
    }
  };
  const insertQuotes = () => {
    const selected = sources.filter((s) => selectedSources.includes(s.source_id || s.record_id));
    update({
      blocks: [
        ...content.blocks.filter((b) => b.text.trim()),
        ...selected.map((s): NoteBlock => ({
          id: crypto.randomUUID(),
          type: 'quote',
          text: s.quote,
          origin: 'quote',
          sources: [{ ...s }],
        })),
      ],
    });
    setSourceOpen(false);
    setSelectedSources([]);
  };
  const organize = async () => {
    if (!content.customer_id || busyRef.current) return;
    const selected = sources.filter((s) => selectedSources.includes(s.source_id || s.record_id));
    if (!selected.length) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await saveDraft(true);
      const requestKey = JSON.stringify([
        draftId,
        writer.current!.version,
        content,
        selected.map((source) => source.record_id),
      ]);
      if (organizeRequest.current?.key !== requestKey)
        organizeRequest.current = { key: requestKey, request_id: crypto.randomUUID() };
      const result = await api<{ draft: NoteDraft }>('/notes/agent-draft', {
        workspace,
        method: 'POST',
        body: {
          request_id: organizeRequest.current.request_id,
          draft_id: draftId,
          draft_version: writer.current!.version,
          customer_id: content.customer_id,
          project_id: content.project_id,
          person_ids: content.person_ids,
          source_record_ids: [...new Set(selected.map((s) => s.record_id))],
          title: content.title || undefined,
        },
      });
      if (!alive.current) return;
      const draft = result.draft;
      organizeRequest.current = null;
      setContent(noteContentOf(draft));
      setDraftVersion(draft.version);
      installWriter(draft.id, draft, draft.version, draft.note_id, draft.base_revision);
      setSourceOpen(false);
      setSelectedSources([]);
      setStatus('AI整理已保存为私人草稿，请核对后保存笔记');
      notesChanged(workspace);
    } catch (e) {
      handleError(e);
    } finally {
      if (alive.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const uniqueSources = content.blocks
    .flatMap((b) => b.sources)
    .filter(
      (s, i, all) =>
        all.findIndex((v) => v.record_id === s.record_id && v.source_hash === s.source_hash) === i,
    );
  const selectedCustomer = directory.customers.find((c) => c.id === content.customer_id);
  const dirty = Boolean(writer.current?.dirty);
  return (
    <>
      <Dialog
        title={editing ? (note ? '编辑笔记' : '新建笔记') : '笔记'}
        className="note-editor-dialog"
        onClose={() => {
          void close();
        }}
      >
        {loading ? (
          <p className="notes-empty" role="status">
            正在读取笔记…
          </p>
        ) : permissionLost ? (
          <div className="notes-empty">
            <h3>这篇资料当前不可用</h3>
            <p role="alert">{error || '权限或来源已变化，请回到笔记列表重新查看。'}</p>
            <button onClick={onClose}>关闭</button>
          </div>
        ) : (
          <>
            {error && (
              <p className="notes-error" role="alert">
                {error}
                <button
                  className="text-button"
                  disabled={busy || autosaving}
                  onClick={() => {
                    void saveDraft().catch(handleError);
                  }}
                >
                  重试保存草稿
                </button>
              </p>
            )}
            {note?.source_warning && <p className="notes-warning">{note.source_warning}</p>}
            <div className="note-editor-scroll">
              <div className="note-editor-meta">
                <span className="note-privacy-label">
                  {editing ? '私人草稿' : `已保存 · v${note?.revision_version ?? note?.version}`}
                </span>
                {!editing && note && (
                  <span className={`note-knowledge-state state-${note.knowledge_state}`}>
                    {note.archived_at ? '已归档' : knowledgeLabels[note.knowledge_state]}
                  </span>
                )}
                {note && (
                  <span>
                    {note.edited_by_name} · {time(note.updated_at)}
                  </span>
                )}
              </div>
              {conflictNote && (
                <section className="note-conflict">
                  <strong>
                    笔记已被更新到 v{conflictNote.revision_version ?? conflictNote.version}
                  </strong>
                  <p>本次输入已保留。请比较最新内容，再决定如何继续。</p>
                  <details>
                    <summary>查看最新正式版本 · {conflictNote.edited_by_name}</summary>
                    <h3>{conflictNote.title}</h3>
                    {conflictNote.blocks.map((block) => (
                      <ReadBlock key={block.id} block={block} />
                    ))}
                  </details>
                  <button
                    disabled={busy || autosaving}
                    onClick={() => {
                      const preserved = noteContentOf(current.current);
                      const id = crypto.randomUUID();
                      setNote(conflictNote);
                      targetNote.current = conflictNote.id;
                      setBaseRevision(conflictNote.version);
                      setDraftId(id);
                      setDraftVersion(0);
                      installWriter(
                        id,
                        noteContentOf(conflictNote),
                        0,
                        conflictNote.id,
                        conflictNote.version,
                      );
                      writer.current?.update(preserved);
                      setConflictNote(null);
                      setError('');
                      void saveDraft(true).catch(handleError);
                    }}
                  >
                    保留本次内容，基于最新版本继续
                  </button>
                </section>
              )}
              {editing ? (
                <div className="note-scope-fields">
                  <label>
                    所属公司
                    <select
                      aria-label="笔记所属公司"
                      value={content.customer_id || ''}
                      disabled={
                        busy ||
                        Boolean(note) ||
                        Boolean(request.customerId) ||
                        Boolean(content.customer_id)
                      }
                      onChange={(e) => {
                        update({
                          customer_id: e.target.value || null,
                          project_id: null,
                          person_ids: [],
                        });
                        setSources([]);
                        setSelectedSources([]);
                      }}
                    >
                      <option value="">选择公司后可正式保存</option>
                      {content.customer_id && !selectedCustomer && (
                        <option value={content.customer_id}>
                          {note?.customer_name || '当前公司'}
                        </option>
                      )}
                      {directory.customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {content.customer_id && (
                    <label>
                      关联项目
                      <select
                        aria-label="笔记关联项目"
                        value={content.project_id || ''}
                        disabled={busy || Boolean(request.projectId)}
                        onChange={(e) => {
                          update({ project_id: e.target.value || null });
                          setSources([]);
                          setSelectedSources([]);
                          setSourceOpen(false);
                        }}
                      >
                        <option value="">不指定项目</option>
                        {content.project_id &&
                          !directory.projects.some((p) => p.id === content.project_id) && (
                            <option value={content.project_id}>
                              {note?.project_name || '当前项目'}
                            </option>
                          )}
                        {directory.projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {content.customer_id && (
                    <fieldset className="note-people-select" disabled={busy}>
                      <legend>关联联系人 · 可多选</legend>
                      {directory.people.length ? (
                        directory.people.map((p) => (
                          <label key={p.id}>
                            <input
                              type="checkbox"
                              checked={content.person_ids.includes(p.id)}
                              disabled={Boolean(request.personId && p.id === request.personId)}
                              onChange={(e) =>
                                update({
                                  person_ids: e.target.checked
                                    ? [...content.person_ids, p.id]
                                    : content.person_ids.filter((id) => id !== p.id),
                                })
                              }
                            />
                            {p.name}
                          </label>
                        ))
                      ) : (
                        <small>
                          {content.person_ids.length ? '已关联当前联系人' : '未指定联系人'}
                        </small>
                      )}
                    </fieldset>
                  )}
                </div>
              ) : (
                note && (
                  <div className="note-read-scope">
                    <span>{note.customer_name}</span>
                    {note.project_name && <span>{note.project_name}</span>}
                    {note.people.map((p) => (
                      <span key={p.id}>{p.name}</span>
                    ))}
                  </div>
                )
              )}
              {directory.error && editing && (
                <p className="notes-error" role="alert">
                  {directory.error}
                </p>
              )}
              {editing ? (
                <input
                  className="note-title-input"
                  aria-label="笔记标题"
                  placeholder="给这篇笔记起个标题"
                  value={content.title}
                  maxLength={noteLimits.title}
                  disabled={busy}
                  onChange={(e) => update({ title: e.target.value })}
                />
              ) : (
                <h1 className="note-read-title">{content.title}</h1>
              )}
              {editing && (
                <div className="note-editor-toolbar">
                  <select
                    aria-label="选择笔记模板"
                    value={templateId}
                    disabled={busy}
                    onChange={(e) => setTemplateId(e.target.value)}
                  >
                    <option value="">选择本人模板</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={!templateId || busy}
                    onClick={() => {
                      const template = templates.find((t) => t.id === templateId);
                      if (template)
                        update({
                          blocks: [
                            ...content.blocks.filter((b) => b.text.trim()),
                            ...template.blocks.map((b): NoteBlock => ({
                              ...b,
                              id: crypto.randomUUID(),
                              origin: 'original',
                              sources: [],
                            })),
                          ],
                        });
                      setTemplateId('');
                    }}
                  >
                    插入模板
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setTemplateOpen(true)}
                  >
                    新建模板
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || !content.customer_id}
                    onClick={() => {
                      void loadSources();
                    }}
                  >
                    <Link2 size={14} />
                    选择原文来源
                  </button>
                </div>
              )}
              {sourceOpen && (
                <section className="note-source-picker">
                  <div className="notes-inline-heading">
                    <strong>选择当前范围内的真实来源</strong>
                    <button
                      className="icon-button"
                      aria-label="关闭来源选择"
                      onClick={() => setSourceOpen(false)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {sourceLoading && <p role="status">正在读取来源…</p>}
                  {sourceError && (
                    <p className="notes-error" role="alert">
                      {sourceError}
                    </p>
                  )}
                  {!sourceLoading && !sourceError && !sources.length && (
                    <p className="notes-muted">当前范围没有可用来源。</p>
                  )}
                  <div className="note-source-options">
                    {sources.map((source) => {
                      const key = source.source_id || source.record_id;
                      return (
                        <label key={key}>
                          <input
                            type="checkbox"
                            checked={selectedSources.includes(key)}
                            disabled={busy}
                            onChange={(e) =>
                              setSelectedSources((ids) =>
                                e.target.checked ? [...ids, key] : ids.filter((id) => id !== key),
                              )
                            }
                          />
                          <span>
                            <strong>{source.title || '原始记录'}</strong>
                            <small>{source.quote.slice(0, 160)}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="note-source-actions">
                    <button disabled={!selectedSources.length || busy} onClick={insertQuotes}>
                      插入原文引述
                    </button>
                    <button
                      className="primary"
                      disabled={!selectedSources.length || busy}
                      onClick={() => {
                        void organize();
                      }}
                    >
                      <Sparkles size={14} />
                      {busy ? '正在整理…' : 'AI整理为草稿'}
                    </button>
                  </div>
                  <small>AI整理会更新当前私人草稿；请先核对已选来源。</small>
                </section>
              )}
              <div className={`note-document ${editing ? 'is-editing' : ''}`}>
                {content.blocks.map((block, index) =>
                  editing ? (
                    <div className="note-edit-block" key={block.id}>
                      <div className="note-block-controls">
                        <select
                          aria-label={`第${index + 1}段格式`}
                          value={block.type}
                          disabled={busy}
                          onChange={(e) =>
                            update({
                              blocks: content.blocks.map((b) =>
                                b.id === block.id
                                  ? { ...b, type: e.target.value as NoteBlockKind }
                                  : b,
                              ),
                            })
                          }
                        >
                          {Object.entries(blockLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <span>
                          {block.origin === 'original'
                            ? '内部记录'
                            : block.origin === 'quote'
                              ? '原文引述'
                              : '来源整理'}
                        </span>
                        <button
                          className="icon-button"
                          aria-label={`删除第${index + 1}段`}
                          disabled={busy || content.blocks.length <= 1}
                          onClick={() =>
                            update({ blocks: content.blocks.filter((b) => b.id !== block.id) })
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <textarea
                        aria-label={`第${index + 1}段内容`}
                        className={`note-block-text block-${block.type}`}
                        placeholder={
                          block.type === 'heading' ? '小标题' : '写下跟进内容、核实结果或交接事项…'
                        }
                        rows={Math.max(
                          2,
                          Math.min(
                            12,
                            block.text.split('\n').length + Math.ceil(block.text.length / 55),
                          ),
                        )}
                        value={block.text}
                        disabled={busy}
                        onChange={(e) =>
                          update({
                            blocks: content.blocks.map((b) =>
                              b.id === block.id ? editNoteBlock(b, e.target.value) : b,
                            ),
                          })
                        }
                      />
                      {block.sources.length > 0 && (
                        <small className="note-block-origin">
                          {block.sources.length} 个原始来源 · 编辑后仍保留来源
                        </small>
                      )}
                    </div>
                  ) : (
                    <div key={block.id} className="note-read-block">
                      <ReadBlock block={block} />
                      {block.origin !== 'original' && (
                        <small className="note-block-origin">
                          {block.origin === 'quote' ? '原文引述' : '依据原文整理'} ·{' '}
                          {block.sources.length} 个来源
                        </small>
                      )}
                    </div>
                  ),
                )}
                {editing && (
                  <button
                    className="note-add-block"
                    disabled={busy || content.blocks.length >= noteLimits.blocks}
                    onClick={() => update({ blocks: [...content.blocks, blankBlock()] })}
                  >
                    <Plus size={14} />
                    添加段落
                  </button>
                )}
              </div>
              {uniqueSources.length > 0 && (
                <section className="note-sources">
                  <h3>
                    <Link2 size={14} />
                    原始来源 <span>{uniqueSources.length}</span>
                  </h3>
                  {uniqueSources.map((source) => (
                    <button
                      key={`${source.record_id}:${source.source_hash}`}
                      onClick={() => setSelectedRecord(source.record_id)}
                    >
                      <FileText size={14} />
                      <span>
                        <strong>{source.title || '原始业务记录'}</strong>
                        <small>来源版本 {source.source_hash.slice(0, 10)}</small>
                      </span>
                      <ArrowRight size={14} />
                    </button>
                  ))}
                </section>
              )}
              {!editing && note && (
                <div className="note-version-detail">
                  笔记 v{note.revision_version ?? note.version} · {note.edited_by_name} 最后编辑
                  <span title={note.content_hash}>内容版本 {note.content_hash.slice(0, 10)}</span>
                  <button
                    className="text-button"
                    disabled={historyLoading}
                    onClick={() => {
                      setHistoryOpen((value) => !value);
                      if (historyOpen) return;
                      setHistoryLoading(true);
                      void api<{ revisions: NonNullable<typeof history> }>(
                        `/notes/${note.id}/versions`,
                        { workspace },
                      )
                        .then((result) => {
                          if (alive.current) setHistory(result.revisions);
                        })
                        .catch(handleError)
                        .finally(() => {
                          if (alive.current) setHistoryLoading(false);
                        });
                    }}
                  >
                    版本记录
                  </button>
                </div>
              )}
              {!editing && historyOpen && (
                <section className="note-history">
                  <p>这里只展示版本时间与标记，旧版本正文不在此释放。</p>
                  {historyLoading ? (
                    <p role="status">正在读取版本记录…</p>
                  ) : (
                    history?.map((revision) => (
                      <div key={revision.revision_id}>
                        <strong>
                          v{revision.version}
                          {revision.current ? ' · 当前正文' : ''}
                        </strong>
                        <span>{time(revision.created_at)}</span>
                        <small title={revision.content_hash}>
                          {revision.content_hash.slice(0, 10)}
                        </small>
                      </div>
                    ))
                  )}
                </section>
              )}
              {!editing && note?.knowledge_versions && (
                <details className="note-knowledge-detail">
                  <summary>知识版本与整理状态</summary>
                  <p>本次笔记正文：v{note.revision_version ?? note.version}</p>
                  {(['vector', 'graph'] as const).map((kind) => {
                    const version = note.knowledge_versions?.[kind];
                    return (
                      <p key={kind}>
                        {kind === 'vector' ? '原文检索' : '关系知识'}：
                        {version
                          ? `版本 ${version.applied_version} / ${version.requested_version} · ${version.state === 'ready' ? '已整理' : version.state === 'failed' ? '整理失败' : '整理中'}`
                          : '尚无整理版本'}
                        {version?.digest && (
                          <small title={version.digest}> · {version.digest.slice(0, 10)}</small>
                        )}
                      </p>
                    );
                  })}
                </details>
              )}
            </div>
            <footer className="note-editor-footer">
              <div className="note-save-status" role="status">
                {editing
                  ? status
                  : note?.archived_at
                    ? '已归档，当前业务检索不再使用'
                    : '有权限的同事和 Agent 可使用'}
                {editing && <small>正式保存后供有权限的同事和 Agent 使用</small>}
              </div>
              <div className="note-footer-buttons">
                {!editing && note && !note.archived_at && note.record_id && (
                  <ProspectSourceButton
                    workspace={workspace}
                    customerId={note.customer_id}
                    sourceRecordIds={[note.record_id]}
                    sourceKind="note"
                    sourceId={note.id}
                    disabled={busy}
                  />
                )}
                {editing ? (
                  <>
                    <button disabled={busy || autosaving} onClick={() => setConfirmDiscard(true)}>
                      {note ? '放弃本次编辑' : '删除草稿'}
                    </button>
                    <button
                      disabled={busy || autosaving}
                      onClick={() => {
                        void close();
                      }}
                    >
                      关闭并保留草稿
                    </button>
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        autosaving ||
                        !noteCanPublish(content) ||
                        (Boolean(note) && !draftVersion && !dirty)
                      }
                      onClick={() => {
                        void publish();
                      }}
                    >
                      <Save size={14} />
                      {busy ? '保存中…' : '保存笔记'}
                    </button>
                  </>
                ) : (
                  <>
                    {note?.can_edit && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          void archive();
                        }}
                      >
                        <Archive size={14} />
                        {note.archived_at ? '恢复笔记' : '归档'}
                      </button>
                    )}
                    <button onClick={onClose} disabled={busy}>
                      关闭
                    </button>
                    {note?.can_edit && !note.archived_at && (
                      <button className="primary" onClick={beginEdit}>
                        编辑笔记
                      </button>
                    )}
                  </>
                )}
              </div>
            </footer>
          </>
        )}
      </Dialog>
      {confirmDiscard && (
        <Dialog
          title={note ? '放弃本次编辑' : '删除私人草稿'}
          onClose={() => {
            if (!busy) setConfirmDiscard(false);
          }}
        >
          <p className="dialog-copy">
            {note
              ? '仅删除你本次的编辑稿，已正式保存的笔记继续保留。'
              : '这篇草稿尚未正式保存，删除后不会进入客户资料。'}
          </p>
          <footer className="form-footer">
            <button disabled={busy} onClick={() => setConfirmDiscard(false)}>
              继续编辑
            </button>
            <button
              disabled={busy}
              onClick={() => {
                void discard();
              }}
            >
              {busy ? '处理中…' : note ? '放弃本次编辑' : '删除草稿'}
            </button>
          </footer>
        </Dialog>
      )}
      {templateOpen && (
        <NoteTemplateDialog
          workspace={workspace}
          onClose={() => setTemplateOpen(false)}
          onSaved={(template) => {
            setTemplates((items) => [...items, template]);
            setTemplateId(template.id);
            setTemplateOpen(false);
          }}
        />
      )}
      {selectedRecord && content.customer_id && (
        <RecordEvidence
          workspace={workspace}
          customerId={content.customer_id}
          recordId={selectedRecord}
          onClose={() => setSelectedRecord(null)}
        />
      )}
    </>
  );
}
function NoteTemplateDialog({
  workspace,
  onClose,
  onSaved,
}: {
  workspace: string;
  onClose: () => void;
  onSaved: (value: NoteTemplate) => void;
}) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title="新建本人笔记模板"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          void api<NoteTemplate>('/note-templates', {
            workspace,
            method: 'POST',
            body: {
              name,
              blocks: body
                .split('\n')
                .filter((text) => text.trim())
                .map((text) => ({
                  id: crypto.randomUUID(),
                  type: text.startsWith('# ') ? 'heading' : 'paragraph',
                  text: text.replace(/^# /, ''),
                })),
            },
          })
            .then(onSaved)
            .catch((e) => {
              setError(errorText(e));
              setBusy(false);
            });
        }}
      >
        <div className="note-template-fields">
          <p>保存常用写作结构，供本人重复使用。请填写结构提示，不填写客户事实或复制客户原文。</p>
          <label>
            模板名称
            <input
              aria-label="笔记模板名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
              disabled={busy}
            />
          </label>
          <label>
            正文结构
            <textarea
              aria-label="笔记模板正文结构"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={'# 沟通要点\n# 待确认问题\n# 下一步'}
              rows={7}
              required
              disabled={busy}
            />
          </label>
          {error && (
            <p className="notes-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="form-footer">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !name.trim() || !body.trim()}>
            {busy ? '保存中…' : '保存模板'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
