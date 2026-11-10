import { expect, it } from 'vitest';
import type { OutgoingContent } from '../shared/outgoing.js';
import {
  bindComposerRecipient,
  composerVariableIssues,
  hasComposerEdits,
  initialComposerRecipientBinding,
  outgoingContentOf,
} from '../src/mail-composer-state.js';

const content: OutgoingContent = {
  account_id: null,
  project_id: null,
  to: ['one@fixture.invalid'],
  cc: [],
  bcc: [],
  subject: '{姓名}',
  body: '您好',
  attachments: [],
  variable_document: {
    version: 1,
    subject: [
      { type: 'variable', id: 'node-1', root: 'recipient', field: 'people:name', label: '姓名' },
    ],
    body: [{ type: 'text', text: '您好' }],
  },
  recipient_bindings: [{ email: 'one@fixture.invalid', person_id: 'person-1' }],
};

it('includes variable bindings and explicit empty fallback in saved copies and the dirty comparison', () => {
  const baseline = outgoingContentOf(content);
  const edited = outgoingContentOf(content);
  const variable = edited.variable_document!.subject[0];
  if (variable.type !== 'variable') throw new Error('fixture');
  variable.fallback = '';
  expect(hasComposerEdits(edited, baseline)).toBe(true);
  delete variable.fallback;
  expect(hasComposerEdits(edited, baseline)).toBe(false);
  edited.recipient_bindings![0].person_id = 'person-2';
  expect(hasComposerEdits(edited, baseline)).toBe(true);
  expect(content.recipient_bindings![0].person_id).toBe('person-1');
  expect(Object.hasOwn(content.variable_document!.subject[0], 'fallback')).toBe(false);
});

it('shows each preview issue once while retaining the recipient of separate mass messages', () => {
  const issue = { code: 'empty', message: '姓名未填写' };
  const preview = {
    digest: 'digest',
    can_confirm: false,
    recipient_bindings: [],
    recipient_choices: [],
    issues: [issue, issue],
    messages: [
      {
        recipient: 'first@fixture.invalid',
        subject: '',
        body: '',
        values: [],
        issues: [issue, issue],
      },
      { recipient: 'second@fixture.invalid', subject: '', body: '', values: [], issues: [issue] },
    ],
  };
  expect(composerVariableIssues(preview)).toEqual([
    { ...issue, recipient: 'first@fixture.invalid' },
    { ...issue, recipient: 'second@fixture.invalid' },
  ]);
});

it('treats changing only a stable field reference as a draft edit even when its label is unchanged', () => {
  const edited = outgoingContentOf(content);
  const variable = edited.variable_document!.subject[0];
  if (variable.type === 'variable') variable.field = 'people:job_title';
  expect(hasComposerEdits(edited, content)).toBe(true);
});

it('keeps old protocol drafts free of new optional fields', () => {
  const { variable_document: _document, recipient_bindings: _bindings, ...legacy } = content;
  expect(Object.hasOwn(outgoingContentOf(legacy), 'variable_document')).toBe(false);
  expect(Object.hasOwn(outgoingContentOf(legacy), 'recipient_bindings')).toBe(false);
  expect(hasComposerEdits({ ...legacy, recipient_bindings: [] }, legacy)).toBe(false);
});

it('retains the explicitly selected contact even when another person uses the same email', () => {
  const selected = bindComposerRecipient(
    content,
    { id: 'person-2', email: 'ONE@fixture.invalid', customer_id: 'customer-a' },
    'customer-a',
    true,
  );
  expect(selected.recipient_bindings).toEqual([
    { email: 'one@fixture.invalid', person_id: 'person-2' },
  ]);
  expect(hasComposerEdits(selected, content)).toBe(true);
  expect(
    bindComposerRecipient(
      content,
      { id: 'other-customer-person', email: 'one@fixture.invalid', customer_id: 'other-customer' },
      'customer-a',
      true,
    ),
  ).toBe(content);
  expect(
    bindComposerRecipient(
      content,
      { id: 'person-2', email: 'one@fixture.invalid', customer_id: 'customer-a' },
      'customer-a',
      false,
    ),
  ).toBe(content);
});

it('binds a new People compose only when its actual To matches that person rather than another Reply-To', () => {
  const { recipient_bindings: _bindings, ...unbound } = content;
  const person = { id: 'person-a', email: 'one@fixture.invalid', customer_id: 'customer-a' };
  expect(initialComposerRecipientBinding(unbound, person, true).recipient_bindings).toEqual([
    { email: person.email, person_id: person.id },
  ]);
  expect(
    initialComposerRecipientBinding({ ...unbound, to: ['reply-to@fixture.invalid'] }, person, true)
      .recipient_bindings,
  ).toBeUndefined();
  expect(
    initialComposerRecipientBinding(unbound, person, false).recipient_bindings,
  ).toBeUndefined();
  expect(initialComposerRecipientBinding(content, person, true).recipient_bindings).toEqual(
    content.recipient_bindings,
  );
});
