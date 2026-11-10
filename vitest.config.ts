import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Each integration file initializes a PGlite WASM database and all migrations.
  // Bound concurrent databases so CPU contention cannot exhaust setup deadlines.
  test: { include: ['tests/**/*.test.ts'], maxWorkers: 2 },
});
