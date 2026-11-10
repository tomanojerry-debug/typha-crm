import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localWeChatRuntime, wechatChildEnvironment } from '../server/wechat-platform.js';

const python =
  process.env.WECHAT_PYTHON_BIN || (process.platform === 'win32' ? 'python.exe' : 'python3');
for (const file of ['../tests/wechat_bridge_test.py', '../tests/wechat_windows_test.py']) {
  const result = spawnSync(python, [fileURLToPath(new URL(file, import.meta.url))], {
    stdio: 'inherit',
    shell: false,
    env: wechatChildEnvironment(localWeChatRuntime),
  });
  if (result.error) {
    console.error('无法运行Python桥测试，请安装Python或配置WECHAT_PYTHON_BIN。');
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
