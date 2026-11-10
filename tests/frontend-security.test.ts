import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mountDevelopment } from '../server/frontend.js';

it('never serves credentials, database files, or server source through the development HTTP server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'light-crm-static-'));
  const secret = 'synthetic-private-content-must-not-be-served';
  for (const dir of ['src', 'shared', 'node_modules', '.local/postgres', 'server']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(join(root, 'index.html'), '<html><body>Public login page</body></html>');
  await writeFile(join(root, '.local/initial-login.txt'), secret);
  await writeFile(join(root, '.local/postgres/PG_VERSION'), secret);
  await writeFile(join(root, 'server/app.ts'), secret);
  await writeFile(join(root, 'src/public.ts'), 'export const visible = true;');
  await symlink(join(root, '.local/initial-login.txt'), join(root, 'src/escape.txt'));
  const app = express();
  const vite = await mountDevelopment(app, {
    root,
    dataDir: join(root, '.local/postgres'),
    configFile: false,
  });
  try {
    expect((await request(app).get('/').expect(200)).text).toContain('Public login page');
    expect((await request(app).get('/src/public.ts').expect(200)).text).toContain('visible');
    for (const path of [
      '/.local/initial-login.txt',
      '/.local/postgres/PG_VERSION',
      '/server/app.ts?raw',
      `/@fs/${root}/.local/initial-login.txt`,
      '/src/%2e%2e/.local/initial-login.txt',
      '/src/..%2f.local/initial-login.txt?raw',
      '/@vite/client/../../.local/initial-login.txt',
      '/src/escape.txt?raw',
    ]) {
      const response = await request(app).get(path);
      expect(response.text, path).not.toContain(secret);
      expect([403, 404], path).toContain(response.status);
    }
  } finally {
    await vite.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
