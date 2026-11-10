import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { OutgoingMail } from '../shared/outgoing.js';

export class SubmissionError extends Error {
  constructor(
    message: string,
    public definitelyNotSent: boolean,
  ) {
    super(message);
  }
}
interface SendInput {
  mail: OutgoingMail;
  email: string;
  password: string;
}
export interface SendTransport {
  send(input: SendInput): Promise<void>;
  checkSent(input: SendInput): Promise<boolean>;
}
export function neteaseSmtp(email: string, password: string) {
  const domain = email.split('@')[1];
  if (!['163.com', '126.com', 'yeah.net'].includes(domain))
    throw new SubmissionError('暂仅支持网易个人邮箱', true);
  return nodemailer.createTransport({
    host: `smtp.${domain}`,
    port: 465,
    secure: true,
    auth: { user: email, pass: password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}
export const smtpTransport: SendTransport = {
  async send({ mail, email, password }) {
    const client = neteaseSmtp(email, password);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.sendMail({
          from: { name: '', address: email },
          to: mail.to,
          cc: mail.cc,
          bcc: mail.bcc,
          subject: mail.subject,
          text: mail.body,
          messageId: mail.message_id!,
          inReplyTo: mail.in_reply_to || undefined,
          references: mail.reference_ids?.length ? mail.reference_ids : undefined,
          attachments: mail.attachments.map((a) => ({
            filename: a.name,
            content: Buffer.from(a.content, 'base64'),
            contentType: 'application/octet-stream',
          })),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            client.close();
            reject(new SubmissionError('发送超时，结果待核对；系统不会自动重发。', false));
          }, 60000);
          timer.unref();
        }),
      ]);
      if (
        result.rejected?.length ||
        result.accepted?.length !== mail.to.length + mail.cc.length + mail.bcc.length
      )
        throw new SubmissionError(
          '部分收件人未被邮箱接受，请在原邮箱核对；系统不会自动重发。',
          false,
        );
    } catch (e) {
      if (e instanceof SubmissionError) throw e;
      const error = e as { code?: string; responseCode?: number };
      const rejected =
        ['EAUTH', 'EDNS', 'ECONNECTION', 'EENVELOPE'].includes(error.code || '') ||
        (typeof error.responseCode === 'number' && error.responseCode >= 400);
      throw new SubmissionError(
        rejected
          ? '邮箱拒绝了发送，请检查授权码、收件地址或邮箱限制，修改后重新确认。'
          : '发送连接中断，结果待核对；系统不会自动重发。',
        rejected,
      );
    } finally {
      if (timer) clearTimeout(timer);
      client.close();
    }
  },
  async checkSent({ mail, email, password }) {
    const client = new ImapFlow({
      host: `imap.${email.split('@')[1]}`,
      port: 993,
      secure: true,
      auth: { user: email, pass: password },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      disableAutoIdle: true,
      clientInfo: { name: 'Typha CRM', version: '1.0' },
    });
    client.on('error', () => {});
    const timer = setTimeout(() => client.close(), 60000);
    timer.unref();
    try {
      await client.connect();
      const folders = await client.list();
      const sent =
        folders.find((f) => f.specialUse === '\\Sent') ??
        folders.find((f) =>
          ['sent', 'sent messages', 'sent items', '已发送', '已发送邮件'].includes(
            f.path.toLowerCase(),
          ),
        );
      if (!sent) return false;
      const lock = await client.getMailboxLock(sent.path, { readOnly: true });
      try {
        const ids = await client.search(
          { header: { 'Message-ID': mail.message_id! } },
          { uid: true },
        );
        for (const id of (ids || []).slice(-5)) {
          const meta = await client.fetchOne(id, { size: true }, { uid: true });
          if (!meta || (meta.size || 0) > 8 * 1024 * 1024) continue;
          const full = await client.fetchOne(id, { source: true }, { uid: true });
          if (!full || !full.source) continue;
          const parsed = await simpleParser(full.source);
          const to = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []).flatMap(
            (a) => a.value.map((v) => v.address?.toLowerCase()),
          );
          const cc = (Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : []).flatMap(
            (a) => a.value.map((v) => v.address?.toLowerCase()),
          );
          const normalized = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
          if (
            parsed.messageId === mail.message_id &&
            parsed.from?.value.some((a) => a.address?.toLowerCase() === email) &&
            parsed.subject === mail.subject &&
            to.length === mail.to.length &&
            mail.to.every((a) => to.includes(a)) &&
            cc.length === mail.cc.length &&
            mail.cc.every((a) => cc.includes(a)) &&
            normalized(parsed.text || '') === normalized(mail.body) &&
            parsed.attachments.length === mail.attachments.length &&
            mail.attachments.every(
              (a, i) =>
                parsed.attachments[i].filename === a.name &&
                parsed.attachments[i].content.equals(Buffer.from(a.content, 'base64')),
            )
          )
            return true;
        }
        return false;
      } finally {
        lock.release();
      }
    } finally {
      clearTimeout(timer);
      client.close();
    }
  },
};
