import { build } from 'vite';
import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
await build({ configFile: `${root}/demo/vite.config.ts` });
await cp(`${root}/site`, `${root}/.pages-build`, {
  recursive: true,
  filter: (path) => !path.endsWith('/index.html'),
});
await cp(
  `${root}/public/third-party-licenses.txt`,
  `${root}/.pages-build/third-party-licenses.txt`,
);
await cp(`${root}/LICENSE`, `${root}/.pages-build/LICENSE.txt`);
