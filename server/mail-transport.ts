import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { convert } from 'html-to-text';
import type { MailAddress } from '../shared/connections.js';
import { mailMessageId, mailReferences } from '../shared/mail-thread.js';
export interface ParsedMail {
  message_id?: string | null;
  reply_to?: MailAddress[];
  reference_ids?: string[];
  fingerprint: string;
  subject: string;
  sender: MailAddress[];
  recipients: MailAddress[];
  cc: MailAddress[];
  participants: string[];
  occurred_at: string;
  body: string;
  body_notice: string | null;
  attachments: { name: string; size: number; type: string }[];
}
export type Cursors = Record<string, { validity: string; uid: number }>;
export interface MailTransport {
  run(
    input: { email: string; password: string; cursors: Cursors },
    save: (
      folder: string,
      cursor: { validity: string; uid: number },
      message: ParsedMail | null,
    ) => Promise<void>,
    discovered: (sentFolder: string | null) => Promise<void>,
    shouldImport: (participants: string[]) => Promise<boolean>,
  ): Promise<void>;
}
const addresses = (value: AddressObject | AddressObject[] | undefined): MailAddress[] =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((x) => x.value)
    .filter((x) => !!x.address)
    .map((x) => ({ address: x.address!.toLowerCase().trim(), name: (x.name || '').slice(0, 200) }));
export async function parseMail(source: Buffer, fallbackDate: Date): Promise<ParsedMail> {
  const parsed = await simpleParser(source, {
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const sender = addresses(parsed.from),
    recipients = addresses(parsed.to),
    cc = addresses(parsed.cc);
  const participants = [
    ...new Set([...sender, ...recipients, ...cc, ...addresses(parsed.bcc)].map((x) => x.address)),
  ];
  let text = parsed.text || '';
  let conversionNotice: string | null = null;
  if (!text && parsed.html) {
    try {
      text = convert(parsed.html, {
        limits: { maxInputLength: 300000, maxDepth: 50 },
        selectors: [{ selector: 'img', format: 'skip' }],
      });
      if (parsed.html.length > 300000)
        conversionNotice = 'HTML 正文过长，已截取；完整内容请在原邮箱查看';
    } catch {
      conversionNotice = '正文无法转换为纯文本，请在原邮箱查看';
    }
  }
  return {
    message_id: mailMessageId(parsed.messageId),
    reply_to: addresses(parsed.replyTo),
    reference_ids: mailReferences(parsed.references || parsed.inReplyTo),
    fingerprint: createHash('sha256').update(source).digest('hex'),
    subject: (parsed.subject || '（无主题）').slice(0, 1000),
    sender,
    recipients,
    cc,
    participants,
    occurred_at: (parsed.date && Number.isFinite(parsed.date.getTime())
      ? parsed.date
      : fallbackDate
    ).toISOString(),
    body: text.slice(0, 100000),
    body_notice:
      text.length > 100000 ? '正文超过 10 万字符，完整内容请在原邮箱查看' : conversionNotice,
    attachments: parsed.attachments.slice(0, 100).map((a) => ({
      name: (a.filename || '未命名附件').slice(0, 500),
      size: a.size,
      type: a.contentType,
    })),
  };
}
export const imapTransport: MailTransport = {
  async run(input, save, discovered, shouldImport) {
    const domain = input.email.split('@')[1];
    if (!['163.com', '126.com', 'yeah.net'].includes(domain))
      throw new Error('unsupported provider');
    const client = new ImapFlow({
      host: `imap.${domain}`,
      port: 993,
      secure: true,
      auth: { user: input.email, pass: input.password },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      disableAutoIdle: true,
      clientInfo: { name: 'Typha CRM', version: '1.0' },
    });
    client.on('error', () => {
      /* No raw provider errors or message data in logs. */
    });
    const deadline = setTimeout(() => client.close(), 120000);
    deadline.unref();
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
      await discovered(sent?.path ?? null);
      for (const folder of [...new Set(['INBOX', ...(sent ? [sent.path] : [])])]) {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          if (!client.mailbox) continue;
          const validity = String(client.mailbox.uidValidity),
            saved = input.cursors[folder];
          const after = saved?.validity === validity ? saved.uid : 0;
          // Search then explicit UIDs avoids IMAP n:* returning the last message when n exceeds max UID.
          const found = await client.search({ uid: `${after + 1}:*` }, { uid: true });
          const uids = (found || [])
            .filter((uid) => uid > after)
            .sort((a, b) => a - b)
            .slice(0, 100);
          for (const uid of uids) {
            const metadata = await client.fetchOne(
              uid,
              { uid: true, envelope: true, size: true, internalDate: true },
              { uid: true },
            );
            if (!metadata) continue;
            const env = metadata.envelope;
            const addr = (values: { address?: string; name?: string }[] | undefined) =>
              (values || [])
                .filter((x) => x.address)
                .map((x) => ({ address: x.address!.toLowerCase().trim(), name: x.name || '' }));
            const envelopeParticipants = [
              ...new Set(
                [
                  ...addr(env?.from),
                  ...addr(env?.to),
                  ...addr(env?.cc),
                  ...addr(env?.bcc),
                  ...addr(env?.sender),
                ].map((x) => x.address),
              ),
            ];
            if (!(await shouldImport(envelopeParticipants))) {
              // Persist the cursor without downloading or storing an excluded message's body.
              await save(folder, { validity, uid }, null);
              continue;
            }
            const date = metadata.internalDate instanceof Date ? metadata.internalDate : new Date();
            let message: ParsedMail;
            if ((metadata.size || 0) <= 2 * 1024 * 1024) {
              const full = await client.fetchOne(uid, { source: true }, { uid: true });
              if (!full || !full.source) throw new Error('message unavailable');
              message = await parseMail(full.source, date);
            } else {
              const sender = addr(env?.from),
                recipients = addr(env?.to),
                cc = addr(env?.cc);
              message = {
                message_id: mailMessageId(env?.messageId),
                reply_to: addr(env?.replyTo),
                fingerprint: createHash('sha256')
                  .update(JSON.stringify({ env, size: metadata.size }))
                  .digest('hex'),
                subject: env?.subject || '（无主题）',
                sender,
                recipients,
                cc,
                participants: [
                  ...new Set(
                    [...sender, ...recipients, ...cc, ...addr(env?.bcc)].map((x) => x.address),
                  ),
                ],
                occurred_at: new Date(env?.date || date).toISOString(),
                body: '',
                body_notice: '邮件超过 2 MB，本次仅同步信封信息；正文与附件请在原邮箱查看',
                attachments: [],
              };
            }
            await save(folder, { validity, uid }, message);
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      clearTimeout(deadline);
      client.close();
    }
  },
};
