import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Download, FileText, FolderOpen, RefreshCw, Search, Sparkles, Upload } from 'lucide-react';
import { api } from './api';
import { Dialog } from './WorkspaceUI';
import { ProspectSourceButton } from './ProspectSourceButton';
import { WorkspacePageHeader, WorkspacePageTabs } from './WorkspacePage';
import { formatAttributeValue, isEmptyAttributeValue } from '../shared/attributes';
import type { Customer, Project } from '../shared/domain';
import type { CustomerList } from '../shared/views';
import {
  documentLimits,
  type DocumentAnswer,
  type DocumentAttributeFields,
  type DocumentAttributeResult,
  type DocumentDetail,
  type DocumentFile,
  type DocumentView,
} from '../shared/documents';
import type { Selection } from './Workbench';
import './documents.css';

type NamedScope = { id: string; name: string };
type ScopeProps = { workspace: string; customer?: NamedScope; project?: NamedScope };
const documentsChangedEvent = 'typha:documents-changed';
function documentsChanged(workspace: string) {
  window.dispatchEvent(new CustomEvent(documentsChangedEvent, { detail: { workspace } }));
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
const fileSize = (size: number) =>
  size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;
const fileTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
const statusLabels: Record<DocumentFile['status'], string> = {
  queued: '等待处理',
  processing: '提取文字中',
  pending_association: '待关联',
  ready: '文字已提取',
  failed: '处理失败',
};
const knowledgeLabels: Record<DocumentFile['knowledge_state'], string> = {
  not_associated: '仅本人可见，未进入客户知识',
  queued: '知识索引处理中',
  ready: '知识可检索',
  unavailable: '知识索引未就绪',
};
const stillProcessing = (file: DocumentFile) =>
  file.status === 'queued' ||
  file.status === 'processing' ||
  (file.status === 'ready' && file.knowledge_state === 'queued');

function FileStatus({ file }: { file: DocumentFile }) {
  return (
    <span className={`document-status status-${file.status}`}>{statusLabels[file.status]}</span>
  );
}

function ScopeFields({
  workspace,
  lockedCustomer,
  initialProject,
  customer,
  projectId,
  onCustomer,
  onProject,
  requireCustomer = false,
  disabled = false,
  lockProject = false,
}: {
  workspace: string;
  lockedCustomer?: NamedScope;
  initialProject?: NamedScope;
  customer: NamedScope | null;
  projectId: string;
  onCustomer: (value: NamedScope | null) => void;
  onProject: (value: string) => void;
  requireCustomer?: boolean;
  disabled?: boolean;
  lockProject?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const scopeId = useId();
  useEffect(() => {
    if (lockedCustomer) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      void api<CustomerList>(
        `/customers?editable=true&q=${encodeURIComponent(query)}&sort=name&direction=asc`,
        { workspace, signal: controller.signal },
      )
        .then((value) => {
          setCustomers(value.items);
          setLoading(false);
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(errorText(e));
            setCustomers([]);
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspace, query, lockedCustomer?.id]);
  useEffect(() => {
    const controller = new AbortController();
    setProjects([]);
    setError('');
    if (customer)
      void api<Project[]>(`/customers/${customer.id}/projects`, {
        workspace,
        signal: controller.signal,
      })
        .then((items) => setProjects(items.filter((item) => !item.archived_at)))
        .catch((e) => {
          if (!controller.signal.aborted) setError(errorText(e));
        });
    return () => controller.abort();
  }, [workspace, customer?.id]);
  return (
    <div className="document-scope-fields">
      <div className="document-field">
        <label id={`${scopeId}-label`} htmlFor={lockedCustomer ? undefined : `${scopeId}-company`}>
          保存到公司
        </label>
        {lockedCustomer ? (
          <div className="document-locked-scope" role="group" aria-labelledby={`${scopeId}-label`}>
            {lockedCustomer.name}
          </div>
        ) : (
          <>
            <input
              aria-label="搜索可保存的公司"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索公司名称"
              disabled={disabled}
            />
            <select
              id={`${scopeId}-company`}
              value={customer?.id || ''}
              disabled={disabled}
              onChange={(e) => {
                onCustomer(customers.find((item) => item.id === e.target.value) || null);
                onProject('');
              }}
            >
              <option value="">{requireCustomer ? '请选择公司' : '稍后关联（仅本人）'}</option>
              {customer && !customers.some((item) => item.id === customer.id) && (
                <option value={customer.id}>{customer.name}</option>
              )}
              {customers.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            {loading && <small role="status">正在查找公司…</small>}
          </>
        )}
      </div>
      {customer && (
        <div className="document-field">
          <label htmlFor={`${scopeId}-project`}>关联项目 · 可选</label>
          <select
            id={`${scopeId}-project`}
            value={projectId}
            disabled={disabled || lockProject}
            onChange={(e) => onProject(e.target.value)}
          >
            <option value="">不指定项目（公司资料）</option>
            {initialProject && !projects.some((item) => item.id === initialProject.id) && (
              <option value={initialProject.id}>{initialProject.name}</option>
            )}
            {projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <small>
            {lockProject
              ? '新版本沿用原文件的公司与项目。'
              : '仅关联本次文件；公司介绍可保存在公司层级。'}
          </small>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function useDocument(workspace: string, id: string) {
  const [cached, setCached] = useState<{
    workspace: string;
    id: string;
    file: DocumentDetail;
  } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setError('');
    async function load() {
      try {
        const next = await api<DocumentDetail>(`/documents/${id}`, {
          workspace,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setCached({ workspace, id, file: next });
        if (stillProcessing(next)) timer = setTimeout(() => void load(), 1500);
      } catch (e) {
        if (!controller.signal.aborted) {
          setCached(null);
          setError(errorText(e));
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspace, id, revision]);
  return {
    file: cached?.workspace === workspace && cached.id === id ? cached.file : null,
    error,
    reload: () => setRevision((value) => value + 1),
  };
}

async function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('读取文件失败，请重新选择'));
    reader.readAsDataURL(file);
  });
}

export function DocumentUploadButton({
  workspace,
  customer,
  project,
  onUploaded,
}: ScopeProps & { onUploaded?: (file: DocumentDetail) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        <Upload size={14} />
        上传文档
      </button>
      {open && (
        <DocumentUploadDialog
          workspace={workspace}
          customer={customer}
          project={project}
          onClose={() => setOpen(false)}
          onUploaded={onUploaded}
        />
      )}
    </>
  );
}

export function DocumentUploadDialog({
  workspace,
  customer: fixedCustomer,
  project,
  initialFile,
  supersedesId,
  onClose,
  onUploaded,
}: ScopeProps & {
  initialFile?: File;
  supersedesId?: string;
  onClose: () => void;
  onUploaded?: (file: DocumentDetail) => void;
}) {
  const [file, setFile] = useState<File | null>(initialFile || null);
  const [customer, setCustomer] = useState<NamedScope | null>(fixedCustomer || null);
  const [projectId, setProjectId] = useState(project?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const input = useRef<HTMLInputElement>(null);
  function choose(next: File | null) {
    setFile(next);
    setError('');
    requestId.current = crypto.randomUUID();
  }
  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    if (!/\.(pdf|docx)$/i.test(file.name)) {
      setError('支持文字版 PDF、DOCX；旧版 DOC 请另存为 DOCX');
      return;
    }
    if (file.size > documentLimits.bytes) {
      setError('文件超过 10 MB，请拆分后上传');
      return;
    }
    if (!file.size) {
      setError('文件为空，请重新选择');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const uploaded = await api<DocumentDetail>('/documents', {
        workspace,
        method: 'POST',
        body: {
          request_id: requestId.current,
          name: file.name,
          content_base64: await readBase64(file),
          customer_id: customer?.id || null,
          project_id: customer ? projectId || null : null,
          ...(supersedesId ? { supersedes_id: supersedesId } : {}),
        },
      });
      setUploadedId(uploaded.id);
      documentsChanged(workspace);
      onUploaded?.(uploaded);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (uploadedId)
    return <DocumentDetailDialog workspace={workspace} id={uploadedId} onClose={onClose} />;
  return (
    <Dialog
      title={supersedesId ? '上传新版本' : '上传文档'}
      className="document-upload-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="document-upload-body" onSubmit={(e) => void upload(e)}>
        <div
          className="document-dropzone"
          onDragOver={(e) => {
            if (!busy) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy) choose(e.dataTransfer.files[0] || null);
          }}
        >
          <FileText size={22} />
          {file ? (
            <>
              <strong>{file.name}</strong>
              <small>{fileSize(file.size)}</small>
            </>
          ) : (
            <>
              <strong>选择或拖入公司介绍文件</strong>
              <small>文字版 PDF、DOCX · 最多 10 MB、200 页</small>
            </>
          )}
          <input
            ref={input}
            hidden
            type="file"
            accept=".pdf,.docx"
            disabled={busy}
            onChange={(e) => {
              choose(e.target.files?.[0] || null);
              e.target.value = '';
            }}
          />
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>
            {file ? '更换文件' : '选择文件'}
          </button>
        </div>
        <ScopeFields
          workspace={workspace}
          lockedCustomer={fixedCustomer}
          initialProject={project}
          customer={customer}
          projectId={projectId}
          onCustomer={(value) => {
            setCustomer(value);
            requestId.current = crypto.randomUUID();
          }}
          onProject={(value) => {
            setProjectId(value);
            requestId.current = crypto.randomUUID();
          }}
          disabled={busy}
          lockProject={!!supersedesId}
        />
        <p className="document-helper">
          {customer
            ? '提取文字并归档到当前公司。已有属性不会自动更新。'
            : '先保存在仅本人可见的待关联区，不进入任何客户知识。'}
        </p>
        <p className="document-helper">图片内容与扫描件不进行识别；请提供可复制文字的文档。</p>
        {supersedesId && (
          <p className="document-helper">
            新版本单独保存，历史原件与引用保留；上传不自动否定旧事实或覆盖已有属性。
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer className="document-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={!file || busy}>
            {busy ? '上传中…' : customer ? '上传并整理' : '存入待关联区'}
          </button>
        </footer>
        {busy && <small role="status">正在保存原文件，请保持此窗口打开。</small>}
      </form>
    </Dialog>
  );
}

export function DocumentsWorkspace({
  workspace,
  customer,
  project,
  editable = true,
  refresh = 0,
  onSelect,
}: ScopeProps & {
  editable?: boolean;
  refresh?: number;
  onSelect?: (selection: Selection) => void;
}) {
  const [view, setView] = useState<DocumentView>('all');
  const [files, setFiles] = useState<DocumentFile[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ workspace: string }>).detail?.workspace === workspace)
        setRevision((value) => value + 1);
    };
    window.addEventListener(documentsChangedEvent, changed);
    return () => window.removeEventListener(documentsChangedEvent, changed);
  }, [workspace]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setFiles(null);
    setError('');
    async function load() {
      const params = new URLSearchParams({ view });
      if (customer) params.set('customer_id', customer.id);
      if (project) params.set('project_id', project.id);
      try {
        const result = await api<{ files: DocumentFile[] }>(`/documents?${params}`, {
          workspace,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setFiles(
          project
            ? result.files.filter((item) => item.project_id === project.id || !item.project_id)
            : result.files,
        );
        if (result.files.some(stillProcessing)) timer = setTimeout(() => void load(), 2000);
      } catch (e) {
        if (!controller.signal.aborted) {
          setFiles(null);
          setError(errorText(e));
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspace, customer?.id, project?.id, view, revision, refresh]);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  function list(items: DocumentFile[]) {
    return items.length ? (
      <div className="document-list">
        {items.map((file) => (
          <div className="document-row" key={file.id}>
            <FileText size={17} />
            <div className="document-row-main">
              <button className="document-name" onClick={() => setSelectedId(file.id)}>
                {file.name}
              </button>
              <small>
                V{file.edition || 1} · {file.customer_name || '仅本人 · 待关联'} ·{' '}
                {file.project_name || (file.customer_id ? '公司资料' : '未进入客户知识')} ·{' '}
                {fileSize(file.size)} · {fileTime(file.created_at)}
              </small>
              {file.status === 'failed' && (
                <p className="document-row-error">{file.error || '处理失败，原文件已保留'}</p>
              )}
            </div>
            <div className="document-row-state">
              <FileStatus file={file} />
              {file.status === 'ready' && <small>{knowledgeLabels[file.knowledge_state]}</small>}
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div className="document-empty">
        {view === 'failed'
          ? '暂无失败文件'
          : view === 'processing'
            ? '暂无处理中的文件'
            : view === 'pending'
              ? '暂无本人待关联文件'
              : '暂无文件，可上传公司介绍或项目文档。'}
      </div>
    );
  }
  const headingDescription = project
    ? '本项目资料与公司层级背景'
    : customer
      ? '原文件、提取文字与整理状态'
      : '查找已上传文件与仅本人可见的待关联资料';
  const headingActions = (
    <div className="document-actions">
      <button className="icon-button" aria-label="刷新文件列表" onClick={changed}>
        <RefreshCw size={15} />
      </button>
      {editable && (
        <button className={customer ? undefined : 'primary'} onClick={() => setUploading(true)}>
          <Upload size={14} />
          上传文档
        </button>
      )}
    </div>
  );
  const viewTabs = (
    Object.entries({
      all: '全部',
      ...(!customer ? { pending: '本人待关联' } : {}),
      processing: '处理中',
      failed: '失败',
    }) as [DocumentView, string][]
  ).map(([key, label]) => (
    <button
      key={key}
      className={view === key ? 'current' : ''}
      role={customer ? undefined : 'tab'}
      aria-selected={customer ? undefined : view === key}
      aria-pressed={customer ? view === key : undefined}
      onClick={() => setView(key)}
    >
      {label}
    </button>
  ));
  return (
    <section
      className={`documents-workspace ${customer ? 'is-scoped' : 'is-global workspace-page'}`}
      aria-label={customer ? '公司文件' : '文件目录'}
    >
      {customer ? (
        <header className="documents-heading">
          <div>
            <h1>{project ? '项目文件' : '文件'}</h1>
            <p>{headingDescription}</p>
          </div>
          {headingActions}
        </header>
      ) : (
        <WorkspacePageHeader
          title="文件"
          description={headingDescription}
          actions={headingActions}
        />
      )}
      {customer ? (
        <div className="document-views" aria-label="文件筛选">
          {viewTabs}
        </div>
      ) : (
        <WorkspacePageTabs label="文件筛选">{viewTabs}</WorkspacePageTabs>
      )}
      {error ? (
        <div className="error" role="alert">
          {error}
          <button onClick={changed}>重新加载</button>
        </div>
      ) : !files ? (
        <div className="document-empty" role="status">
          正在加载文件…
        </div>
      ) : project && view === 'all' ? (
        <>
          <h2 className="document-group-heading">本项目文件</h2>
          {list(files.filter((file) => file.project_id === project.id))}
          <h2 className="document-group-heading">公司背景文件</h2>
          {list(files.filter((file) => !file.project_id))}
        </>
      ) : (
        list(files)
      )}
      {uploading && (
        <DocumentUploadDialog
          workspace={workspace}
          customer={customer}
          project={project}
          onClose={() => {
            setUploading(false);
            changed();
          }}
          onUploaded={changed}
        />
      )}
      {selectedId && (
        <DocumentDetailDialog
          key={selectedId}
          workspace={workspace}
          id={selectedId}
          onClose={() => {
            setSelectedId(null);
            changed();
          }}
          onChanged={changed}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}

function AssociateDocument({
  workspace,
  file,
  onClose,
  onSaved,
}: {
  workspace: string;
  file: DocumentDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [customer, setCustomer] = useState<NamedScope | null>(null);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!customer || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/documents/${file.id}/associate`, {
        workspace,
        method: 'POST',
        body: { customer_id: customer.id, project_id: projectId || null, version: file.version },
      });
      documentsChanged(workspace);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="document-associate" onSubmit={(e) => void save(e)}>
      <h3>关联到公司</h3>
      <ScopeFields
        workspace={workspace}
        customer={customer}
        projectId={projectId}
        onCustomer={setCustomer}
        onProject={setProjectId}
        disabled={busy}
        requireCustomer
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="document-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary" disabled={!customer || busy}>
          {busy ? '正在关联…' : '关联并整理'}
        </button>
      </div>
    </form>
  );
}

export function DocumentDetailDialog({
  workspace,
  id,
  onClose,
  onChanged,
  onSelect,
}: {
  workspace: string;
  id: string;
  onClose: () => void;
  onChanged?: () => void;
  onSelect?: (selection: Selection) => void;
}) {
  const { file, error: loadError, reload } = useDocument(workspace, id);
  const [tab, setTab] = useState<'original' | 'attributes' | 'ask'>('original');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [uploadingVersion, setUploadingVersion] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<DocumentFile[] | null>(null);
  const [versionsError, setVersionsError] = useState('');
  const [versionsRevision, setVersionsRevision] = useState(0);
  const [historyId, setHistoryId] = useState<string | null>(null);
  useEffect(() => {
    if (!versionsOpen) return;
    const controller = new AbortController();
    setVersions(null);
    setVersionsError('');
    void api<{ files: DocumentFile[] }>(`/documents/${id}/versions`, {
      workspace,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setVersions(result.files);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setVersionsError(errorText(e));
      });
    return () => controller.abort();
  }, [workspace, id, versionsOpen, versionsRevision]);
  async function download() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const original = await api<{ name: string; mime: string; content_base64: string }>(
        `/documents/${id}/original`,
        { workspace },
      );
      const content = atob(original.content_base64);
      const bytes = Uint8Array.from(content, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: original.mime }));
      const link = document.createElement('a');
      link.href = url;
      link.download = original.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/documents/${id}/retry`, {
        workspace,
        method: 'POST',
        body: { version: file.version },
      });
      documentsChanged(workspace);
      reload();
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog title={file?.name || '文件详情'} className="document-detail-dialog" onClose={onClose}>
        <div className="document-detail-body">
          {loadError && (
            <div className="error" role="alert">
              {loadError}
              <button onClick={reload}>重试加载</button>
            </div>
          )}
          {!file && !loadError && (
            <div className="document-empty" role="status">
              正在加载文件…
            </div>
          )}
          {file && (
            <>
              <div className="document-detail-meta">
                <FileStatus file={file} />
                <span>文件版本 V{file.edition || 1}</span>
                <span>
                  {file.format.toUpperCase()} · {fileSize(file.size)} · {fileTime(file.created_at)}
                </span>
                <button type="button" disabled={busy} onClick={() => void download()}>
                  <Download size={13} />
                  下载原文件
                </button>
              </div>
              <div className="document-detail-scope">
                <FolderOpen size={14} />
                <span>
                  {file.customer_name || '仅本人可见 · 待关联'}
                  {file.customer_id && ` / ${file.project_name || '公司资料（不指定项目）'}`}
                </span>
                {file.customer_id && file.record_id && file.status === 'ready' && (
                  <ProspectSourceButton
                    workspace={workspace}
                    customerId={file.customer_id}
                    sourceRecordIds={[file.record_id]}
                    sourceKind="document"
                    sourceId={file.id}
                    disabled={busy}
                  />
                )}
                {onSelect && file.customer_id && (
                  <button
                    className="text-button"
                    onClick={() => {
                      onSelect({ customerId: file.customer_id!, full: true, customerTab: 'files' });
                      onClose();
                    }}
                  >
                    打开公司文件
                  </button>
                )}
              </div>
              <p className="document-helper">来源：对方提供的文档 · 文件陈述不代表本公司确认</p>
              <p className="document-knowledge" role="status">
                {file.customer_id && file.status !== 'ready'
                  ? '文字提取完成后，再整理客户知识'
                  : knowledgeLabels[file.knowledge_state]}
                {file.customer_id ? ' · 上传未自动改写属性' : ''}
              </p>
              {file.warnings.map((warning, index) => (
                <p className="document-warning" key={index}>
                  {warning}
                </p>
              ))}
              {file.error && (
                <div className="error" role="alert">
                  {file.error}
                </div>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {file.can_edit && (
                <div className="document-actions document-detail-actions">
                  {file.customer_id && file.status === 'ready' && (
                    <button onClick={() => setUploadingVersion(true)}>
                      <Upload size={13} />
                      上传新版本
                    </button>
                  )}
                  {!file.customer_id && !associating && (
                    <button
                      disabled={file.status !== 'pending_association'}
                      onClick={() => setAssociating(true)}
                    >
                      关联公司
                    </button>
                  )}
                  {file.status === 'failed' && (
                    <button disabled={busy} onClick={() => void retry()}>
                      <RefreshCw size={13} />
                      {busy ? '正在重试…' : '重试处理'}
                    </button>
                  )}
                </div>
              )}
              {associating && (
                <AssociateDocument
                  workspace={workspace}
                  file={file}
                  onClose={() => setAssociating(false)}
                  onSaved={() => {
                    setAssociating(false);
                    reload();
                    onChanged?.();
                  }}
                />
              )}
              <details
                className="document-versions"
                onToggle={(e) => setVersionsOpen(e.currentTarget.open)}
              >
                <summary>查看文件历史版本</summary>
                {versionsOpen && (
                  <div className="document-version-list">
                    {versionsError ? (
                      <p className="error" role="alert">
                        {versionsError}
                        <button onClick={() => setVersionsRevision((value) => value + 1)}>
                          重试
                        </button>
                      </p>
                    ) : !versions ? (
                      <small role="status">正在加载历史版本…</small>
                    ) : (
                      versions.map((version) => (
                        <div key={version.id}>
                          <button
                            disabled={version.id === id}
                            onClick={() => setHistoryId(version.id)}
                          >
                            V{version.edition || 1} · {version.name}
                            {version.id === id ? '（当前查看）' : ''}
                          </button>
                          <small>
                            {fileTime(version.created_at)} · {statusLabels[version.status]}
                          </small>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </details>
              <div className="document-tabs" aria-label="文件内容">
                <button
                  className={tab === 'original' ? 'current' : ''}
                  onClick={() => setTab('original')}
                >
                  原文与依据
                </button>
                {file.customer_id && file.status === 'ready' && (
                  <>
                    <button
                      className={tab === 'ask' ? 'current' : ''}
                      onClick={() => setTab('ask')}
                    >
                      <Search size={13} />
                      询问此文档
                    </button>
                    {file.can_edit && (
                      <button
                        className={tab === 'attributes' ? 'current' : ''}
                        onClick={() => setTab('attributes')}
                      >
                        <Sparkles size={13} />
                        整理已有属性
                      </button>
                    )}
                  </>
                )}
              </div>
              {tab === 'original' && (
                <div className="document-original">
                  {file.sections.length ? (
                    file.sections.map((section, index) => (
                      <article key={index}>
                        <h3>{section.label}</h3>
                        <p>{section.text}</p>
                      </article>
                    ))
                  ) : (
                    <p className="document-empty">
                      {file.status === 'failed'
                        ? '尚未提取到可用文字。原文件已保留，可下载核对。'
                        : '正在提取文档文字，上传后可关闭窗口，稍后从文件页找回。'}
                    </p>
                  )}
                </div>
              )}
              {tab === 'attributes' && file.customer_id && (
                <DocumentAttributes workspace={workspace} file={file} onSaved={onChanged} />
              )}
              {tab === 'ask' && file.customer_id && (
                <DocumentQuestion workspace={workspace} file={file} />
              )}
            </>
          )}
        </div>
      </Dialog>
      {uploadingVersion && file?.customer_id && file.can_edit && file.status === 'ready' && (
        <DocumentUploadDialog
          workspace={workspace}
          customer={{ id: file.customer_id, name: file.customer_name || '当前公司' }}
          project={
            file.project_id
              ? { id: file.project_id, name: file.project_name || '当前项目' }
              : undefined
          }
          supersedesId={file.id}
          onClose={() => {
            setUploadingVersion(false);
            setVersionsRevision((value) => value + 1);
            reload();
            onChanged?.();
          }}
          onUploaded={() => {
            setVersionsRevision((value) => value + 1);
            onChanged?.();
          }}
        />
      )}
      {historyId && (
        <DocumentDetailDialog
          key={historyId}
          workspace={workspace}
          id={historyId}
          onClose={() => setHistoryId(null)}
          onSelect={onSelect}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

function DocumentAttributes({
  workspace,
  file,
  onSaved,
}: {
  workspace: string;
  file: DocumentDetail;
  onSaved?: () => void;
}) {
  const [fields, setFields] = useState<DocumentAttributeFields['fields'] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<DocumentAttributeResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<DocumentAttributeFields>(`/documents/${file.id}/attributes`, {
      workspace,
      signal: controller.signal,
    })
      .then((value) => {
        const allowed = value.fields.filter((field) => field.ai_enabled && !field.archived);
        setFields(allowed);
        setSelected(
          allowed
            .filter((field) => field.guidance.trim() && isEmptyAttributeValue(field.current_value))
            .slice(0, 10)
            .map((field) => field.id),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [workspace, file.id]);
  async function organize() {
    if (busy || !selected.length) return;
    setBusy(true);
    setError('');
    try {
      const value = await api<DocumentAttributeResult>(`/documents/${file.id}/attributes`, {
        workspace,
        method: 'POST',
        body: { attribute_ids: selected },
      });
      setResult(value);
      setSelected([]);
      setFields(
        (current) =>
          current?.map((field) => {
            const outcome = value.results.find((item) => item.attribute_id === field.id);
            return outcome && ['filled', 'preserved'].includes(outcome.status)
              ? { ...field, current_value: outcome.value }
              : field;
          }) || null,
      );
      onSaved?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="document-attributes">
      <p className="document-helper">
        只填写所选的已有空 AI 属性，每次最多 10 项；人工值与已有 AI 值均保留，不创建字段。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!fields && !error && <p role="status">正在加载已有属性…</p>}
      {fields && !fields.length && (
        <p className="document-empty">尚无启用 AI 的公司属性，可先在公司属性中配置。</p>
      )}
      {fields?.map((field) => {
        const empty = isEmptyAttributeValue(field.current_value);
        return (
          <label className="document-attribute-field" key={field.id}>
            <input
              type="checkbox"
              checked={selected.includes(field.id)}
              disabled={
                busy ||
                !empty ||
                !field.guidance.trim() ||
                (selected.length >= 10 && !selected.includes(field.id))
              }
              onChange={(e) =>
                setSelected((items) =>
                  e.target.checked ? [...items, field.id] : items.filter((id) => id !== field.id),
                )
              }
            />
            <span>
              {field.name}
              <small>
                {!empty
                  ? `已有值，保留：${formatAttributeValue(field.current_value)}`
                  : field.guidance.trim()
                    ? '空值 · 可按本文档证据填入'
                    : '请先为此属性配置 AI 指导'}
              </small>
            </span>
          </label>
        );
      })}
      {!!fields?.length && (
        <button type="button" disabled={busy || !selected.length} onClick={() => void organize()}>
          <Sparkles size={13} />
          {busy ? '正在按证据整理…' : `填充 ${selected.length} 个空属性`}
        </button>
      )}
      {result && (
        <div className="document-attribute-results" aria-live="polite">
          <p className="document-result-count">
            {(['filled', 'preserved', 'conflict', 'missing'] as const)
              .map(
                (status) =>
                  `${{ filled: '填入', preserved: '已有值保留', conflict: '差异', missing: '无依据' }[status]} ${result.results.filter((item) => item.status === status).length} 项`,
              )
              .join(' · ')}
          </p>
          {result.results.map((item) => (
            <article key={item.attribute_id}>
              <h3>
                {item.name}{' '}
                <span>
                  {
                    {
                      filled: '已填入',
                      preserved: '保留原值',
                      conflict: '存在差异，未更新',
                      missing: '无相关信息',
                    }[item.status]
                  }
                </span>
              </h3>
              <p>{item.explanation}</p>
              {item.status === 'filled' && <p>{formatAttributeValue(item.value)}</p>}
              {item.evidence.map((source, index) => (
                <blockquote key={index}>
                  <small>{source.label}</small>
                  {source.quote}
                </blockquote>
              ))}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentQuestion({ workspace, file }: { workspace: string; file: DocumentDetail }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<DocumentAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!question.trim() || busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    setAnswer(null);
    try {
      const value = await api<DocumentAnswer>(`/documents/${file.id}/ask`, {
        workspace,
        method: 'POST',
        body: { question: question.trim() },
        signal: request.signal,
      });
      if (!request.signal.aborted) setAnswer(value);
    } catch (e) {
      if (!request.signal.aborted) setError(errorText(e));
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return (
    <form className="document-question" onSubmit={(e) => void ask(e)}>
      <p className="document-helper">本次仅询问此文件；回答依据仍是这份原文。</p>
      <label htmlFor="document-question">想了解什么</label>
      <textarea
        id="document-question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={3000}
        rows={3}
        placeholder="例如：这家公司主要提供什么服务？"
        disabled={busy}
      />
      <div className="document-actions">
        <button disabled={!question.trim() || busy}>{busy ? '正在回答…' : '询问此文档'}</button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {answer && (
        <div className="document-answer" aria-live="polite">
          <p>{answer.answer}</p>
          {answer.evidence.map((item, index) => (
            <blockquote key={index}>
              <small>{item.label}</small>
              {item.quote}
            </blockquote>
          ))}
        </div>
      )}
    </form>
  );
}
