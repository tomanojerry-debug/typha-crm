import { expect, it } from 'vitest';
import type { OutgoingContent, OutgoingMail } from '../shared/outgoing.js';
import {
  composerCloseReason,
  hasComposerEdits,
  matchesComposerScope,
  outgoingContentOf,
  shanghaiLocalMinute,
  shanghaiScheduleInstant,
} from '../src/mail-composer-state.js';

const content: OutgoingContent = {
  account_id: 'account-a',
  project_id: 'project-a',
  to: ['to@fixture.invalid'],
  cc: ['cc@fixture.invalid'],
  bcc: ['bcc@fixture.invalid'],
  subject: '原草稿主题',
  body: '原草稿正文',
  attachments: [{ name: '示例.txt', content: 'dGVzdA==' }],
};

it('compares the complete draft against its saved baseline instead of retaining a sticky dirty flag', () => {
  expect(hasComposerEdits({ ...content, mass_sending: false }, content)).toBe(false);
  for (const changed of [
    { ...content, account_id: 'account-b' },
    { ...content, project_id: null },
    { ...content, to: ['other@fixture.invalid'] },
    { ...content, cc: [] },
    { ...content, bcc: [] },
    { ...content, subject: '新主题' },
    { ...content, body: '新正文' },
    { ...content, attachments: [{ ...content.attachments[0], content: 'bmV3' }] },
    { ...content, mass_sending: true },
  ])
    expect(hasComposerEdits(changed, content)).toBe(true);
  const restored = { ...content, body: '改后正文' };
  restored.body = content.body;
  expect(hasComposerEdits(restored, content)).toBe(false);
});

it('keeps copied saved baselines independent of current recipient and attachment edits', () => {
  const baseline = outgoingContentOf(content);
  baseline.to.push('new@fixture.invalid');
  baseline.attachments[0].name = 'new.txt';
  expect(content.to).toEqual(['to@fixture.invalid']);
  expect(content.attachments[0].name).toBe('示例.txt');
});

it('protects unsaved input and unconfirmed send times without pretending a saved draft is scheduled', () => {
  expect(composerCloseReason(true, false, 'write')).toBe('edits');
  expect(composerCloseReason(false, true, 'write')).toBe('edits');
  expect(composerCloseReason(false, false, 'schedule')).toBe('time');
  expect(composerCloseReason(false, false, 'write')).toBeNull();
  expect(composerCloseReason(false, false, 'status')).toBeNull();
});

it('accepts conflict rereads only for the exact draft, workspace, customer and compose target', () => {
  const expected = {
    id: 'draft-a',
    workspace: 'workspace-a',
    customer: 'customer-a',
    target: 'person-a',
    kind: 'people' as const,
  };
  const mail = {
    ...content,
    id: expected.id,
    workspace_id: expected.workspace,
    customer_id: expected.customer,
    person_id: expected.target,
  } as OutgoingMail;
  expect(matchesComposerScope(mail, expected)).toBe(true);
  for (const changed of [
    { ...mail, id: 'other' },
    { ...mail, workspace_id: 'other' },
    { ...mail, customer_id: 'other' },
    { ...mail, person_id: null },
  ])
    expect(matchesComposerScope(changed, expected)).toBe(false);
  expect(
    matchesComposerScope(
      { ...mail, person_id: null },
      { ...expected, kind: 'customers', target: expected.customer },
    ),
  ).toBe(true);
  expect(
    matchesComposerScope(mail, { ...expected, kind: 'customers', target: expected.customer }),
  ).toBe(false);
});

it('converts a chosen Beijing wall time to its exact UTC instant independent of the execution timezone', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  expect(shanghaiScheduleInstant('2026-10-30T09:15', now)).toBe('2026-10-30T01:15:00.000Z');
  expect(shanghaiScheduleInstant('2026-10-30T09:15:30', now)).toBe('2026-10-30T01:15:30.000Z');
  expect(shanghaiLocalMinute(Date.parse('2026-10-29T18:20:00Z'))).toBe('2026-10-30T02:20');
});

it('rejects absent, malformed, impossible, past and overly distant schedule choices before any API call', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  for (const value of [
    '',
    'tomorrow',
    '2026-10-30',
    '2026-11-31T10:00',
    '2026-12-01T25:00',
    '2026-10-29T08:00',
    '2028-01-01T08:00',
  ])
    expect(() => shanghaiScheduleInstant(value, now)).toThrow();
});
