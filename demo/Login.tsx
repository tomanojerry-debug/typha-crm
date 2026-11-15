import { ArrowRight, BriefcaseBusiness, Globe2, Ruler, ShieldCheck } from 'lucide-react';
import { demoAccounts, type DemoAccount } from './accounts';

const accountIcons = {
  boss: ShieldCheck,
  export: Globe2,
  domestic: BriefcaseBusiness,
  designer: Ruler,
};

export function DemoLogin({ onChoose }: { onChoose(account: DemoAccount): void }) {
  return (
    <main className="demo-login">
      <div className="demo-login-inner">
        <div className="demo-login-brand">
          Typha <span>AI CRM</span>
        </div>
        <h1>打开在线工作空间</h1>
        <p className="demo-login-intro">选择一个角色，浏览对应的空白工作空间。</p>
        <div className="demo-login-accounts" aria-label="演示账号">
          {demoAccounts.map((account) => {
            const Icon = accountIcons[account.key];
            return (
              <button
                key={account.key}
                className="demo-login-account"
                aria-label={account.title}
                onClick={() => onChoose(account.key)}
              >
                <span className="demo-login-icon">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <span className="demo-login-account-text">
                  <strong>{account.title}</strong>
                  <span>
                    {account.name} · {account.summary}
                  </span>
                </span>
                <ArrowRight size={17} aria-hidden="true" className="demo-login-arrow" />
              </button>
            );
          })}
        </div>
        <p className="demo-login-note">
          <ShieldCheck size={16} aria-hidden="true" /> 操作仅在当前页面有效。
        </p>
      </div>
    </main>
  );
}
