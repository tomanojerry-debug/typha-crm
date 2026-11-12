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
        <h1>登录演示工作空间</h1>
        <p className="demo-login-intro">选择一个示例账号，体验团队如何跟进客户、交接尺码表。</p>
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
          <ShieldCheck size={16} aria-hidden="true" /> 使用虚构资料，操作仅保存在当前页面。
        </p>
      </div>
    </main>
  );
}
