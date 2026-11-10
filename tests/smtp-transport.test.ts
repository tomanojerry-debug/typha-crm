import { afterEach, expect, it, vi } from 'vitest';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { simpleParser } from 'mailparser';
import { neteaseSmtp, smtpTransport, SubmissionError } from '../server/smtp-transport.js';
import type { OutgoingMail } from '../shared/outgoing.js';
const mail = {
  from_email: 'fixture@163.com',
  to: ['alice@example.com', 'new@example.net'],
  cc: ['cc@example.net'],
  bcc: ['private@example.net'],
  subject: '样衣确认',
  body: '您好：\n请确认尺寸。',
  message_id: '<synthetic-message@163.com>',
  in_reply_to: '<parent@example.com>',
  reference_ids: ['<root@example.com>', '<parent@example.com>'],
  attachments: [{ name: '尺寸.txt', content: Buffer.from('120 cm').toString('base64') }],
} as OutgoingMail;
const input = { mail, email: 'fixture@163.com', password: 'synthetic-code' };
afterEach(() => vi.restoreAllMocks());
it('builds MIME with the exact reviewed text, recipients, identifier and attachment, without a Bcc header', async () => {
  let mime: Buffer | undefined;
  // Use the same compiled MIME as SMTP. Nodemailer's stream transport deliberately
  // retains Bcc for archival output, so it is not a substitute for SMTP here.
  const stream = nodemailer.createTransport({
    name: 'in-memory-smtp-fixture',
    version: '1.0',
    send(message, callback) {
      const chunks: Buffer[] = [];
      const source = message.message.createReadStream();
      source.on('data', (chunk: Buffer) => chunks.push(chunk));
      source.on('error', callback);
      source.on('end', () => {
        mime = Buffer.concat(chunks);
        callback(null, {
          accepted: [...mail.to, ...mail.cc, ...mail.bcc],
          rejected: [],
          envelope: message.message.getEnvelope(),
          messageId: message.message.messageId(),
        });
      });
    },
  });
  const sendMail = vi.fn(async (options: SendMailOptions) => {
    return stream.sendMail(options);
  });
  const create = vi
    .spyOn(nodemailer, 'createTransport')
    .mockReturnValue({ sendMail, close: vi.fn() } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >);
  await smtpTransport.send(input);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      host: 'smtp.163.com',
      port: 465,
      secure: true,
      disableFileAccess: true,
      disableUrlAccess: true,
      debug: false,
      logger: false,
    }),
  );
  const parsed = await simpleParser(mime!);
  expect(parsed.subject).toBe(mail.subject);
  expect(parsed.text?.trimEnd()).toBe(mail.body);
  expect(parsed.messageId).toBe(mail.message_id);
  expect(parsed.inReplyTo).toBe(mail.in_reply_to);
  expect(parsed.references).toEqual(mail.reference_ids);
  expect(parsed.bcc).toBeUndefined();
  expect(parsed.attachments[0].filename).toBe('尺寸.txt');
  expect(parsed.attachments[0].content.toString()).toBe('120 cm');
  expect(sendMail.mock.calls[0][0]).toMatchObject({ to: mail.to, cc: mail.cc, bcc: mail.bcc });
});
it('only classifies definite rejections as safe to re-confirm, and redacts provider errors', async () => {
  const sendMail = vi.fn().mockRejectedValue({ code: 'EAUTH', message: 'SECRET provider detail' });
  vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
    sendMail,
    close: vi.fn(),
  } as unknown as ReturnType<typeof nodemailer.createTransport>);
  await expect(smtpTransport.send(input)).rejects.toMatchObject({ definitelyNotSent: true });
  sendMail.mockRejectedValue({ code: 'ESOCKET', message: 'SECRET provider detail' });
  await expect(smtpTransport.send(input)).rejects.toMatchObject({
    definitelyNotSent: false,
    message: expect.not.stringContaining('SECRET'),
  });
  sendMail.mockResolvedValue({ accepted: ['alice@example.com'], rejected: ['new@example.net'] });
  await expect(smtpTransport.send(input)).rejects.toMatchObject({ definitelyNotSent: false });
});
it('does not allow arbitrary SMTP hosts', () => {
  expect(() => neteaseSmtp('user@untrusted.example', 'unused')).toThrow(SubmissionError);
});
