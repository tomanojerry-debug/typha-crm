import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalWeChatTransport } from '../server/wechat-transport.js';
import { localWeChatRuntime } from '../server/wechat-platform.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wechat-transport-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function fixture(body: string) {
  const path = join(directory, 'synthetic-cli.mjs');
  await writeFile(
    path,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(join(directory, 'calls'))}, JSON.stringify({args,tz:process.env.TZ})+'\\n');\n${body}`,
    { mode: 0o700 },
  );
  return createLocalWeChatTransport({
    ...localWeChatRuntime,
    home: directory,
    env: { PATH: process.env.PATH, WECHAT_CLI_BIN: process.execPath },
    async exists(candidate) {
      return candidate === process.execPath;
    },
    async realpath(candidate) {
      return candidate;
    },
    async directories() {
      return [];
    },
    async execute(file, args, options) {
      // This suite tests real synthetic CLI subprocesses, not the installed Mac
      // application or its metadata. Platform diagnostics have their own suite.
      if (file !== process.execPath) return { stdout: '' };
      return localWeChatRuntime.execute(
        file,
        file === process.execPath ? [path, ...args] : args,
        options,
      );
    },
  });
}
async function calls(): Promise<{ args: string[]; tz: string }[]> {
  return (await readFile(join(directory, 'calls'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
it('passes literal contact identities as arguments and limits history to text and Beijing dates', async () => {
  const identity = '林老师;$(echo synthetic)';
  const transport = await fixture(
    `console.log(JSON.stringify(args[0]==='contacts' ? [{username:'wxid_fixture',nick_name:${JSON.stringify(identity)}}] : {username:'wxid_fixture',messages:[{local_id:'stable-1',time:'2026-10-22 23:59:59',text:'合成范围内文字'},{local_id:'outside',time:'2026-10-23 00:00:00',text:'范围外'}]}));`,
  );
  expect(await transport.resolve(identity)).toMatchObject([{ id: 'wxid_fixture', name: identity }]);
  const result = await transport.history('wxid_fixture', '2026-10-22', '2026-10-22');
  expect(result.messages.map((m) => m.id)).toEqual(['stable-1']);
  const invocations = await calls();
  expect(invocations[0].args).toEqual([
    'contacts',
    '--query',
    identity,
    '--format',
    'json',
    '--limit',
    '30',
  ]);
  expect(invocations[1].args).toEqual([
    'history',
    'wxid_fixture',
    '--format',
    'json',
    '--type',
    'text',
    '--start-time',
    '2026-10-22 00:00:00',
    '--end-time',
    '2026-10-22 23:59:59',
    '--limit',
    '200',
    '--offset',
    '0',
  ]);
  expect(invocations.every((c) => c.tz === 'Asia/Shanghai')).toBe(true);
});
it('paginates using raw page size even when all messages in a page fall outside the requested days', async () => {
  const transport = await fixture(
    `const offset=Number(args[args.indexOf('--offset')+1]);console.log(JSON.stringify({messages:offset===0?Array.from({length:200},(_,i)=>({local_id:'old-'+i,time:'2026-10-01 10:00:00',text:'范围外'})):[{local_id:'in-range',time:'2026-10-22 10:00:00',text:'范围内'}]}));`,
  );
  expect(
    (await transport.history('wxid_fixture', '2026-10-22', '2026-10-22')).messages.map((m) => m.id),
  ).toEqual(['in-range']);
  expect((await calls()).map((c) => c.args.at(-1))).toEqual(['0', '200']);
});
it('rejects mismatched conversations, groups and broken adapters without generating an empty result', async () => {
  const transport = await fixture(
    `console.log(JSON.stringify({username:'wxid_other',messages:[]}));`,
  );
  await expect(transport.history('wxid_fixture', '2026-10-22', '2026-10-22')).rejects.toThrow(
    '身份',
  );
  await expect(transport.history('group@chatroom', '2026-10-22', '2026-10-22')).rejects.toThrow(
    '单聊',
  );
  await expect(transport.history('--help', '2026-10-22', '2026-10-22')).rejects.toThrow('单聊');
  expect(await calls()).toHaveLength(1);
  const malformed = await fixture(
    `console.log(JSON.stringify({messages:['[2026-10-22 10:00] 联系人: 格式化文字']}));`,
  );
  await expect(malformed.history('wxid_fixture', '2026-10-22', '2026-10-22')).rejects.toThrow(
    '稳定消息 ID',
  );
});
it.runIf(process.platform === 'darwin')(
  'requires explicit readiness and an account identity, and status never reads contacts or history',
  async () => {
    const transport = await fixture(
      `console.log(JSON.stringify({account_id:'synthetic-account'}));`,
    );
    expect((await transport.status()).state).toBe('needs_setup');
    const ready = await fixture(
      `console.log(JSON.stringify({ready:true,account_id:'synthetic-account'}));`,
    );
    expect(await ready.status()).toMatchObject({
      state: 'ready',
      account_key: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await calls()).map((c) => c.args)).toEqual([
      ['status', '--format', 'json'],
      ['status', '--format', 'json'],
    ]);
  },
);
