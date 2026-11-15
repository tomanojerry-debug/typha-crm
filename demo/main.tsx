import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RotateCcw, HelpCircle, LogOut, X } from 'lucide-react';
import { App } from '../src/App';
import fixtureData from './fixture.json';
import type { DemoFixture } from './types';
import { actorId, demoAccounts, type DemoAccount } from './accounts';
import { demoRuntime, onDemoLogout } from './api';
import { DemoLogin } from './Login';
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
        <p>选择一个角色，即可浏览空白工作空间与该角色可访问的页面。</p>
        <p className="demo-help-note">
          体验在当前页面运行。安装完整应用后，可以在自己的设备上录入资料、配置邮箱和模型服务。
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
