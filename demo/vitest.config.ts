import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['demo/**/*.test.ts'], maxWorkers: 1 } });
