import {
  CreateObjectDialog,
  CustomObjectRecords,
  CustomObjectIcon,
  type CustomRecordSummary,
} from './CustomObjects';
import type { CustomObject } from '../shared/custom-objects';
import { ResizableTable, ColumnResizeHandle, ExpandableCell } from './ResizableTable';
import { MailCenter } from './Mail';
import { DocumentsWorkspace } from './Documents';
import { NotesWorkspace, NoteEditorHost, useNotesAvailable } from './Notes';
import { useMailTrackingSummary } from './mail-events';
import { WeChatWorkspace } from './WeChat';
import { EmailStrength, EmailTime } from './CommunicationMetrics';
import { RelationSettings } from './EntitySettings';
import { Dialog, Popover, ViewSaveMenu, closeMenus } from './WorkspaceUI';
import { ListWorkspace } from './ListWorkspace';
import { PersonForm } from './People';
import { HomeAgent, type WeChatFollowup } from './HomeAgent';
import { AskTyphaButton, AskTyphaPanel } from './AskTypha';
import { agentRunOwner, onAgentActivity } from './agent-runs-client';
import { activeAgentRun } from '../shared/agent-runs';
import { UserPreferences } from './UserPreferences';
import { TeamTasks } from './TeamTasks';
import { ReportsWorkspace } from './Reports';
import { RecordDrawer } from './RecordDrawer';
import {
  ProspectsWorkspace,
  type ProspectIntakeRequest,
  type ProspectWorkspaceSummary,
} from './Prospects';
import { useProspectsAvailable } from './ProspectSourceButton';
import { ResizableSidebar } from './ResizableSidebar';
import { SidebarGroup } from './SidebarGroup';
import { KanbanBoard, KanbanCard } from './KanbanBoard';
import { RecordCardField } from './RecordCardField';
import { useKanbanDisplay } from './useKanbanDisplay';
import type { AskScope } from '../shared/ask';
import type { Chat, ChatDetail, ChatPage } from '../shared/chat';
import {
  personColumns,
  personSorts,
  objectLabels,
  objectNames,
  allViewNames,
  isProject,
  isPerson,
  listEntry,
  type PeopleList,
  type RecordRow,
} from '../shared/views';
import { FilterBuilder } from './FilterBuilder';
import { filterFields, operatorLabels } from '../shared/filters';
import { ListRecordPicker } from './ListRecordPicker';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ClipboardCheck,
  FileText,
  Files,
  Mail,
  BarChart3,
  Building2,
  Home,
  MessageSquare,
  UserRound,
  Table2,
  Archive,
  ArrowDown,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns3,
  Expand,
  Folder,
  LayoutList,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelRight,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { api, HttpError } from './api';
import { useAttributeGeneration, attributeJobKey } from './AttributeGenerate';
import { AttributeTableCell } from './AttributeTableCell';
import {
  AttributeFieldDialog,
  useCompanyAttributes,
  useCompanyAttributeValues,
} from './CompanyAttributes';
import { attributeColumn, type CompanyAttribute } from '../shared/attributes';
import {
  customerStatuses,
  customerTypes,
  projectStages,
  projectTypes,
  sources,
  type Person,
  type Customer,
  type Member,
  type SessionInfo,
} from '../shared/domain';
import {
  customerColumns,
  projectColumns,
  customerSorts,
  projectSorts,
  defaultView,
  equalViewConfig,
  type RecordList,
  type RecordObject,
  type ViewConfig,
  type SavedView,
  type CustomerList,
  type ProjectList,
  type ProjectRow,
} from '../shared/views';
export type { CustomerList } from '../shared/views';
export type Selection = {
  customerId: string;
  projectId?: string;
  personId?: string;
  full?: boolean;
  customerTab?: 'overview' | 'projects' | 'records' | 'people' | 'files' | 'notes';
};
type Props = {
  session: SessionInfo;
  workspace: SessionInfo['workspaces'][number];
  members: Member[];
  onWorkspace: (id: string) => void;
  onLogout: () => void;
  onUnauthorized: () => void;
  refresh: number;
  reload: () => void;
  notify: (message: string) => void;
  selected: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onCreateCustomer: (type?: Customer['type']) => void;
  onCreateProject: (type?: ProjectRow['type']) => void;
  renderDetail: (selection: Selection) => ReactNode;
};
const message = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
function mergeChats(current: Chat[], incoming: Chat[]) {
  return Array.from(
    new Map([...current, ...incoming].map((chat) => [chat.id, chat])).values(),
  ).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id.localeCompare(a.id));
}
const shortDate = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(value));

function CustomerDrawer({
  selection,
  children,
  onSelect,
  previous,
  next,
  askButton,
  askPanel,
}: {
  selection: Selection;
  children: ReactNode;
  onSelect: Props['onSelect'];
  previous?: () => void;
  next?: () => void;
  askButton?: ReactNode;
  askPanel?: ReactNode;
}) {
  return (
    <RecordDrawer
      full={selection.full}
      title={
        selection.personId
          ? '联系人详情'
          : selection.projectId
            ? '项目详情'
            : selection.full
              ? '客户档案'
              : '客户预览'
      }
      ariaLabel={
        selection.personId
          ? '联系人详情'
          : selection.projectId
            ? '项目详情'
            : selection.full
              ? '完整客户档案'
              : '客户预览'
      }
      expandLabel={
        selection.personId
          ? '展开联系人详情'
          : selection.projectId
            ? '展开完整项目'
            : '展开完整客户档案'
      }
      onClose={() => onSelect(null)}
      onExpand={() => onSelect({ ...selection, full: true })}
      previous={previous}
      next={next}
      askButton={askButton}
      askPanel={askPanel}
    >
      {children}
    </RecordDrawer>
  );
}
function QuickSearch({
  workspace,
  onClose,
  onSelect,
}: {
  workspace: string;
  onClose: () => void;
  onSelect: Props['onSelect'];
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{
    customers: Customer[];
    projects: ProjectRow[];
    people: Person[];
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError('');
    const timer = setTimeout(() => {
      const q = encodeURIComponent(query);
      Promise.all([
        api<CustomerList>(`/customers?q=${q}`, { workspace, signal: controller.signal }),
        api<ProjectList>(`/projects?q=${q}`, { workspace, signal: controller.signal }),
        api<PeopleList>(`/people?q=${q}`, { workspace, signal: controller.signal }),
      ])
        .then(([a, b, c]) =>
          setResult({
            customers: a.items.slice(0, 6),
            projects: b.items.slice(0, 6),
            people: c.items.slice(0, 6),
          }),
        )
        .catch((e) => {
          if (e.name !== 'AbortError') setError(message(e));
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, workspace]);
  const open = (selection: Selection) => {
    onClose();
    onSelect({ ...selection, full: true });
  };
  return (
    <Dialog title="搜索全部记录" onClose={onClose} className="search-dialog">
      <div className="command-search">
        <Search size={18} />
        <input
          aria-label="搜索公司、联系人和项目"
          placeholder="输入客户、联系人、邮箱或项目名称…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="command-results">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : !result ? (
          <p className="command-empty">正在搜索…</p>
        ) : (
          <>
            <h3>客户</h3>
            {result.customers.map((c) => (
              <button key={c.id} onClick={() => open({ customerId: c.id })}>
                <Users size={15} />
                <span>
                  {c.name}
                  <small>{c.contact_name || customerTypes[c.type]}</small>
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
            {!result.customers.length && <p className="command-empty">没有匹配的客户</p>}
            <h3>联系人</h3>
            {result.people.map((p) => (
              <button
                key={p.id}
                onClick={() => open({ customerId: p.customer_id, personId: p.id })}
              >
                <UserRound size={15} />
                <span>
                  {p.name}
                  <small>{p.customer_name}</small>
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
            {!result.people.length && <p className="command-empty">没有匹配的联系人</p>}
            <h3>项目</h3>
            {result.projects.map((p) => (
              <button
                key={p.id}
                onClick={() => open({ customerId: p.customer_id, projectId: p.id })}
              >
                <Folder size={15} />
                <span>
                  {p.name}
                  <small>{p.customer_name}</small>
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
            {!result.projects.length && <p className="command-empty">没有匹配的项目</p>}
          </>
        )}
      </div>
      <footer className="command-footer">
        仅搜索当前有权访问的未归档公司、联系人和项目 <kbd>Esc 关闭</kbd>
      </footer>
    </Dialog>
  );
}

export function Workbench(props: Props) {
  const { session, workspace, members, selected, onSelect, refresh, reload, notify } = props;
  const [section, setSection] = useState<
    | RecordObject
    | 'home'
    | 'chat'
    | 'mail'
    | 'documents'
    | 'notes'
    | 'wechat'
    | 'relationships'
    | 'custom'
    | 'tasks'
    | 'reports'
    | 'prospects'
  >('home');
  const [customObjects, setCustomObjects] = useState<CustomObject[]>([]);
  const [customObjectId, setCustomObjectId] = useState<string | null>(null);
  const [creatingTable, setCreatingTable] = useState(false);
  const [createdLibraryObject, setCreatedLibraryObject] = useState<{
    workspace: string;
    id: string;
  } | null>(null);
  const [settingsObjectId, setSettingsObjectId] = useState<string | null>(null);
  const activeCustomObject = customObjects.find((o) => o.id === customObjectId);
  const [customRecordSummary, setCustomRecordSummary] = useState<CustomRecordSummary | null>(null);
  const updateCustomRecordSummary = useCallback((summary: CustomRecordSummary) => {
    setCustomRecordSummary((current) =>
      JSON.stringify(current) === JSON.stringify(summary) ? current : summary,
    );
  }, []);
  const [askOpen, setAskOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [askListScope, setAskListScope] = useState<Extract<AskScope, { kind: 'list' }> | null>(
    null,
  );
  const updateAskListScope = useCallback((scope: Extract<AskScope, { kind: 'list' }> | null) => {
    setAskListScope((old) => (JSON.stringify(old) === JSON.stringify(scope) ? old : scope));
  }, []);
  const mailTracking = useMailTrackingSummary(workspace.id);
  const notesAvailable = useNotesAvailable(workspace.id, session.actor.id);
  const prospectsAvailable = useProspectsAvailable(workspace.id);
  const [prospectDirty, setProspectDirty] = useState(false);
  const [prospectBusy, setProspectBusy] = useState(false);
  const [prospectEditors, setProspectEditors] = useState<
    Map<string, { dirty: boolean; busy: boolean }>
  >(() => new Map());
  const externalProspectDirty = [...prospectEditors.values()].some((editor) => editor.dirty);
  const externalProspectBusy = [...prospectEditors.values()].some((editor) => editor.busy);
  useEffect(() => {
    setProspectEditors(new Map());
    const update = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (
        detail?.workspace !== workspace.id ||
        typeof detail.token !== 'string' ||
        !detail.token ||
        typeof detail.dirty !== 'boolean' ||
        typeof detail.busy !== 'boolean'
      )
        return;
      setProspectEditors((current) => {
        const next = new Map(current);
        if (!detail.dirty && !detail.busy) next.delete(detail.token);
        else next.set(detail.token, { dirty: detail.dirty, busy: detail.busy });
        return next;
      });
    };
    window.addEventListener('crm:prospect-editor', update);
    return () => window.removeEventListener('crm:prospect-editor', update);
  }, [workspace.id, session.actor.id]);
  const [prospectOpenId, setProspectOpenId] = useState<string | null>(null);
  const [prospectOpenRevision, setProspectOpenRevision] = useState(0);
  const [prospectIntake, setProspectIntake] = useState<ProspectIntakeRequest | null>(null);
  const [prospectSummary, setProspectSummary] = useState<ProspectWorkspaceSummary | null>(null);
  const currentProspectSummary =
    prospectSummary?.workspace === workspace.id && prospectSummary.actorId === session.actor.id
      ? prospectSummary
      : null;
  const [wechatFollowup, setWeChatFollowup] = useState<WeChatFollowup | null>(null);
  const isRecords = section === 'customers' || section === 'people' || section === 'projects';
  const hasPageTopbar =
    selected?.full ||
    !['home', 'wechat', 'mail', 'documents', 'notes', 'relationships', 'reports', 'tasks'].includes(
      section,
    );
  const object: RecordObject = isRecords ? section : 'customers';
  const [chats, setChats] = useState<Chat[]>([]);
  const runOwner = agentRunOwner(workspace.id, session.actor.id);
  useEffect(
    () => onAgentActivity(runOwner, ({ chat }) => setChats((items) => mergeChats(items, [chat]))),
    [runOwner],
  );
  const [chatsExpanded, setChatsExpanded] = useState(false);
  const [chatsCursor, setChatsCursor] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState('');
  const chatsPager = useRef<{ cursor?: string | null; busy: boolean }>({ busy: false });
  const chatsRequest = useRef<AbortController | null>(null);
  const chatsRetryMore = useRef(false);
  const sidebarScroll = useRef<HTMLDivElement>(null);
  const chatsEnd = useRef<HTMLDivElement>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [newChatKey, setNewChatKey] = useState(0);
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [config, setConfig] = useState<ViewConfig>(defaultView('customers'));
  const [baseline, setBaseline] = useState<ViewConfig>(defaultView('customers'));
  const [viewId, setViewId] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState(0);
  const restored = useRef(false);
  const preferenceKey = `light-crm:view:${workspace.id}:${session.actor.id}`;
  function remember(
    object: RecordObject,
    viewId: string | null,
    listId: string | null = activeListId,
  ) {
    try {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({ section: object, object, viewId, listId }),
      );
    } catch {
      /* View data remains in the database. */
    }
  }
  function rememberChat(id: string | null) {
    try {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({ section: id ? 'chat' : 'home', chatId: id }),
      );
    } catch {
      /* Navigation is optional; chats remain saved on the server. */
    }
  }
  const [recordLists, setRecordLists] = useState<RecordList[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [listDialog, setListDialog] = useState<'new' | 'rename' | 'add' | null>(null);
  const [listName, setListName] = useState('');
  const [listObject, setListObject] = useState<RecordObject>('customers');
  const [listError, setListError] = useState('');
  const [listBusy, setListBusy] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const activeList = recordLists.find((l) => l.id === activeListId);
  const [viewTitle, setViewTitle] = useState(allViewNames.customers);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewsError, setViewsError] = useState('');
  const [viewsReady, setViewsReady] = useState(false);
  const [page, setPage] = useState(1);
  const [viewLoadRevision, setViewLoadRevision] = useState(0);
  const [list, setList] = useState<CustomerList | ProjectList | PeopleList | null>(null);
  const [attributeRevision, setAttributeRevision] = useState(0);
  const { fields: companyFields, status: attributeStatus } = useCompanyAttributes(
    workspace.id,
    refresh + attributeRevision,
  );
  const attributeValues = useCompanyAttributeValues(
    workspace.id,
    section === 'customers' && !activeListId
      ? list?.items.filter((row) => !isPerson(row) && !isProject(row)).map((row) => row.id) || []
      : [],
    refresh + attributeRevision,
  );
  const [creatingAttribute, setCreatingAttribute] = useState(false);
  const [editingAttribute, setEditingAttribute] = useState<CompanyAttribute | null>(null);
  const attributeGeneration = useAttributeGeneration(workspace.id, attributeValues.update, () =>
    setAttributeRevision((n) => n + 1),
  );
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState('');
  const [saveDialog, setSaveDialog] = useState<'new' | 'rename' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [searchOpen, setSearchOpen] = useState(false),
    [mobileNav, setMobileNav] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [moving, setMoving] = useState(false);
  const boardDisplay = useKanbanDisplay(
    `${preferenceKey}:cards:${object}`,
    object === 'customers'
      ? ['type', 'owner', 'project_count']
      : object === 'people'
        ? ['customer_name', 'job_title', 'email', 'owner']
        : ['customer_name', 'owner', 'due_date'],
  );
  const tableRef = useRef<HTMLDivElement>(null);
  const draggedColumn = useRef<string | null>(null);
  const [columnQuery, setColumnQuery] = useState('');
  const [listDirty, setListDirty] = useState(false);
  const [mailSettingsDirty, setMailSettingsDirty] = useState(false);
  const dirty =
    externalProspectDirty ||
    (section === 'mail' && mailSettingsDirty) ||
    (section === 'prospects' && prospectDirty) ||
    (isRecords && (activeListId ? listDirty : !equalViewConfig(config, baseline)));
  function openCustom(o: CustomObject) {
    navigate(() => {
      setCustomObjectId(o.id);
      setSection('custom');
      setActiveListId(null);
      onSelect(null);
      try {
        localStorage.setItem(
          preferenceKey,
          JSON.stringify({ section: 'custom', customObjectId: o.id }),
        );
      } catch {
        /* Optional navigation persistence. */
      }
    });
  }
  const currentView = views.find((v) => v.id === viewId);
  const admin = workspace.role === 'admin';
  const columns: Record<string, string> =
    object === 'customers'
      ? {
          ...customerColumns,
          ...Object.fromEntries(companyFields.map((f) => [attributeColumn(f.id), f.name])),
        }
      : object === 'people'
        ? personColumns
        : projectColumns;
  const aiColumns = new Set(
    object === 'customers'
      ? companyFields.filter((field) => field.ai_enabled).map((field) => attributeColumn(field.id))
      : [],
  );
  const sorts: Record<string, string> =
    object === 'customers' ? customerSorts : object === 'people' ? personSorts : projectSorts;
  const types: Record<string, string> =
    object === 'customers' ? customerTypes : object === 'projects' ? projectTypes : {};
  const states: Record<string, string> =
    object === 'customers' ? customerStatuses : object === 'projects' ? projectStages : {};
  const person = (id: string | null) =>
    members.find((m) => m.actor_id === id)?.display_name || '未分配';
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof HttpError && e.status === 401) props.onUnauthorized();
      setError(message(e));
    },
    [props.onUnauthorized],
  );
  const loadChats = useCallback(
    async (more = false) => {
      if (more && (chatsPager.current.busy || !chatsPager.current.cursor)) return;
      chatsRequest.current?.abort();
      const controller = new AbortController();
      chatsRequest.current = controller;
      chatsPager.current.busy = true;
      chatsRetryMore.current = more;
      setChatsLoading(true);
      setChatsError('');
      const cursor = more ? chatsPager.current.cursor : null;
      try {
        const result = await api<ChatPage>(
          `/chats/page?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { workspace: workspace.id, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setChats((current) => mergeChats(current, result.items));
        if (more || chatsPager.current.cursor === undefined) {
          chatsPager.current.cursor = result.next_cursor;
          setChatsCursor(result.next_cursor);
        }
      } catch (e) {
        if (!controller.signal.aborted) setChatsError(message(e));
      } finally {
        if (!controller.signal.aborted) {
          chatsPager.current.busy = false;
          setChatsLoading(false);
        }
      }
    },
    [workspace.id, session.actor.id],
  );
  useEffect(() => {
    chatsRequest.current?.abort();
    chatsPager.current = { busy: false };
    setChats([]);
    setChatsCursor(null);
    setChatsExpanded(false);
    void loadChats();
    return () => chatsRequest.current?.abort();
  }, [loadChats]);
  useEffect(() => {
    if (chatsPager.current.cursor !== undefined) void loadChats();
  }, [refresh]);
  const runningChatIds = chats
    .filter((chat) => chat.run_status && activeAgentRun({ status: chat.run_status }))
    .map((chat) => chat.id)
    .sort()
    .join(',');
  useEffect(() => {
    if (!runningChatIds) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void Promise.all(
        runningChatIds.split(',').map((id) =>
          api<ChatDetail>(`/chats/${id}`, {
            workspace: workspace.id,
            signal: controller.signal,
          })
            .then((detail) => detail.chat)
            .catch((e) => {
              if (e instanceof HttpError && [403, 404].includes(e.status)) {
                if (!controller.signal.aborted)
                  setChats((items) => items.filter((chat) => chat.id !== id));
              }
              return null;
            }),
        ),
      )
        .then((items) => {
          if (!controller.signal.aborted)
            setChats((current) =>
              mergeChats(
                current,
                items.filter((chat): chat is Chat => Boolean(chat)),
              ),
            );
        })
        .catch(() => {});
    }, 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [runningChatIds, runOwner]);
  useEffect(() => {
    if (!chatsExpanded || chatsLoading || chatsError || !chatsCursor || !chatsEnd.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void loadChats(true);
      },
      { root: sidebarScroll.current, rootMargin: '0px 0px 96px 0px' },
    );
    observer.observe(chatsEnd.current);
    return () => observer.disconnect();
  }, [chatsExpanded, chatsLoading, chatsError, chatsCursor, loadChats]);
  const loadViews = useCallback(async () => {
    try {
      const [value, lists, customs] = await Promise.all([
        api<SavedView[]>('/views', { workspace: workspace.id }),
        api<RecordList[]>('/lists', { workspace: workspace.id }),
        api<CustomObject[]>('/custom-objects', { workspace: workspace.id }),
      ]);
      setCustomObjects(customs);
      setRecordLists(lists);
      setViews(value);
      setViewsReady(true);
      setViewsError('');
      if (!restored.current) {
        restored.current = true;
        try {
          const pref = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
          if (pref?.section === 'notes') {
            setSection('notes');
            return;
          }
          if (pref?.section === 'prospects') {
            setSection('prospects');
            setActiveListId(null);
            return;
          }
          if (pref?.section === 'reports') {
            setSection('reports');
            return;
          }
          if (pref?.section === 'documents') {
            setSection('documents');
            return;
          }
          if (pref?.section === 'custom' && customs.some((o) => o.id === pref.customObjectId)) {
            setCustomObjectId(pref.customObjectId);
            setSection('custom');
            return;
          }
          if (pref?.section === 'home' || pref?.section === 'chat') {
            if (pref.section === 'chat' && typeof pref.chatId === 'string') {
              const detail = await api<ChatDetail>(`/chats/${pref.chatId}`, {
                workspace: workspace.id,
              });
              setChats((current) => mergeChats(current, [detail.chat]));
              setSection('chat');
              setChatId(detail.chat.id);
            } else {
              setSection('home');
              setChatId(null);
            }
            return;
          }
          const saved = value.find((v) => v.id === pref?.viewId);
          if (saved) {
            setSection(saved.object);
            setActiveListId(saved.list_id || null);
            setConfig(saved.config);
            setBaseline(saved.config);
            setViewId(saved.id);
            setViewVersion(saved.version);
            setViewTitle(saved.name);
          } else if (pref?.listId && lists.some((l) => l.id === pref.listId)) {
            const l = lists.find((l) => l.id === pref.listId)!;
            const next = defaultView(l.object);
            setSection(l.object);
            setConfig(next);
            setBaseline(next);
            setActiveListId(l.id);
            setViewTitle(allViewNames[l.object]);
          } else if (['customers', 'projects', 'people'].includes(pref?.object)) {
            const next = defaultView(pref.object);
            setSection(pref.object);
            setConfig(next);
            setBaseline(next);
            setViewTitle(allViewNames[pref.object as RecordObject]);
          }
        } catch {
          /* Ignore an unavailable or outdated local preference. */
        }
      }
    } catch (e) {
      setViewsError(message(e));
    }
  }, [workspace.id]);
  useEffect(() => {
    void loadViews();
  }, [loadViews, refresh]);
  const params = new URLSearchParams({
    q: config.query,
    archived: String(config.archived),
    sort: config.sort,
    direction: config.direction,
    page: String(page),
  });
  if (activeListId) params.set('list_id', activeListId);
  if (config.filters?.rules.length) params.set('filters', JSON.stringify(config.filters));
  if (config.type) params.set('type', config.type);
  if (config.status) params.set(object === 'projects' ? 'stage' : 'status', config.status);
  if (config.owner) params.set('owner', config.owner);
  if (object === 'customers' && config.source) params.set('source', config.source);
  if (object === 'customers' && config.region) params.set('region', config.region);
  const queryString = params.toString();
  const askScope: AskScope | null = selected
    ? {
        kind: 'entity',
        object: selected.personId ? 'people' : selected.projectId ? 'projects' : 'customers',
        customer_id: selected.customerId,
        record_id: selected.personId || selected.projectId || selected.customerId,
      }
    : isRecords
      ? activeListId
        ? askListScope?.list_id === activeListId
          ? askListScope
          : null
        : { kind: 'records', object, query: queryString, selected_ids: checked }
      : section === 'home' ||
          section === 'chat' ||
          section === 'custom' ||
          section === 'documents' ||
          section === 'notes' ||
          section === 'reports' ||
          section === 'tasks' ||
          section === 'prospects'
        ? null
        : { kind: 'page', page: section as 'mail' | 'wechat' | 'relationships' };
  const askButton = askScope && (
    <AskTyphaButton open={askOpen} onClick={() => setAskOpen((v) => !v)} />
  );
  const askPanel = askScope && (
    <AskTyphaPanel
      key={`${runOwner}:${JSON.stringify(askScope)}`}
      workspace={workspace.id}
      runOwner={runOwner}
      scope={askScope}
      open={askOpen}
      refresh={refresh}
      onClose={() => setAskOpen(false)}
      onSelect={onSelect}
      onSessionSaved={() => void loadChats()}
    />
  );
  useEffect(() => {
    if (!isRecords || activeListId) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(
      () => {
        api<CustomerList | ProjectList | PeopleList>(`/${object}?${queryString}`, {
          workspace: workspace.id,
          signal: controller.signal,
        })
          .then((result) => {
            setList(result);
            setLoading(false);
            const last = Math.max(1, Math.ceil(result.total / result.page_size));
            if (page > last) setPage(last);
          })
          .catch((e) => {
            if (e.name !== 'AbortError') {
              setList(null);
              setLoading(false);
              fail(e);
            }
          });
      },
      config.query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [object, section, queryString, workspace.id, refresh, viewLoadRevision, fail]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'k' &&
        !document.querySelector('.modal[open]')
      ) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const leave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  useEffect(() => {
    setChecked([]);
  }, [queryString, section, page]);
  function change(patch: Partial<ViewConfig>) {
    setConfig((c) => ({ ...c, ...patch }));
    setPage(1);
    onSelect(null);
  }
  function navigate(action: () => void) {
    closeMenus();
    setMobileNav(false);
    if ((section === 'prospects' && prospectBusy) || externalProspectBusy) {
      notify('正在保存或整理咨询，请等待本次操作完成后再切换。');
      return;
    }
    if (dirty) setPending(() => action);
    else action();
  }
  function openProspects(options?: { id?: string; intake?: ProspectIntakeRequest }) {
    navigate(() => {
      setSection('prospects');
      setActiveListId(null);
      onSelect(null);
      setProspectOpenId(options?.id || null);
      setProspectOpenRevision((value) => value + 1);
      setProspectIntake(options?.intake || null);
      try {
        localStorage.setItem(preferenceKey, JSON.stringify({ section: 'prospects' }));
      } catch {
        /* Optional navigation preference. */
      }
    });
  }
  useEffect(() => {
    const intake = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.workspace !== workspace.id || !prospectsAvailable) return;
      openProspects({
        intake: {
          customerId: typeof detail.customerId === 'string' ? detail.customerId : undefined,
          sourceRecordIds: Array.isArray(detail.sourceRecordIds)
            ? detail.sourceRecordIds.filter((id: unknown): id is string => typeof id === 'string')
            : undefined,
          sourceKind: typeof detail.sourceKind === 'string' ? detail.sourceKind : undefined,
        },
      });
    };
    const open = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (
        detail?.workspace !== workspace.id ||
        typeof detail.id !== 'string' ||
        !prospectsAvailable
      )
        return;
      openProspects({ id: detail.id });
    };
    window.addEventListener('crm:prospect-intake', intake);
    window.addEventListener('crm:prospect-open', open);
    return () => {
      window.removeEventListener('crm:prospect-intake', intake);
      window.removeEventListener('crm:prospect-open', open);
    };
  }, [workspace.id, prospectsAvailable, dirty, prospectBusy, externalProspectBusy, section]);
  function openView(
    target: RecordObject,
    saved?: SavedView,
    preset?: Partial<ViewConfig>,
    title?: string,
    listId?: string | null,
  ) {
    navigate(() => {
      const next = saved?.config || { ...defaultView(target), ...preset };
      setSection(target);
      setActiveListId(saved?.list_id || listId || null);
      setChecked([]);
      setConfig(next);
      setBaseline(next);
      setPage(1);
      setList(null);
      setLoading(true);
      // View selection must reload even when only the name, layout, or columns differ.
      setViewLoadRevision((revision) => revision + 1);
      setViewId(saved?.id || null);
      setViewVersion(saved?.version || 0);
      remember(target, saved?.id || null, saved?.list_id || listId || null);
      setViewTitle(saved?.name || title || allViewNames[target]);
      onSelect(null);
      setError('');
      if (tableRef.current) tableRef.current.scrollTop = 0;
    });
  }
  function openHome(id: string | null = null) {
    navigate(() => {
      rememberChat(id);
      setSection(id ? 'chat' : 'home');
      setChatId(id);
      setNewChatKey((k) => k + 1);
      setActiveListId(null);
      onSelect(null);
    });
  }
  function beginSave(mode: 'new' | 'rename' | 'delete') {
    closeMenus();
    setSaveError('');
    setName(mode === 'new' ? `${viewTitle} 副本` : viewTitle);
    setSaveDialog(mode);
  }
  async function save(mode: 'new' | 'update' | 'rename') {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const original = views.find((v) => v.id === viewId);
      if (mode !== 'new' && !original) throw new Error('视图已不存在，请另存当前视图');
      const value = await api<SavedView>(mode === 'new' ? '/views' : `/views/${viewId}`, {
        workspace: workspace.id,
        method: mode === 'new' ? 'POST' : 'PATCH',
        body: {
          object,
          list_id: activeListId,
          name: mode === 'update' ? viewTitle : name.trim(),
          config,
          ...(mode !== 'new' ? { version: viewVersion } : {}),
        },
      });
      setViews((v) =>
        mode === 'new' ? [...v, value] : v.map((x) => (x.id === value.id ? value : x)),
      );
      setViewId(value.id);
      setViewVersion(value.version);
      remember(object, value.id);
      setViewTitle(value.name);
      setBaseline(value.config);
      setSaveDialog(null);
      notify('个人视图已保存');
    } catch (e) {
      setSaveError(message(e));
    } finally {
      setSaving(false);
    }
  }
  async function deleteView() {
    if (!currentView || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await api(`/views/${currentView.id}`, {
        workspace: workspace.id,
        method: 'DELETE',
        body: { version: viewVersion },
      });
      setViews((v) => v.filter((x) => x.id !== currentView.id));
      setViewId(null);
      remember(object, null);
      setSaveDialog(null);
      const next = defaultView(object);
      setConfig(next);
      setBaseline(next);
      setViewTitle(allViewNames[object]);
      setPage(1);
      onSelect(null);
      notify('个人视图已删除');
    } catch (e) {
      setSaveError(message(e));
    } finally {
      setSaving(false);
    }
  }
  async function move(row: RecordRow, stage: string) {
    if (
      moving ||
      loading ||
      !row.can_edit ||
      config.archived ||
      isPerson(row) ||
      !Object.hasOwn(states, stage) ||
      stateOf(row) === stage
    )
      return;
    const project = isProject(row);
    setMoving(true);
    setError('');
    try {
      await api(
        project ? `/customers/${row.customer_id}/projects/${row.id}` : `/customers/${row.id}`,
        {
          workspace: workspace.id,
          method: 'PATCH',
          body: { version: row.version, [project ? 'stage' : 'status']: stage },
        },
      );
      notify(`已更新为「${states[stage]}」`);
    } catch (e) {
      fail(e);
    } finally {
      setMoving(false);
    }
  }
  function selectionFor(row: RecordRow, full = false): Selection {
    if (isPerson(row)) return { customerId: row.customer_id, personId: row.id, full };
    return isProject(row)
      ? { customerId: row.customer_id, projectId: row.id, full }
      : { customerId: row.id, full };
  }
  const items = list?.items || [];
  function openAttributeGeneration(field: CompanyAttribute, customers: RecordRow[]) {
    closeMenus();
    if (attributeValues.ready && attributeStatus?.configured)
      void attributeGeneration.start(field, customers as Customer[], attributeValues.values);
  }
  const stateOf = (row: RecordRow) =>
    isPerson(row) ? '' : isProject(row) ? row.stage : row.status;
  const order = items;
  const selectedIndex = order.findIndex(
    (r) =>
      selected &&
      (isPerson(r)
        ? r.id === selected.personId
        : isProject(r)
          ? r.id === selected.projectId
          : r.id === selected.customerId),
  );
  const totalPages = Math.max(1, Math.ceil((list?.total || 0) / 30));
  const activeFilterCount =
    [
      config.type,
      config.status,
      config.source,
      config.owner,
      config.region,
      config.archived,
    ].filter(Boolean).length + (config.filters?.rules.length || 0);
  function cell(row: RecordRow, key: string): ReactNode {
    if (object === 'customers' && key.startsWith('attr:')) {
      const f = companyFields.find((f) => attributeColumn(f.id) === key);
      const current = attributeValues.values.find(
        (v) => v.customer_id === row.id && v.attribute_id === f?.id,
      );
      return f ? (
        <AttributeTableCell
          key={`${workspace.id}:${row.id}:${f.id}`}
          workspace={workspace.id}
          customer={row as Customer}
          field={f}
          current={current}
          ready={attributeValues.ready}
          configured={!!attributeStatus?.configured}
          generationBusy={attributeGeneration.busy}
          job={attributeGeneration.jobs[attributeJobKey(row.id, f.id)]}
          onGenerate={() => openAttributeGeneration(f, [row])}
          onSaved={attributeValues.update}
        />
      ) : (
        <span className="muted">属性不可用</span>
      );
    }
    const project = isProject(row);
    const contact = isPerson(row);
    switch (key) {
      case 'email_strength':
        return !project ? <EmailStrength value={row.email_strength} /> : null;
      case 'first_email_at':
      case 'last_email_at':
      case 'last_inbound_at':
      case 'last_outbound_at':
        return !project ? <EmailTime value={row[key]} /> : null;
      case 'email_count':
        return !project ? `${row.email_count ?? 0} 封` : null;
      case 'name':
        return (
          <div className="record-name-cell">
            <button
              className="record-name"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(selectionFor(row, true));
              }}
            >
              {row.name}
            </button>
            <button
              className="preview-button"
              aria-label={`预览${row.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(selectionFor(row));
              }}
            >
              <PanelRight size={14} />
            </button>
          </div>
        );
      case 'customer_name':
        return 'customer_id' in row ? (
          <button
            className="table-link"
            onClick={(e) => {
              e.stopPropagation();
              onSelect({ customerId: row.customer_id, full: true });
            }}
          >
            {row.customer_name}
          </button>
        ) : null;
      case 'type':
        return <span className="record-type-label">{'type' in row ? types[row.type] : ''}</span>;
      case 'status':
      case 'stage':
        if (contact) return null;
        return row.can_edit && !config.archived ? (
          <select
            className="table-stage"
            aria-label={`更新${row.name}的${project ? '阶段' : '合作状态'}`}
            value={stateOf(row)}
            disabled={moving}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => void move(row, e.target.value)}
          >
            {Object.entries(states).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          states[stateOf(row)]
        );
      case 'owner':
        return person(row.owner_id);
      case 'updated_at':
      case 'created_at':
        return <time title={row[key]}>{shortDate(row[key])}</time>;
      case 'due_date':
        return project ? row.due_date || <span className="missing">未设置</span> : null;
      case 'contact':
        return !project && !contact
          ? row.contact_name || <span className="missing">未填写</span>
          : null;
      case 'source':
        return !project && !contact ? sources[row.source] : null;
      case 'project_count':
        return !project && !contact ? (
          <button
            className="table-link"
            onClick={(e) => {
              e.stopPropagation();
              onSelect({ customerId: row.id, full: true, customerTab: 'projects' });
            }}
          >
            {'project_count' in row ? row.project_count || 0 : 0} 个项目
          </button>
        ) : null;
      default:
        return !project
          ? (row[key as keyof typeof row] as string) || <span className="missing">—</span>
          : null;
    }
  }
  async function addChecked(id: string, remove = false) {
    setListBusy(true);
    setError('');
    closeMenus();
    try {
      await api(`/lists/${id}/entries`, {
        workspace: workspace.id,
        method: remove ? 'DELETE' : 'POST',
        body: {
          entries: items.filter((r) => checked.includes(r.id)).map(listEntry),
        },
      });
      setChecked([]);
      notify(remove ? '已从清单移除，原记录保留' : '已加入清单');
    } catch (e) {
      fail(e);
    } finally {
      setListBusy(false);
    }
  }
  async function saveList() {
    setListBusy(true);
    setListError('');
    try {
      const created = await api<RecordList>(
        listDialog === 'rename' ? `/lists/${activeListId}` : '/lists',
        {
          workspace: workspace.id,
          method: listDialog === 'rename' ? 'PATCH' : 'POST',
          body:
            listDialog === 'rename'
              ? { name: listName, version: activeList!.version }
              : {
                  name: listName,
                  object: listObject,
                  ...(checked.length && listObject === object
                    ? {
                        entries: items.filter((r) => checked.includes(r.id)).map(listEntry),
                      }
                    : {}),
                },
        },
      );
      setRecordLists((prev) =>
        listDialog === 'rename'
          ? prev.map((l) => (l.id === created.id ? { ...l, ...created } : l))
          : [...prev, created],
      );
      setListDialog(null);
      notify(listDialog === 'rename' ? '清单已重命名' : '清单已创建');
      if (listDialog === 'new')
        openView(created.object, undefined, undefined, undefined, created.id);
    } catch (e) {
      setListError(message(e));
      void loadViews();
    } finally {
      setListBusy(false);
    }
  }
  return (
    <div className="shell attio-shell">
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <ResizableSidebar storageKey={`${workspace.id}:${session.actor.id}`} mobileOpen={mobileNav}>
        <div className="workspace-switch">
          <div className="workspace-tag">
            <strong className="workspace-wordmark" title={workspace.name}>
              <span className="workspace-brand-name">Typha</span>{' '}
              <span className="workspace-brand-descriptor">AI CRM</span>
            </strong>
            {session.workspaces.length > 1 && (
              <select
                aria-label="切换工作空间"
                value={workspace.id}
                onChange={(e) => navigate(() => props.onWorkspace(e.target.value))}
              >
                {session.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button
            className="icon-button mobile-close"
            onClick={() => setMobileNav(false)}
            aria-label="关闭导航"
          >
            <X size={16} />
          </button>
        </div>
        <button
          className="sidebar-search"
          onClick={() => {
            setSearchOpen(true);
            setMobileNav(false);
          }}
        >
          <Search size={15} />
          <span>快捷操作</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="sidebar-scroller" ref={sidebarScroll}>
          <nav aria-label="主要功能">
            <button className={section === 'home' ? 'active' : ''} onClick={() => openHome()}>
              <Home size={16} />
              <span>首页</span>
            </button>
            <button
              className={section === 'tasks' ? 'active' : ''}
              onClick={() =>
                navigate(() => {
                  setSection('tasks');
                  onSelect(null);
                })
              }
            >
              <ClipboardCheck size={15} />
              <span>待办</span>
            </button>
            <button
              className={section === 'notes' ? 'active' : !notesAvailable ? 'nav-unavailable' : ''}
              disabled={!notesAvailable}
              title={notesAvailable ? '客户笔记' : '笔记服务尚未加载'}
              onClick={() =>
                navigate(() => {
                  setSection('notes');
                  onSelect(null);
                  try {
                    localStorage.setItem(preferenceKey, JSON.stringify({ section: 'notes' }));
                  } catch {
                    /* Optional navigation preference. */
                  }
                })
              }
            >
              <FileText size={15} />
              <span>笔记</span>
            </button>
            <button
              className={section === 'reports' ? 'active' : ''}
              onClick={() =>
                navigate(() => {
                  setSection('reports');
                  onSelect(null);
                  try {
                    localStorage.setItem(preferenceKey, JSON.stringify({ section: 'reports' }));
                  } catch {
                    /* Optional navigation preference. */
                  }
                })
              }
            >
              <BarChart3 size={15} />
              <span>报告</span>
            </button>
            <button
              className={section === 'documents' ? 'active' : ''}
              onClick={() =>
                navigate(() => {
                  setSection('documents');
                  onSelect(null);
                  try {
                    localStorage.setItem(preferenceKey, JSON.stringify({ section: 'documents' }));
                  } catch {
                    /* Files remain available on the server. */
                  }
                })
              }
            >
              <Files size={15} />
              <span>文件</span>
            </button>
            <button
              className={section === 'mail' ? 'active' : ''}
              onClick={() =>
                navigate(() => {
                  setSection('mail');
                  onSelect(null);
                })
              }
            >
              <Mail size={15} />
              <span>邮件管理</span>
              {!!mailTracking.summary?.unread && (
                <span
                  className="notification-badge"
                  aria-label={`${mailTracking.summary.unread} 封新邮件`}
                >
                  {mailTracking.summary.unread > 99 ? '99+' : mailTracking.summary.unread}
                </span>
              )}
            </button>
            <button
              className={section === 'wechat' ? 'active' : ''}
              onClick={() =>
                navigate(() => {
                  setSection('wechat');
                  onSelect(null);
                })
              }
            >
              <MessageSquare size={15} />
              <span>微信沟通管理</span>
            </button>
            {admin && (
              <button
                className={section === 'relationships' ? 'active' : ''}
                onClick={() =>
                  navigate(() => {
                    setSettingsObjectId(null);
                    setSection('relationships');
                    onSelect(null);
                  })
                }
              >
                <Settings2 size={16} />
                <span>实体与关系</span>
              </button>
            )}
          </nav>
          <SidebarGroup
            key={`library:${preferenceKey}`}
            id="sidebar-library"
            label="资料库"
            navLabel="工作空间导航"
            revealKey={
              createdLibraryObject?.workspace === workspace.id ? createdLibraryObject.id : undefined
            }
            action={
              admin && (
                <button
                  className="icon-button"
                  aria-label="新建表格"
                  title="新建表格"
                  onClick={() => {
                    closeMenus();
                    setMobileNav(false);
                    setCreatingTable(true);
                  }}
                >
                  <Plus size={13} />
                </button>
              )
            }
            items={[
              <button
                key="customers"
                className={section === 'customers' && !activeListId ? 'active' : ''}
                onClick={() => openView('customers')}
              >
                <Building2 size={16} />
                <span>公司</span>
              </button>,
              <button
                key="prospects"
                className={
                  section === 'prospects' ? 'active' : !prospectsAvailable ? 'nav-unavailable' : ''
                }
                disabled={!prospectsAvailable}
                title={
                  prospectsAvailable
                    ? '按每笔咨询的条件、负责人和日期持续跟进'
                    : '潜在客户服务尚未加载'
                }
                onClick={() => openProspects()}
              >
                <ClipboardCheck size={16} />
                <span>潜在客户</span>
              </button>,
              <button
                key="people"
                className={section === 'people' && !activeListId ? 'active' : ''}
                onClick={() => openView('people')}
              >
                <UserRound size={16} />
                <span>联系人</span>
              </button>,
              <button
                key="projects"
                className={section === 'projects' && !activeListId ? 'active' : ''}
                onClick={() => openView('projects')}
              >
                <Folder size={16} />
                <span>项目</span>
              </button>,
              ...customObjects.map((o) => (
                <button
                  key={o.id}
                  className={section === 'custom' && customObjectId === o.id ? 'active' : ''}
                  onClick={() => openCustom(o)}
                >
                  <CustomObjectIcon object={o} />
                  <span>{o.name}</span>
                </button>
              )),
            ]}
          />
          <SidebarGroup
            key={`lists:${preferenceKey}`}
            id="sidebar-lists"
            label="清单"
            action={
              <button
                className="icon-button"
                aria-label="创建清单"
                onClick={() => {
                  setListName('');
                  setListObject(object);
                  setListError('');
                  setListDialog('new');
                }}
              >
                <Plus size={13} />
              </button>
            }
            items={recordLists.map((l) => (
              <button
                key={l.id}
                className={isRecords && activeListId === l.id ? 'active' : ''}
                onClick={() => openView(l.object, undefined, undefined, undefined, l.id)}
              >
                <LayoutList size={15} />
                <span>{l.name}</span>
                <small>{l.count || 0}</small>
              </button>
            ))}
          >
            {() => (
              <>
                {!recordLists.length && viewsReady && (
                  <button
                    className="sidebar-empty create-list-empty"
                    onClick={() => {
                      setListName('');
                      setListObject(object);
                      setListError('');
                      setListDialog('new');
                    }}
                  >
                    创建你的第一份清单
                  </button>
                )}
                {viewsError && (
                  <div className="sidebar-empty" role="alert">
                    {viewsError}
                    <button className="text-button" onClick={() => void loadViews()}>
                      重新加载
                    </button>
                  </div>
                )}
              </>
            )}
          </SidebarGroup>
          <SidebarGroup
            key={`chats:${preferenceKey}`}
            id="sidebar-chat-history"
            label="对话"
            itemsId="sidebar-chat-history-items"
            itemsClassName="chat-history-items"
            busy={chatsLoading}
            hasMore={chats.length > 5 || !!chatsCursor}
            onExpandedChange={setChatsExpanded}
            action={
              <button
                className="icon-button"
                aria-label="新建对话"
                title="新建对话"
                onClick={() => openHome()}
              >
                <Plus size={13} />
              </button>
            }
            items={chats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-history-item ${section === 'chat' && chatId === chat.id ? 'active' : ''}`}
                onClick={() => openHome(chat.id)}
                title={`${chat.title}${chat.origin ? ` · 来自${chat.origin.label}` : ''}`}
              >
                <span className="chat-history-copy">
                  <span>{chat.title}</span>
                  {chat.origin && <small className="chat-origin-label">{chat.origin.label}</small>}
                </span>
                {chat.run_status && activeAgentRun({ status: chat.run_status }) && (
                  <span
                    className="chat-history-running"
                    role="status"
                    aria-label={chat.run_status === 'cancelling' ? '正在停止' : '正在回复'}
                  />
                )}
              </button>
            ))}
          >
            {(expanded) => (
              <>
                {(expanded || !chats.length) && (
                  <div className="chat-history-status" ref={chatsEnd} aria-live="polite">
                    {chatsError ? (
                      <>
                        <span role="alert">{chatsError}</span>
                        <button onClick={() => void loadChats(chatsRetryMore.current)}>重试</button>
                      </>
                    ) : chatsLoading ? (
                      '正在加载…'
                    ) : chatsCursor ? (
                      '向下滚动加载更多'
                    ) : chats.length ? (
                      '已显示全部对话'
                    ) : (
                      '暂无对话'
                    )}
                  </div>
                )}
                {!expanded && !!chats.length && chatsError && (
                  <div className="chat-history-status" role="alert">
                    <span>{chatsError}</span>
                    <button onClick={() => void loadChats(chatsRetryMore.current)}>重试</button>
                  </div>
                )}
              </>
            )}
          </SidebarGroup>
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-user">
            <div className="sidebar-user-details">
              <strong>{session.actor.display_name}</strong>
              <small>{admin ? '管理员' : '工作空间成员'}</small>
            </div>
            <div className="sidebar-user-actions">
              <button
                className="icon-button sidebar-settings-button"
                aria-label="设置"
                title="设置"
                onClick={() => {
                  setMobileNav(false);
                  setPreferencesOpen(true);
                }}
              >
                <Settings2 size={16} aria-hidden="true" />
              </button>
              {session.auth_mode !== 'local' && (
                <button
                  className="icon-button"
                  aria-label="退出登录"
                  onClick={() => navigate(props.onLogout)}
                >
                  <LogOut size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </ResizableSidebar>
      <div className={`main ${hasPageTopbar ? '' : 'main-without-topbar'}`}>
        {!hasPageTopbar ? (
          <button
            className="icon-button mobile-menu standalone-nav"
            onClick={() => setMobileNav(true)}
            aria-label="打开导航"
          >
            <Menu size={18} />
          </button>
        ) : (
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(true)}
              aria-label="打开导航"
            >
              <Menu size={18} />
            </button>
            <div
              className={`breadcrumb ${section === 'chat' && !selected?.full ? 'chat-page-title' : ''} ${section === 'custom' ? 'custom-page-breadcrumb' : ''}`}
            >
              {section === 'home' || section === 'chat' ? (
                section === 'home' ? (
                  <Home size={14} />
                ) : (
                  <MessageSquare size={14} />
                )
              ) : section === 'custom' && activeCustomObject ? (
                <CustomObjectIcon object={activeCustomObject} size={14} />
              ) : section === 'projects' ? (
                <Folder size={14} />
              ) : (
                <Users size={14} />
              )}
              <strong>
                {section === 'home'
                  ? '首页'
                  : section === 'chat'
                    ? chats.find((c) => c.id === chatId)?.title || '新对话'
                    : section === 'mail'
                      ? '邮件管理'
                      : section === 'prospects'
                        ? '潜在客户'
                        : section === 'wechat'
                          ? '微信沟通管理'
                          : section === 'tasks'
                            ? '待办'
                            : section === 'relationships'
                              ? '实体与关系'
                              : section === 'custom'
                                ? activeCustomObject?.name || '表格'
                                : activeList?.name || objectLabels[object]}
              </strong>
              {section === 'chat' &&
                !selected?.full &&
                chats.find((c) => c.id === chatId)?.origin && (
                  <small className="chat-page-origin">
                    {chats.find((c) => c.id === chatId)?.origin?.label}
                  </small>
                )}
              <ChevronRight size={12} />
              <span>
                {selected?.full
                  ? selected.personId
                    ? '联系人详情'
                    : selected.projectId
                      ? '项目详情'
                      : '客户档案'
                  : section === 'home'
                    ? '智能助手'
                    : section === 'chat'
                      ? chats.find((c) => c.id === chatId)?.title || '对话'
                      : ['wechat', 'relationships', 'mail'].includes(section)
                        ? workspace.name
                        : section === 'prospects'
                          ? currentProspectSummary?.full
                            ? '咨询详情'
                            : currentProspectSummary?.viewName || '全部潜在客户'
                          : section === 'custom'
                            ? customRecordSummary?.objectId === customObjectId &&
                              customRecordSummary.archived
                              ? '已归档记录'
                              : '全部记录'
                            : activeList
                              ? '清单'
                              : viewTitle}
              </span>
            </div>
            <div className="topbar-actions">
              {section === 'chat' && !selected?.full && (
                <button
                  className="icon-button"
                  title="新建客户对话"
                  aria-label="新建客户对话"
                  onClick={() => openHome()}
                >
                  <Plus size={15} />
                </button>
              )}
              {isRecords && !activeListId && !selected?.full && (
                <span className="topbar-note">
                  {loading ? '加载中' : `${list?.total ?? 0} 条记录`}
                </span>
              )}
              {section === 'prospects' && !selected?.full && !currentProspectSummary?.full && (
                <span className="topbar-note">
                  {!currentProspectSummary || currentProspectSummary.loading
                    ? '加载中'
                    : `${currentProspectSummary.total ?? 0} 条记录`}
                </span>
              )}
              {section === 'custom' && !selected?.full && (
                <span className="topbar-note">
                  {customRecordSummary?.objectId !== customObjectId || customRecordSummary.loading
                    ? '加载中'
                    : `${customRecordSummary.total ?? '—'} 条记录`}
                </span>
              )}
              {(!selected || selected.full) && askButton}
            </div>
          </header>
        )}
        <div
          className={`work-area ${selected ? 'has-detail' : ''} ${selected?.full ? 'has-full-detail' : ''}`}
        >
          <main
            className="content"
            aria-hidden={selected?.full || undefined}
            style={selected?.full ? { display: 'none' } : undefined}
          >
            {section === 'home' || section === 'chat' ? (
              <HomeAgent
                onSelect={onSelect}
                key={chatId || `new-${newChatKey}`}
                workspace={workspace.id}
                tablePreferenceKey={preferenceKey}
                runOwner={runOwner}
                foreground={!selected?.full}
                admin={admin}
                chatId={chatId}
                members={members}
                refresh={refresh}
                onProject={(project) =>
                  onSelect({ customerId: project.customer_id, projectId: project.id, full: true })
                }
                wechatFollowup={wechatFollowup}
                onWeChatFollowupConsumed={() => setWeChatFollowup(null)}
                onChat={(chat, followup) => {
                  setWeChatFollowup(followup || null);
                  rememberChat(chat.id);
                  setChatId(chat.id);
                  setSection('chat');
                  setChats((prev) => [chat, ...prev.filter((c) => c.id !== chat.id)]);
                }}
                onRecords={(target, listId) =>
                  openView(target, undefined, undefined, undefined, listId)
                }
                onCustomer={(id) => onSelect({ customerId: id, full: true })}
                onChanged={() => notify('记录已创建，可以在 资料库和清单 中继续跟进')}
              />
            ) : section === 'prospects' ? (
              prospectsAvailable ? (
                <ProspectsWorkspace
                  key={`${workspace.id}:${session.actor.id}`}
                  workspace={workspace.id}
                  actorId={session.actor.id}
                  members={members}
                  admin={admin}
                  openId={prospectOpenId}
                  openRevision={prospectOpenRevision}
                  pendingIntake={prospectIntake}
                  onIntakeConsumed={() => setProspectIntake(null)}
                  onDirty={setProspectDirty}
                  onBusy={setProspectBusy}
                  onSummary={setProspectSummary}
                  onProject={(customerId, projectId, ask) => {
                    onSelect({ customerId, projectId, full: true });
                    if (ask) setAskOpen(true);
                  }}
                  onCustomer={(customerId) => onSelect({ customerId, full: true })}
                />
              ) : (
                <p className="muted">潜在客户服务尚未加载。</p>
              )
            ) : section === 'notes' ? (
              <NotesWorkspace
                key={`${workspace.id}:${session.actor.id}`}
                workspace={workspace.id}
                actorId={session.actor.id}
              />
            ) : section === 'reports' ? (
              <ReportsWorkspace
                key={`${workspace.id}:${session.actor.id}`}
                workspace={workspace.id}
                actorId={session.actor.id}
                onSelect={onSelect}
                notify={notify}
              />
            ) : section === 'tasks' ? (
              <TeamTasks
                key={workspace.id}
                workspace={workspace.id}
                askButton={askButton}
                onUnauthorized={props.onUnauthorized}
              />
            ) : section === 'documents' ? (
              <DocumentsWorkspace
                key={workspace.id}
                workspace={workspace.id}
                refresh={refresh}
                onSelect={onSelect}
              />
            ) : section === 'mail' ? (
              <MailCenter
                askButton={!selected ? askButton : undefined}
                onDirty={setMailSettingsDirty}
                workspace={workspace.id}
                admin={admin}
                onSelect={onSelect}
                onRefresh={reload}
                refreshVersion={mailTracking.revision}
              />
            ) : section === 'wechat' ? (
              <WeChatWorkspace
                workspace={workspace.id}
                admin={admin}
                askButton={!selected ? askButton : undefined}
              />
            ) : section === 'relationships' ? (
              <RelationSettings
                key={workspace.id}
                workspace={workspace.id}
                initialCustomId={settingsObjectId}
                onOpenCustom={openCustom}
                onChanged={() => {
                  setAttributeRevision((n) => n + 1);
                  void loadViews();
                }}
              />
            ) : section === 'custom' ? (
              activeCustomObject ? (
                <CustomObjectRecords
                  key={`${workspace.id}:${session.actor.id}:${activeCustomObject.id}`}
                  workspace={workspace.id}
                  actorId={session.actor.id}
                  object={activeCustomObject}
                  admin={admin}
                  onChanged={() => void loadViews()}
                  onSummary={updateCustomRecordSummary}
                  onManage={() => {
                    setSettingsObjectId(activeCustomObject.id);
                    setSection('relationships');
                  }}
                />
              ) : (
                <p className="error">实体不存在，请从资料库重新选择。</p>
              )
            ) : activeList ? (
              <ListWorkspace
                key={`${workspace.id}:${activeList.id}:${viewId || 'default'}`}
                list={activeList}
                tablePreferenceKey={preferenceKey}
                workspace={workspace.id}
                members={members}
                views={views}
                initialView={currentView}
                refresh={refresh}
                onChanged={() => {
                  void loadViews();
                }}
                onSelect={onSelect}
                onRename={() => {
                  setListName(activeList.name);
                  setListError('');
                  setListDialog('rename');
                }}
                onDirty={setListDirty}
                onAskScope={updateAskListScope}
                onRemember={(id) => remember(object, id, activeList.id)}
              />
            ) : (
              <>
                <div className="view-heading">
                  <Popover
                    label={viewTitle}
                    icon={
                      config.layout === 'list' ? <LayoutList size={15} /> : <Columns3 size={15} />
                    }
                    className="view-selector"
                  >
                    <p className="popover-caption">{`${objectNames[object]}视图`}</p>
                    <button
                      className="menu-item"
                      onClick={() =>
                        openView(object, undefined, undefined, undefined, activeListId)
                      }
                    >
                      {allViewNames[object]}
                    </button>
                    {views
                      .filter((v) => v.object === object && (v.list_id || null) === activeListId)
                      .map((v) => (
                        <button
                          className="menu-item"
                          key={v.id}
                          onClick={() => openView(object, v)}
                        >
                          <Bookmark size={14} />
                          {v.name}
                        </button>
                      ))}
                  </Popover>
                  <Popover
                    label="视图设置"
                    icon={<Settings2 size={14} />}
                    className="columns-popover"
                  >
                    <div className="settings-layout">
                      <span>显示方式</span>
                      <button
                        className={config.layout === 'list' ? 'current' : ''}
                        onClick={() => change({ layout: 'list' })}
                      >
                        <Table2 size={13} />
                        表格
                      </button>
                      <button
                        className={config.layout === 'board' ? 'current' : ''}
                        onClick={() => change({ layout: 'board' })}
                      >
                        <Columns3 size={13} />
                        卡片
                      </button>
                    </div>
                  </Popover>
                  {dirty && (
                    <>
                      <span className="unsaved-label">未保存</span>
                      <button
                        className="text-button"
                        onClick={() => {
                          setConfig(baseline);
                          setPage(1);
                          onSelect(null);
                        }}
                      >
                        撤销更改
                      </button>
                    </>
                  )}
                  <div className="view-heading-actions">
                    {' '}
                    {!selected?.full &&
                      (activeList ? (
                        <button
                          className="primary"
                          onClick={() => {
                            setListError('');
                            setListDialog('add');
                          }}
                        >
                          <Plus size={14} />
                          添加到清单
                        </button>
                      ) : object === 'customers' ? (
                        admin && (
                          <button
                            className="primary"
                            onClick={() =>
                              props.onCreateCustomer((config.type as Customer['type']) || undefined)
                            }
                          >
                            <Plus size={14} />
                            新建记录
                          </button>
                        )
                      ) : object === 'people' ? (
                        <button className="primary" onClick={() => setCreatingPerson(true)}>
                          <Plus size={14} />
                          新建记录
                        </button>
                      ) : (
                        <button
                          className="primary"
                          onClick={() =>
                            props.onCreateProject((config.type as ProjectRow['type']) || undefined)
                          }
                        >
                          <Plus size={14} />
                          新建记录
                        </button>
                      ))}
                    <ViewSaveMenu
                      canUpdate={!!currentView}
                      busy={saving}
                      onSave={() => void save('update')}
                      onSaveAs={() => beginSave('new')}
                    />
                    {viewId && (
                      <Popover
                        label="更多"
                        icon={<MoreHorizontal size={15} />}
                        className="view-more"
                      >
                        <button className="menu-item" onClick={() => beginSave('rename')}>
                          重命名视图
                        </button>
                        <button
                          className="menu-item"
                          onClick={() => {
                            closeMenus();
                            void loadViews();
                          }}
                        >
                          刷新个人视图列表
                        </button>
                        <button
                          className="menu-item danger-text"
                          onClick={() => beginSave('delete')}
                        >
                          删除此视图
                        </button>
                      </Popover>
                    )}
                  </div>
                </div>
                {saveError && !saveDialog && (
                  <div className="error" role="alert">
                    {saveError}
                    <button onClick={() => beginSave('new')}>另存当前配置</button>
                    <button
                      onClick={() => {
                        void loadViews();
                        setSaveError('');
                      }}
                    >
                      刷新视图列表
                    </button>
                  </div>
                )}
                <div className="view-toolbar">
                  <div className="toolbar-options">
                    <Popover
                      label={`排序 · ${sorts[config.sort]}`}
                      icon={<ArrowDownUp size={14} />}
                    >
                      <p className="popover-caption">对全部筛选结果排序</p>
                      <label>
                        排序字段
                        <select
                          value={config.sort}
                          onChange={(e) => change({ sort: e.target.value })}
                        >
                          {Object.entries(sorts).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        顺序
                        <select
                          value={config.direction}
                          onChange={(e) => change({ direction: e.target.value as 'asc' | 'desc' })}
                        >
                          <option value="asc">升序</option>
                          <option value="desc">降序</option>
                        </select>
                      </label>
                    </Popover>
                    <Popover
                      label={`筛选${activeFilterCount ? ` ${activeFilterCount}` : ''}`}
                      icon={<SlidersHorizontal size={14} />}
                      className="filter-popover"
                    >
                      <FilterBuilder
                        object={object}
                        members={members}
                        value={config.filters || { match: 'all', rules: [] }}
                        onChange={(filters) => change({ filters })}
                      />
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={config.archived}
                          onChange={(e) => change({ archived: e.target.checked })}
                        />
                        只看已归档记录
                      </label>
                      <button
                        className="text-button"
                        onClick={() =>
                          change({
                            filters: { match: 'all', rules: [] },
                            type: '',
                            status: '',
                            source: '',
                            owner: '',
                            region: '',
                            archived: false,
                          })
                        }
                      >
                        清除所有筛选
                      </button>
                    </Popover>
                    {config.layout === 'board' && (
                      <Popover
                        label="卡片字段"
                        icon={<Columns3 size={13} />}
                        className="columns-popover column-visibility-popover card-fields-popover"
                      >
                        <p className="popover-caption">
                          {object === 'people' ? '姓名固定显示' : '名称和状态固定显示'} ·
                          其余字段本机保存
                        </p>
                        {Object.entries(columns)
                          .filter(([key]) => !['name', 'status', 'stage'].includes(key))
                          .map(([key, label]) => (
                            <label className="column-visibility-option" key={key}>
                              <input
                                type="checkbox"
                                checked={boardDisplay.fields.includes(key)}
                                onChange={(e) => {
                                  const visible = e.target.checked;
                                  boardDisplay.setFields(
                                    visible
                                      ? [...boardDisplay.fields, key]
                                      : boardDisplay.fields.filter((id) => id !== key),
                                  );
                                }}
                              />
                              <span title={aiColumns.has(key) ? 'AI 整理已启用' : undefined}>
                                {aiColumns.has(key) && (
                                  <Sparkles
                                    size={12}
                                    className="custom-ai-heading"
                                    aria-hidden="true"
                                  />
                                )}
                                {label}
                              </span>
                            </label>
                          ))}
                      </Popover>
                    )}
                    {config.layout === 'list' && (
                      <Popover
                        label="表格字段"
                        icon={<Table2 size={14} />}
                        className="columns-popover column-visibility-popover card-fields-popover"
                      >
                        {object === 'projects' ? (
                          <>
                            <p className="popover-caption">Columns · 显示、隐藏或调整列顺序</p>
                            <input
                              aria-label="搜索列"
                              placeholder="搜索属性…"
                              value={columnQuery}
                              onChange={(e) => setColumnQuery(e.target.value)}
                            />
                            {config.columns.map(
                              (key, i) =>
                                columns[key].includes(columnQuery) && (
                                  <div className="column-setting" key={key}>
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked
                                        disabled={key === 'name'}
                                        onChange={() =>
                                          change({
                                            columns: config.columns.filter((k) => k !== key),
                                          })
                                        }
                                      />
                                      {columns[key]}
                                    </label>
                                    <button
                                      className="icon-button"
                                      aria-label={`上移${columns[key]}`}
                                      disabled={i <= 1}
                                      onClick={() => {
                                        const next = [...config.columns];
                                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                                        change({ columns: next });
                                      }}
                                    >
                                      <ArrowUp size={13} />
                                    </button>
                                    <button
                                      className="icon-button"
                                      aria-label={`下移${columns[key]}`}
                                      disabled={i === 0 || i === config.columns.length - 1}
                                      onClick={() => {
                                        const next = [...config.columns];
                                        [next[i + 1], next[i]] = [next[i], next[i + 1]];
                                        change({ columns: next });
                                      }}
                                    >
                                      <ArrowDown size={13} />
                                    </button>
                                  </div>
                                ),
                            )}
                            {Object.keys(columns)
                              .filter(
                                (k) =>
                                  !config.columns.includes(k) && columns[k].includes(columnQuery),
                              )
                              .map((key) => (
                                <label className="hidden-column" key={key}>
                                  <input
                                    type="checkbox"
                                    checked={false}
                                    onChange={() => change({ columns: [...config.columns, key] })}
                                  />
                                  {columns[key]}
                                </label>
                              ))}
                          </>
                        ) : (
                          <>
                            <p className="popover-caption">勾选显示，取消勾选隐藏</p>
                            <input
                              aria-label="搜索显示列"
                              placeholder="搜索属性…"
                              value={columnQuery}
                              onChange={(e) => setColumnQuery(e.target.value)}
                            />
                            {Object.entries(columns)
                              .filter(([, label]) =>
                                label.toLowerCase().includes(columnQuery.trim().toLowerCase()),
                              )
                              .map(([key, label]) => (
                                <label className="column-visibility-option" key={key}>
                                  <input
                                    type="checkbox"
                                    checked={config.columns.includes(key)}
                                    disabled={key === 'name'}
                                    onChange={(e) =>
                                      change({
                                        columns: e.target.checked
                                          ? [...config.columns, key]
                                          : config.columns.filter((column) => column !== key),
                                      })
                                    }
                                  />
                                  <span title={aiColumns.has(key) ? 'AI 整理已启用' : undefined}>
                                    {aiColumns.has(key) && (
                                      <Sparkles
                                        size={12}
                                        className="custom-ai-heading"
                                        aria-hidden="true"
                                      />
                                    )}
                                    {label}
                                  </span>
                                  {key === 'name' && <small>固定</small>}
                                </label>
                              ))}
                            {!Object.values(columns).some((label) =>
                              label.toLowerCase().includes(columnQuery.trim().toLowerCase()),
                            ) && <p className="popover-caption">没有匹配的属性</p>}
                          </>
                        )}
                      </Popover>
                    )}
                  </div>
                  <label className="search">
                    <Search size={15} />
                    <input
                      aria-label={`搜索${objectNames[object]}`}
                      placeholder={
                        object === 'customers'
                          ? '搜索公司、客户、邮箱…'
                          : object === 'people'
                            ? '搜索姓名、公司、邮箱…'
                            : '搜索项目或客户…'
                      }
                      maxLength={100}
                      value={config.query}
                      onChange={(e) => change({ query: e.target.value })}
                    />
                    {config.query && (
                      <button
                        className="icon-button"
                        aria-label="清除搜索"
                        onClick={() => change({ query: '' })}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </label>
                </div>
                {activeFilterCount > 0 && (
                  <div className="active-conditions">
                    {config.filters?.rules.map((rule, i) => (
                      <button
                        key={i}
                        onClick={() =>
                          change({
                            filters: {
                              ...config.filters!,
                              rules: config.filters!.rules.filter((_, index) => index !== i),
                            },
                          })
                        }
                      >
                        {i > 0 && (config.filters?.match === 'any' ? '或 · ' : '且 · ')}
                        {filterFields(object)[rule.field]?.label} {operatorLabels[rule.operator]}{' '}
                        {filterFields(object)[rule.field]?.options?.[rule.value] ||
                          (rule.field === 'owner'
                            ? rule.value === 'me'
                              ? '当前用户'
                              : person(rule.value)
                            : rule.value)}
                        <X size={11} />
                      </button>
                    ))}
                    {config.type && (
                      <button onClick={() => change({ type: '' })}>
                        类型：{types[config.type]}
                        <X size={11} />
                      </button>
                    )}
                    {config.status && (
                      <button onClick={() => change({ status: '' })}>
                        {states[config.status]}
                        <X size={11} />
                      </button>
                    )}
                    {config.owner && (
                      <button onClick={() => change({ owner: '' })}>
                        负责人：
                        {config.owner === 'me'
                          ? '我'
                          : config.owner === 'unassigned'
                            ? '未分配'
                            : person(config.owner)}
                        <X size={11} />
                      </button>
                    )}
                    {config.source && (
                      <button onClick={() => change({ source: '' })}>
                        {sources[config.source as keyof typeof sources]}
                        <X size={11} />
                      </button>
                    )}
                    {config.region && (
                      <button onClick={() => change({ region: '' })}>
                        地区包含：{config.region}
                        <X size={11} />
                      </button>
                    )}
                    {config.archived && (
                      <button onClick={() => change({ archived: false })}>
                        <Archive size={12} />
                        已归档
                        <X size={11} />
                      </button>
                    )}
                  </div>
                )}
                {error && (
                  <div className="error" role="alert">
                    {error}
                    <button onClick={reload}>重新加载</button>
                  </div>
                )}
                {attributeValues.error && object === 'customers' && !activeListId && (
                  <div className="error" role="alert">
                    属性读取失败：{attributeValues.error}
                    <button onClick={() => setAttributeRevision((n) => n + 1)}>重新读取</button>
                  </div>
                )}
                {attributeGeneration.busy && (
                  <div className="attribute-generation-bar" role="status">
                    <Sparkles size={13} />
                    <span>
                      AI 填充中 · 已填入{' '}
                      {
                        Object.values(attributeGeneration.jobs).filter((j) => j.status === 'saved')
                          .length
                      }{' '}
                      项
                    </span>
                    <button onClick={attributeGeneration.stop}>停止后续生成</button>
                  </div>
                )}
                {checked.length > 0 && (
                  <div className="bulk-actions">
                    <span>已选 {checked.length} 条</span>
                    {object === 'customers' &&
                      !activeListId &&
                      companyFields.some((f) => f.ai_enabled) && (
                        <Popover
                          label="AI 生成"
                          icon={<Sparkles size={13} />}
                          className="attribute-bulk-menu"
                        >
                          <p className="popover-caption">按属性指令生成选中公司的空值</p>
                          {companyFields
                            .filter((f) => f.ai_enabled)
                            .map((f) => (
                              <button
                                key={f.id}
                                className="menu-item"
                                disabled={
                                  !attributeStatus?.configured ||
                                  !attributeValues.ready ||
                                  attributeGeneration.busy
                                }
                                onClick={() =>
                                  openAttributeGeneration(
                                    f,
                                    items.filter((r) => checked.includes(r.id)),
                                  )
                                }
                              >
                                <Sparkles size={13} />
                                {f.name}
                              </button>
                            ))}
                        </Popover>
                      )}
                    <Popover label="添加到清单" icon={<Plus size={13} />}>
                      <p className="popover-caption">加入已有清单</p>
                      {recordLists
                        .filter((l) => l.object === object)
                        .map((l) => (
                          <button
                            className="menu-item"
                            disabled={listBusy}
                            key={l.id}
                            onClick={() => void addChecked(l.id)}
                          >
                            {l.name}
                          </button>
                        ))}
                      <button
                        className="menu-item"
                        onClick={() => {
                          closeMenus();
                          setListName('');
                          setListObject(object);
                          setListError('');
                          setListDialog('new');
                        }}
                      >
                        新建清单并加入
                      </button>
                    </Popover>
                    <button className="text-button" onClick={() => setChecked([])}>
                      取消选择
                    </button>
                  </div>
                )}
                <div ref={tableRef} className="workspace-body" aria-busy={loading}>
                  {loading ? (
                    <div className="table-loading" role="status">
                      正在加载{objectNames[object]}…
                    </div>
                  ) : error ? null : !items.length ? (
                    <div className="empty">
                      <Search size={24} />
                      <h3>
                        {activeFilterCount || config.query
                          ? '没有符合条件的记录'
                          : `还没有${objectNames[object]}`}
                      </h3>
                      <p>
                        {activeFilterCount || config.query
                          ? '调整筛选或搜索词，已保存的资料不会被删除。'
                          : '新建记录，或将已有记录加入当前清单。'}
                      </p>
                      {(activeFilterCount > 0 || config.query) && (
                        <button
                          onClick={() =>
                            change({
                              query: '',
                              type: '',
                              status: '',
                              source: '',
                              region: '',
                              owner: '',
                              archived: false,
                              filters: { match: 'all', rules: [] },
                            })
                          }
                        >
                          清除全部筛选
                        </button>
                      )}
                    </div>
                  ) : config.layout === 'list' ? (
                    <ResizableTable
                      key={`${object}:${viewId || 'all'}`}
                      storageKey={`${preferenceKey}:records:${object}:${viewId || 'all'}`}
                      className="record-table"
                      columns={[
                        { id: '_select', label: '选择', width: 36, fixed: true },
                        ...config.columns.map((id) => ({
                          id,
                          label: columns[id],
                          width:
                            id === 'name'
                              ? 230
                              : id === 'email'
                                ? 280
                                : id === 'customer_name'
                                  ? 230
                                  : id === 'id'
                                    ? 280
                                    : 160,
                        })),
                        { id: '_add', label: '添加字段', width: 145, fixed: true },
                      ]}
                    >
                      <thead>
                        <tr>
                          <th className="row-number">
                            <input
                              type="checkbox"
                              aria-label="选择当前页全部记录"
                              checked={!!items.length && items.every((r) => checked.includes(r.id))}
                              onChange={(e) =>
                                setChecked(e.target.checked ? items.map((r) => r.id) : [])
                              }
                            />
                          </th>
                          {config.columns.map((k) => (
                            <th
                              key={k}
                              draggable={k !== 'name'}
                              onDragStart={() => {
                                draggedColumn.current = k;
                              }}
                              onDragEnd={() => {
                                draggedColumn.current = null;
                              }}
                              onDragOver={(e) => {
                                if (k !== 'name' && draggedColumn.current) e.preventDefault();
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                const source = draggedColumn.current;
                                if (source && source !== k && k !== 'name') {
                                  const next = config.columns.filter((c) => c !== source);
                                  next.splice(next.indexOf(k), 0, source);
                                  change({ columns: next });
                                }
                                draggedColumn.current = null;
                              }}
                            >
                              <div className="attribute-column-heading">
                                {object === 'customers' &&
                                  companyFields.some(
                                    (f) => f.ai_enabled && attributeColumn(f.id) === k,
                                  ) && (
                                    <button
                                      type="button"
                                      className="attribute-star attribute-column-star"
                                      aria-label={`AI生成${columns[k]}（已选${checked.length}家）`}
                                      title={
                                        checked.length
                                          ? `为选中的 ${checked.length} 家公司生成${columns[k]}`
                                          : 'AI 填充属性 · 先勾选公司，再点星星批量生成'
                                      }
                                      disabled={
                                        !checked.length ||
                                        !attributeStatus?.configured ||
                                        !attributeValues.ready ||
                                        attributeGeneration.busy
                                      }
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const f = companyFields.find(
                                          (f) => attributeColumn(f.id) === k,
                                        )!;
                                        openAttributeGeneration(
                                          f,
                                          items.filter((r) => checked.includes(r.id)),
                                        );
                                      }}
                                    >
                                      <Sparkles size={13} />
                                    </button>
                                  )}
                                <Popover label={columns[k]}>
                                  {object === 'customers' && k.startsWith('attr:') && admin && (
                                    <button
                                      className="menu-item"
                                      onClick={() => {
                                        setEditingAttribute(
                                          companyFields.find((f) => attributeColumn(f.id) === k) ||
                                            null,
                                        );
                                        closeMenus();
                                      }}
                                    >
                                      编辑属性 / AI 指令
                                    </button>
                                  )}
                                  {Object.hasOwn(sorts, k) && (
                                    <>
                                      <button
                                        className="menu-item"
                                        onClick={() => {
                                          change({ sort: k, direction: 'asc' });
                                          closeMenus();
                                        }}
                                      >
                                        按此列升序
                                      </button>
                                      <button
                                        className="menu-item"
                                        onClick={() => {
                                          change({ sort: k, direction: 'desc' });
                                          closeMenus();
                                        }}
                                      >
                                        按此列降序
                                      </button>
                                    </>
                                  )}
                                  {filterFields(object)[k] && (
                                    <button
                                      className="menu-item"
                                      onClick={() => {
                                        const f = filterFields(object)[k];
                                        change({
                                          filters: {
                                            match: config.filters?.match || 'all',
                                            rules: [
                                              ...(config.filters?.rules || []),
                                              {
                                                field: k,
                                                operator: f.kind === 'text' ? 'contains' : 'is',
                                                value:
                                                  f.kind === 'member'
                                                    ? 'me'
                                                    : f.kind === 'date'
                                                      ? new Date().toISOString().slice(0, 10)
                                                      : Object.keys(f.options || {})[0] || '',
                                              },
                                            ],
                                          },
                                        });
                                        closeMenus();
                                        document
                                          .querySelector<HTMLDetailsElement>('.filter-popover')
                                          ?.setAttribute('open', '');
                                      }}
                                    >
                                      筛选此属性
                                    </button>
                                  )}
                                  {k !== 'name' && (
                                    <button
                                      className="menu-item"
                                      onClick={() => {
                                        change({ columns: config.columns.filter((c) => c !== k) });
                                        closeMenus();
                                      }}
                                    >
                                      隐藏此列
                                    </button>
                                  )}
                                  <p className="popover-caption">
                                    {k === 'name' ? '名称固定在首列' : '拖动表头调整列位置'}
                                  </p>
                                </Popover>
                              </div>
                              <ColumnResizeHandle columnId={k} />
                            </th>
                          ))}
                          <th className="add-column-header">
                            <Popover
                              label="添加字段"
                              icon={<Plus size={13} />}
                              className="add-column-popover"
                            >
                              <input
                                aria-label="搜索可添加属性"
                                placeholder="Search attributes…"
                                value={columnQuery}
                                onChange={(e) => setColumnQuery(e.target.value)}
                              />
                              {object === 'customers' && admin && (
                                <button
                                  className="menu-item"
                                  onClick={() => {
                                    setCreatingAttribute(true);
                                    closeMenus();
                                  }}
                                >
                                  <Plus size={13} />
                                  创建新的属性
                                </button>
                              )}
                              {Object.entries(columns)
                                .filter(
                                  ([k, label]) =>
                                    !config.columns.includes(k) &&
                                    label.toLowerCase().includes(columnQuery.toLowerCase()),
                                )
                                .map(([k, label]) => (
                                  <button
                                    className="menu-item"
                                    key={k}
                                    onClick={() => {
                                      change({ columns: [...config.columns, k] });
                                      setColumnQuery('');
                                      closeMenus();
                                    }}
                                  >
                                    <Plus size={13} />
                                    {label}
                                  </button>
                                ))}
                              {Object.keys(columns).every((k) => config.columns.includes(k)) && (
                                <p className="popover-caption">全部属性已显示</p>
                              )}
                            </Popover>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((row) => (
                          <tr
                            key={row.id}
                            className={
                              selected &&
                              (isPerson(row)
                                ? selected.personId === row.id
                                : isProject(row)
                                  ? selected.projectId === row.id
                                  : selected.customerId === row.id)
                                ? 'selected'
                                : ''
                            }
                            onClick={() => onSelect(selectionFor(row))}
                          >
                            <td className="row-number" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label={`选择${row.name}`}
                                checked={checked.includes(row.id)}
                                onChange={(e) =>
                                  setChecked((prev) =>
                                    e.target.checked
                                      ? [...prev, row.id]
                                      : prev.filter((id) => id !== row.id),
                                  )
                                }
                              />
                            </td>
                            {config.columns.map((k) => (
                              <ExpandableCell key={k} label={columns[k]} className={`cell-${k}`}>
                                {cell(row, k)}
                              </ExpandableCell>
                            ))}
                            <td className="table-spacer" />
                          </tr>
                        ))}
                      </tbody>
                    </ResizableTable>
                  ) : (
                    <KanbanBoard aria-label={`${objectLabels[object]}卡片`}>
                      {items.map((row) => (
                        <KanbanCard key={row.id}>
                          <button
                            className="kanban-card-title"
                            title={row.name}
                            onClick={() => onSelect(selectionFor(row))}
                          >
                            <span className="kanban-card-identity">
                              {isPerson(row) ? (
                                <UserRound size={15} />
                              ) : isProject(row) ? (
                                <Folder size={15} />
                              ) : (
                                <Building2 size={15} />
                              )}
                            </span>
                            <span className="kanban-card-name">{row.name}</span>
                            <PanelRight className="kanban-card-preview" size={13} />
                          </button>
                          <div className="kanban-card-fields">
                            {boardDisplay.fields
                              .filter((key) => Object.hasOwn(columns, key))
                              .map((key) => {
                                const field =
                                  object === 'customers'
                                    ? companyFields.find(
                                        (field) => attributeColumn(field.id) === key,
                                      )
                                    : undefined;
                                const value = field
                                  ? attributeValues.values.find(
                                      (value) =>
                                        value.customer_id === row.id &&
                                        value.attribute_id === field.id,
                                    )?.value
                                  : key === 'owner'
                                    ? row.owner_id
                                    : key === 'contact' && !isProject(row) && !isPerson(row)
                                      ? row.contact_name
                                      : key === 'project_count' && !isProject(row) && !isPerson(row)
                                        ? (row.project_count ?? 0)
                                        : key === 'email_count' && !isProject(row)
                                          ? (row.email_count ?? 0)
                                          : row[key as keyof RecordRow];
                                return (
                                  <RecordCardField
                                    key={key}
                                    fieldId={key}
                                    label={columns[key]}
                                    kind={field?.kind}
                                    value={value}
                                  >
                                    {cell(row, key)}
                                  </RecordCardField>
                                );
                              })}
                          </div>
                          {!isPerson(row) && (
                            <footer className="kanban-card-footer">
                              <span>{object === 'customers' ? '合作状态' : '项目阶段'}</span>
                              {row.can_edit && !config.archived ? (
                                <select
                                  aria-label={`更新${row.name}的${object === 'customers' ? '状态' : '阶段'}`}
                                  value={stateOf(row)}
                                  disabled={loading || moving}
                                  onChange={(e) => void move(row, e.target.value)}
                                >
                                  {Object.entries(states).map(([key, label]) => (
                                    <option key={key} value={key}>
                                      {label}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span>{states[stateOf(row)]}</span>
                              )}
                            </footer>
                          )}
                        </KanbanCard>
                      ))}
                    </KanbanBoard>
                  )}
                </div>
                <footer className="table-footer">
                  <span>
                    {loading
                      ? '加载中…'
                      : `共 ${list?.total ?? '—'} 项 · 当前页 ${items.length} 项`}
                    {config.layout === 'board' && (
                      <span className="footer-detail"> · 卡片显示当前页</span>
                    )}
                  </span>
                  <div>
                    <span>
                      {page} / {totalPages}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="上一页"
                      disabled={loading || page <= 1}
                      onClick={() => {
                        setPage(page - 1);
                        onSelect(null);
                      }}
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="下一页"
                      disabled={loading || page >= totalPages}
                      onClick={() => {
                        setPage(page + 1);
                        onSelect(null);
                      }}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </footer>
              </>
            )}
          </main>
          {selected && (
            <CustomerDrawer
              askButton={!selected.full ? askButton : undefined}
              askPanel={askPanel}
              selection={selected}
              onSelect={onSelect}
              previous={
                selectedIndex > 0
                  ? () => onSelect(selectionFor(order[selectedIndex - 1], selected.full))
                  : undefined
              }
              next={
                selectedIndex >= 0 && selectedIndex < order.length - 1
                  ? () => onSelect(selectionFor(order[selectedIndex + 1], selected.full))
                  : undefined
              }
            >
              {props.renderDetail(selected)}
            </CustomerDrawer>
          )}
        </div>
      </div>
      {!selected && askPanel}
      {creatingPerson && (
        <PersonForm
          workspace={workspace.id}
          onClose={() => setCreatingPerson(false)}
          onSaved={(p) => {
            setCreatingPerson(false);
            notify('联系人已创建');
            onSelect({ customerId: p.customer_id, personId: p.id, full: true });
          }}
        />
      )}
      {listDialog && (
        <Dialog
          title={
            listDialog === 'new'
              ? '创建清单'
              : listDialog === 'rename'
                ? '重命名清单'
                : `添加到清单 · ${activeList?.name || '清单'}`
          }
          onClose={() => {
            if (!listBusy) setListDialog(null);
          }}
          className="record-list-dialog"
        >
          {listDialog === 'add' && activeList ? (
            <ListRecordPicker
              list={activeList}
              workspace={workspace.id}
              onClose={() => setListDialog(null)}
              onDone={() => {
                setListDialog(null);
                notify('记录已加入清单');
              }}
            />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveList();
              }}
            >
              <div className="dialog-fields">
                <label>
                  清单名称
                  <input
                    autoFocus
                    aria-label="清单名称"
                    value={listName}
                    onChange={(e) => setListName(e.target.value)}
                    maxLength={80}
                    required
                    placeholder="例如：本月重点跟进"
                  />
                </label>
                {listDialog === 'new' && (
                  <label>
                    记录类型
                    <select
                      aria-label="清单记录类型"
                      value={listObject}
                      onChange={(e) => setListObject(e.target.value as RecordObject)}
                    >
                      <option value="customers">公司与客户</option>
                      <option value="people">联系人</option>
                      <option value="projects">项目</option>
                    </select>
                  </label>
                )}
                <p>清单仅自己可见。加入记录后，可自由设置列、筛选和视图，不会改变客户权限。</p>
                {listError && (
                  <p className="error" role="alert">
                    {listError}
                  </p>
                )}
              </div>
              <footer className="form-footer">
                <button type="button" disabled={listBusy} onClick={() => setListDialog(null)}>
                  取消
                </button>
                <button className="primary" disabled={listBusy}>
                  {listBusy ? '保存中…' : listDialog === 'new' ? '创建清单' : '保存'}
                </button>
              </footer>
            </form>
          )}
        </Dialog>
      )}
      {(creatingAttribute || editingAttribute) && (
        <AttributeFieldDialog
          key={`${workspace.id}:${editingAttribute?.id || 'new'}`}
          workspace={workspace.id}
          field={editingAttribute || undefined}
          onClose={() => {
            setCreatingAttribute(false);
            setEditingAttribute(null);
          }}
          onSaved={(field) => {
            const created = creatingAttribute;
            setCreatingAttribute(false);
            setEditingAttribute(null);
            setAttributeRevision((n) => n + 1);
            if (created && config.columns.length < 20)
              change({ columns: [...config.columns, attributeColumn(field.id)] });
            notify(created ? '公司属性已创建' : '公司属性已保存');
          }}
        />
      )}
      {searchOpen && (
        <QuickSearch
          workspace={workspace.id}
          onClose={() => setSearchOpen(false)}
          onSelect={onSelect}
        />
      )}
      {pending && (
        <Dialog
          title={
            externalProspectDirty || section === 'prospects'
              ? '咨询有未保存的修改'
              : section === 'mail'
                ? '收信设置尚未保存'
                : '当前视图有未保存的更改'
          }
          onClose={() => setPending(null)}
        >
          <p className="dialog-copy">
            {externalProspectDirty || section === 'prospects'
              ? '切换后将放弃本次未保存的咨询与页面输入，已经保存的客户档案和咨询记录保留。'
              : section === 'mail'
                ? '切换后将放弃本次收信设置修改，已保存的设置继续生效。'
                : '切换后将放弃当前筛选、排序和显示设置。已保存的视图和业务记录不会改变。'}
          </p>
          <footer className="form-footer">
            <button onClick={() => setPending(null)}>继续编辑</button>
            <button
              disabled={(section === 'prospects' && prospectBusy) || externalProspectBusy}
              onClick={() => {
                if ((section === 'prospects' && prospectBusy) || externalProspectBusy) return;
                const action = pending;
                setPending(null);
                action();
              }}
            >
              放弃更改并继续
            </button>
          </footer>
        </Dialog>
      )}
      {creatingTable && admin && (
        <CreateObjectDialog
          key={`${workspace.id}:${session.actor.id}`}
          workspace={workspace.id}
          presentation="table"
          onClose={() => setCreatingTable(false)}
          onCreated={(object) => {
            setCustomObjects((current) => [...current.filter((o) => o.id !== object.id), object]);
            setCreatedLibraryObject({ workspace: workspace.id, id: object.id });
            setCreatingTable(false);
            openCustom(object);
            notify(`已创建“${object.name}”表格`);
          }}
        />
      )}
      <NoteEditorHost
        key={`${workspace.id}:${session.actor.id}`}
        workspace={workspace.id}
        actorId={session.actor.id}
      />
      {preferencesOpen && (
        <UserPreferences
          key={workspace.id}
          workspace={workspace.id}
          workspaceName={workspace.name}
          admin={admin}
          authMode={session.auth_mode}
          onTeamChanged={props.reload}
          onClose={() => setPreferencesOpen(false)}
          onOpenChat={(id) => {
            setPreferencesOpen(false);
            openHome(id);
          }}
        />
      )}
      {saveDialog && (
        <Dialog
          title={
            saveDialog === 'delete'
              ? '删除个人视图'
              : saveDialog === 'rename'
                ? '重命名视图'
                : '保存为个人视图'
          }
          onClose={() => {
            if (!saving) setSaveDialog(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (saveDialog === 'delete') void deleteView();
              else void save(saveDialog);
            }}
          >
            {saveDialog === 'delete' ? (
              <p className="dialog-copy">
                删除“{viewTitle}”的筛选和显示配置？客户、项目及记录都会保留。
              </p>
            ) : (
              <div className="dialog-fields">
                <label>
                  视图名称
                  <input
                    aria-label="视图名称"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={saving}
                  />
                </label>
                <p>仅自己可见，保存当前筛选、排序、列顺序和显示方式。</p>
              </div>
            )}
            {saveError && (
              <p className="error dialog-error" role="alert">
                {saveError}
              </p>
            )}
            <footer className="form-footer">
              <button type="button" disabled={saving} onClick={() => setSaveDialog(null)}>
                取消
              </button>
              <button className="primary" disabled={saving}>
                {saving ? '处理中…' : saveDialog === 'delete' ? '删除视图' : '保存'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </div>
  );
}
