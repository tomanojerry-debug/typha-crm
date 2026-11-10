import type {
  ActivityAnalysisConfig,
  ActivityAnalysisInput,
  ActivityAnalysisResult,
} from '../shared/activity-analysis';

/** Public, synthetic data only. Snapshots are responses from the real isolated API. */
export interface DemoFixture {
  version: 1;
  workspaceId: string;
  actorId: string;
  feedbackBoardId: string;
  summaryChatId: string;
  memoryChatId: string;
  updateChatId: string;
  knowledgeCustomerId: string;
  analysisConfig: ActivityAnalysisConfig;
  snapshots: Record<string, unknown>;
  analysisAll: ActivityAnalysisResult;
  analysisGolden: { input: ActivityAnalysisInput; result: ActivityAnalysisResult }[];
  sourceKeysByActivity: Record<string, string[]>;
}

export function snapshotKey(path: string): string {
  const url = new URL(path, 'https://demo.invalid');
  url.searchParams.sort();
  return url.pathname + (url.search ? url.search : '');
}
