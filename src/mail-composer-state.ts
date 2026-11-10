import type { OutgoingContent, OutgoingMail } from '../shared/outgoing';
import type { MailVariablePreview } from '../shared/mail-variables';

export type MailComposerStep = 'write' | 'review' | 'schedule' | 'status';

export function composerVariableIssues(preview: MailVariablePreview) {
  const signature = (issue: { code: string; message: string }) =>
    JSON.stringify([issue.code, issue.message]);
  const messages = preview.messages.flatMap((message) =>
    message.issues.map((issue) => ({
      ...issue,
      ...(issue.recipient || !message.recipient ? {} : { recipient: message.recipient }),
    })),
  );
  const addressed = new Set(messages.filter((issue) => issue.recipient).map(signature));
  const issues = [
    ...preview.issues.filter((issue) => issue.recipient || !addressed.has(signature(issue))),
    ...messages,
  ];
  return [
    ...new Map(
      issues.map((issue) => [JSON.stringify([issue.recipient || '', signature(issue)]), issue]),
    ).values(),
  ];
}

export function bindComposerRecipient(
  content: OutgoingContent,
  choice: { id: string; email: string; customer_id?: string },
  customerId: string,
  enabled: boolean,
) {
  const email = choice.email.trim().toLowerCase();
  if (!enabled || choice.customer_id !== customerId || !content.to.includes(email)) return content;
  return {
    ...content,
    recipient_bindings: [
      ...(content.recipient_bindings || []).filter((binding) => binding.email !== email),
      { email, person_id: choice.id },
    ],
  };
}

export function initialComposerRecipientBinding(
  content: OutgoingContent,
  person: { id: string; email: string | null; customer_id: string },
  enabled: boolean,
) {
  if (!person.email) return content;
  const email = person.email.trim().toLowerCase();
  if (content.recipient_bindings?.some((binding) => binding.email === email)) return content;
  return bindComposerRecipient(content, { ...person, email }, person.customer_id, enabled);
}

export function outgoingContentOf(mail: OutgoingContent): OutgoingContent {
  return {
    account_id: mail.account_id,
    project_id: mail.project_id,
    to: [...mail.to],
    cc: [...mail.cc],
    bcc: [...mail.bcc],
    subject: mail.subject,
    body: mail.body,
    attachments: mail.attachments.map((attachment) => ({ ...attachment })),
    mass_sending: Boolean(mail.mass_sending),
    ...(mail.variable_document
      ? {
          variable_document: {
            version: 1 as const,
            subject: mail.variable_document.subject.map((node) => ({ ...node })),
            body: mail.variable_document.body.map((node) => ({ ...node })),
          },
        }
      : {}),
    ...(mail.recipient_bindings
      ? { recipient_bindings: mail.recipient_bindings.map((binding) => ({ ...binding })) }
      : {}),
  };
}

export function hasComposerEdits(content: OutgoingContent, baseline: OutgoingContent) {
  const sameAddresses = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    content.account_id !== baseline.account_id ||
    content.project_id !== baseline.project_id ||
    content.subject !== baseline.subject ||
    content.body !== baseline.body ||
    JSON.stringify(content.variable_document ?? null) !==
      JSON.stringify(baseline.variable_document ?? null) ||
    JSON.stringify(content.recipient_bindings ?? []) !==
      JSON.stringify(baseline.recipient_bindings ?? []) ||
    Boolean(content.mass_sending) !== Boolean(baseline.mass_sending) ||
    !sameAddresses(content.to, baseline.to) ||
    !sameAddresses(content.cc, baseline.cc) ||
    !sameAddresses(content.bcc, baseline.bcc) ||
    content.attachments.length !== baseline.attachments.length ||
    content.attachments.some(
      (attachment, index) =>
        attachment.name !== baseline.attachments[index]?.name ||
        attachment.content !== baseline.attachments[index]?.content,
    )
  );
}

export function composerCloseReason(dirty: boolean, pending: boolean, step: MailComposerStep) {
  if (dirty || pending) return 'edits' as const;
  return step === 'schedule' ? ('time' as const) : null;
}

export function matchesComposerScope(
  mail: OutgoingMail,
  expected: {
    id: string;
    workspace: string;
    customer: string;
    target: string;
    kind: 'people' | 'customers';
  },
) {
  return (
    mail.id === expected.id &&
    mail.workspace_id === expected.workspace &&
    mail.customer_id === expected.customer &&
    (expected.kind === 'people'
      ? mail.person_id === expected.target
      : mail.person_id === null && expected.target === expected.customer)
  );
}

export function shanghaiLocalMinute(instant: number) {
  return new Date(instant + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/** datetime-local is always interpreted in the business timezone, not the browser timezone. */
export function shanghaiScheduleInstant(value: string, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new Error('请选择具体的发送日期和时间（北京时间）');
  const precision = value.length;
  const at = new Date(`${value}${precision === 16 ? ':00' : ''}+08:00`);
  if (
    !Number.isFinite(at.getTime()) ||
    new Date(at.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, precision) !== value
  )
    throw new Error('发送日期或时间无效，请重新选择');
  if (at.getTime() <= now || at.getTime() > now + 366 * 86400000)
    throw new Error('请选择未来一年内的发送时间');
  return at.toISOString();
}
