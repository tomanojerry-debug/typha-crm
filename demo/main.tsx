import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RotateCcw, HelpCircle, LogOut, X } from 'lucide-react';
import { App } from '../src/App';
import fixtureData from './fixture.json';
import type { DemoFixture } from './types';
import { actorId, demoAccounts, type DemoAccount } from './accounts';
import { demoRuntime, onDemoLogout } from './api';
import { DemoLogin } from './Login';
import { demoChartFilename, sampleChartHref } from './runtime';
import '../src/style.css';
import '../src/workbench.css';
import '../src/people.css';
import '../src/theme.css';
import '../src/neutral-theme.css';
import '../src/neutral-cards.css';
import '../src/workspace-page.css';
import './style.css';

const fixture = fixtureData as DemoFixture;
function DemoExperience() {
  const help = useRef<HTMLDialogElement>(null);
  const [account, setAccount] = useState<DemoAccount | null>(null);
  const selected = demoAccounts.find((item) => item.key === account);
  useEffect(() => onDemoLogout(() => setAccount(null)), []);

  function choose(next: DemoAccount | null) {
    if (next && next !== 'designer') {
      const navigationKey = `light-crm:view:${fixture.workspaceId}:${actorId(fixture, next)}`;
      try {
        if (!localStorage.getItem(navigationKey))
          localStorage.setItem(navigationKey, JSON.stringify({ object: 'customers' }));
      } catch {
        // The workspace also works without saved navigation.
      }
    }
    demoRuntime.choose(next);
    setAccount(next);
  }
  function reset() {
    try {
      const accountIds = demoAccounts.map((item) => actorId(fixture, item.key));
      for (const key of Object.keys(localStorage)) {
        if (key.includes(fixture.workspaceId) && accountIds.some((id) => key.includes(id)))
          localStorage.removeItem(key);
      }
    } catch {
      // The business data is only in memory.
    }
    demoRuntime.reset();
    setAccount(null);
  }
  return (
    <div className="demo-experience">
      <header className="demo-toolbar" aria-label="在线体验说明">
        <div className="demo-toolbar-copy">
          <strong>在线体验</strong>
          <span>{selected ? `${selected.title} · ${selected.name}` : '操作仅在本页有效'}</span>
        </div>
        <nav aria-label="产品与体验操作">
          {selected && (
            <button aria-label="切换账号" onClick={() => choose(null)}>
              <LogOut size={14} />
              <span>切换账号</span>
            </button>
          )}
          {account === 'designer' && (
            <a href={sampleChartHref()} download={demoChartFilename}>
              下载示例尺码表
            </a>
          )}
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
        {account ? <App key={account} /> : <DemoLogin onChoose={choose} />}
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
            <strong>接着处理。</strong>{' '}
            以设计师进入“协作待办”，下载示例尺码表，填写结果并提交附件。切回外贸业务员，可在
            Northstar 的 A214 样衣反馈活动里查看交付。
          </li>
          <li>
            <strong>分析反馈。</strong>{' '}
            以老板身份打开“报告”中的售后看板，按款式、问题与尺码筛选，查看原话或导出明细。
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
