import { readFileSync } from 'node:fs';
import type { DemoFixture } from './types';

export const testFixture: DemoFixture = JSON.parse(
  readFileSync(new URL('./.generated-test-fixture.json', import.meta.url), 'utf8'),
);
