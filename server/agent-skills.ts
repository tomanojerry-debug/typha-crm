import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  agentHarnessPolicyVersion,
  type AgentHarnessStep,
  type AgentSkillId,
} from '../shared/agent-harness.js';
import { ApiError } from './security.js';

export interface AgentSkill {
  readonly id: AgentSkillId;
  readonly version: string;
  readonly instructions: string;
  readonly steps: readonly AgentHarnessStep[];
}

// Only code-reviewed local packages can be registered. No HTTP paths, user files,
// scripts or discovered workspace directories are used to load task instructions.
const incomingMail = readFileSync(
  new URL('./skills/handle-incoming-mail/SKILL.md', import.meta.url),
  'utf8',
);
const incomingMailSteps: readonly AgentHarnessStep[] = Object.freeze([
  'read_sources',
  'read_template',
  'analyze_mail',
  'compose_mail',
  'validate_result',
  'save_draft',
]);
const incomingMailSkill: AgentSkill = Object.freeze({
  id: 'handle-incoming-mail',
  version: createHash('sha256')
    .update(JSON.stringify([agentHarnessPolicyVersion, incomingMailSteps, incomingMail]))
    .digest('hex'),
  instructions: incomingMail,
  steps: incomingMailSteps,
});

export function getAgentSkill(id: string): AgentSkill {
  if (!z.literal('handle-incoming-mail').safeParse(id).success)
    throw new ApiError(400, 'Agent 业务技能不存在');
  return incomingMailSkill;
}
