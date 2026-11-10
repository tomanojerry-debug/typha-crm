import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { RotateCcw, HelpCircle, X } from 'lucide-react';
import { App } from '../src/App';
import fixtureData from './fixture.json';
import type { DemoFixture } from './types';
import '../src/style.css';
import '../src/workbench.css';
import '../src/people.css';
import '../src/theme.css';
import '../src/neutral-theme.css';
import '../src/neutral-cards.css';
import '../src/workspace-page.css';
import './style.css';

const fixture = fixtureData as DemoFixture;
const navigationKey = `light-crm:view:${fixture.workspaceId}:${fixture.actorId}`;
function start() {
  try {
    if (!localStorage.getItem(navigationKey))
      localStorage.setItem(navigationKey, JSON.stringify({ object: 'customers' }));
  } catch {
    /* The product remains usable without saved navigation. */
  }
}
start();

function DemoExperience() {
  const help = useRef<HTMLDialogElement>(null);
  function reset() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.includes(fixture.workspaceId) && key.includes(fixture.actorId))
          localStorage.removeItem(key);
      }
    } catch {
      /* In-memory changes also reset on reload. */
    }
    location.reload();
  }
  return (
    <div className="demo-experience">
      <header className="demo-toolbar" aria-label="在线体验说明">
        <div className="demo-toolbar-copy">
          <strong>在线体验</strong>
          <span>示例空间 · 操作仅在本页有效</span>
        </div>
        <nav aria-label="产品与体验操作">
          <button aria-label="使用提示" onClick={() => help.current?.showModal()}>
            <HelpCircle size={14} />
            <span>使用提示</span>
          </button>
          <button aria-label="重置" onClick={reset}>
            <RotateCcw size={14} />
            <span>重置</span>
          </button>
          <a href="./about.html">产品介绍</a>
          <a
            className="demo-install"
            href="https://github.com/tomanojerry-debug/typha-crm/blob/main/docs/getting-started.md"
            target="_blank"
            rel="noreferrer"
          >
            本机部署 ↗
          </a>
        </nav>
      </header>
      <div className="demo-product">
        <App />
      </div>
      <dialog
        className="demo-help"
        ref={help}
        aria-labelledby="demo-help-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.stopPropagation();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) help.current?.close();
        }}
      >
        <header>
          <h2 id="demo-help-title">开始使用 Typha</h2>
          <button aria-label="关闭使用提示" onClick={() => help.current?.close()}>
            <X size={18} />
          </button>
        </header>
        <p>
          你正在使用产品的实际前端界面。此空间预置了示例客户、沟通记录、待办与产品反馈，方便直接体验。
        </p>
        <ol>
          <li>
            <strong>查看客户。</strong>{' '}
            搜索公司，点击名称打开档案，或使用预览查看客户背景与沟通记录。
          </li>
          <li>
            <strong>接着处理。</strong> 在“待办”查看原活动，开始处理并填写结果，试试按状态筛选。
          </li>
          <li>
            <strong>分析反馈。</strong>{' '}
            打开“报告”中的售后看板，按款式、问题与尺码筛选，查看原话或导出明细。
          </li>
          <li>
            <strong>了解 AI 流程。</strong>{' '}
            在已有对话中查看准备好的沟通总结与来源。在线体验不调用真实模型或发送邮件。
          </li>
        </ol>
        <p className="demo-help-note">
          资料修改仅保留在当前页面，刷新或重置后恢复初始示例。连接自己的资料与模型服务，请按本机部署说明运行完整应用。
        </p>
        <button className="demo-help-start" onClick={() => help.current?.close()}>
          开始体验
        </button>
      </dialog>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DemoExperience />
  </React.StrictMode>,
);
