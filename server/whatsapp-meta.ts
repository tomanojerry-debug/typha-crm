import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './security.js';
import type { WhatsAppInboxConfig, WhatsAppIncomingMessage } from './whatsapp-inbox.js';

const maxIdentifierLength = 250;
const maxSenderNameLength = 120;
const maxTextLength = 8000;
const invalidUnicode = /[\uD800-\uDFFF]/u;
const controlCharacters = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalidPayload(): never {
  throw new ApiError(400, 'WhatsApp 通知格式无效');
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxIdentifierLength &&
    !/[\s\u0000-\u001F\u007F-\u009F]/u.test(value) &&
    !invalidUnicode.test(value)
  );
}

export function verifyWhatsAppChallenge(config: WhatsAppInboxConfig, query: unknown): string {
  const input = objectOrNull(query);
  const challenge = input?.['hub.challenge'];
  if (
    input?.['hub.mode'] !== 'subscribe' ||
    typeof challenge !== 'string' ||
    challenge.trim().length === 0 ||
    challenge.length > 128 ||
    controlCharacters.test(challenge) ||
    invalidUnicode.test(challenge)
  ) {
    throw new ApiError(400, 'WhatsApp 回调验证参数无效');
  }

  const token = input['hub.verify_token'];
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 512 ||
    !timingSafeEqual(
      createHash('sha256').update(token).digest(),
      createHash('sha256').update(config.verifyToken).digest(),
    )
  ) {
    throw new ApiError(403, 'WhatsApp 回调验证失败');
  }
  return challenge;
}

function senderName(contacts: unknown, scopedId?: string, phone?: string): string | null {
  if (!Array.isArray(contacts)) return null;

  // Match the business-scoped ID first. A phone-only contact can supply a name
  // when its phone matches and it does not report a conflicting scoped ID.
  const candidates = contacts.map(objectOrNull).filter((contact) => contact !== null);
  const scopedMatch = scopedId && candidates.find((contact) => contact.user_id === scopedId);
  const phoneMatch =
    phone &&
    candidates.find(
      (contact) =>
        contact.wa_id === phone &&
        (!scopedId || contact.user_id === undefined || contact.user_id === scopedId),
    );
  const contact = scopedMatch || phoneMatch;
  const name = contact && objectOrNull(contact.profile)?.name;
  if (
    typeof name !== 'string' ||
    name.length > maxSenderNameLength ||
    controlCharacters.test(name) ||
    invalidUnicode.test(name)
  ) {
    return null;
  }
  return name.trim() || null;
}

function normalizeMessage(raw: unknown, contacts: unknown): WhatsAppIncomingMessage | null {
  const message = objectOrNull(raw);
  if (!message || typeof message.type !== 'string') invalidPayload();
  if (message.type !== 'text' || message.group_id !== undefined) return null;

  const messageId = message.id;
  const scopedId = message.from_user_id;
  const phone = message.from;
  const id = scopedId ?? phone;
  const timestamp = message.timestamp;
  const text = objectOrNull(message.text)?.body;
  if (
    !identifier(messageId) ||
    !identifier(id) ||
    typeof timestamp !== 'string' ||
    !/^[0-9]{1,12}$/.test(timestamp) ||
    Number(timestamp) > 253402300799 ||
    typeof text !== 'string' ||
    text.length > maxTextLength ||
    text.trim().length === 0 ||
    text.includes('\0') ||
    invalidUnicode.test(text)
  ) {
    invalidPayload();
  }

  return {
    messageId,
    senderId: id,
    senderName: senderName(
      contacts,
      identifier(scopedId) ? scopedId : undefined,
      identifier(phone) ? phone : undefined,
    ),
    occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
    text,
  };
}

export function parseWhatsAppWebhook(
  config: WhatsAppInboxConfig,
  raw: Buffer,
  signature: string | undefined,
): WhatsAppIncomingMessage[] {
  if (
    typeof signature !== 'string' ||
    signature.length !== 71 ||
    !/^sha256=[0-9a-fA-F]{64}$/.test(signature) ||
    !timingSafeEqual(
      createHmac('sha256', config.appSecret).update(raw).digest(),
      Buffer.from(signature.slice(7), 'hex'),
    )
  ) {
    throw new ApiError(403, 'WhatsApp 通知签名验证失败');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(raw));
  } catch {
    invalidPayload();
  }
  const payload = objectOrNull(parsed);
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    invalidPayload();
  }

  const messages: WhatsAppIncomingMessage[] = [];
  for (const rawEntry of payload.entry) {
    const entry = objectOrNull(rawEntry);
    if (!entry || !identifier(entry.id)) invalidPayload();
    if (entry.id !== config.wabaId) continue;
    if (!Array.isArray(entry.changes)) invalidPayload();

    for (const rawChange of entry.changes) {
      const change = objectOrNull(rawChange);
      if (!change || typeof change.field !== 'string') invalidPayload();
      if (change.field !== 'messages') continue;

      const value = objectOrNull(change.value);
      if (!value) invalidPayload();
      // Status updates have no messages to ingest.
      if (value.messages === undefined) continue;
      const phoneNumberId = objectOrNull(value.metadata)?.phone_number_id;
      if (!identifier(phoneNumberId)) invalidPayload();
      if (phoneNumberId !== config.phoneNumberId) continue;
      if (!Array.isArray(value.messages)) invalidPayload();

      for (const rawMessage of value.messages) {
        const message = normalizeMessage(rawMessage, value.contacts);
        if (message) messages.push(message);
      }
    }
  }

  // Validate the entire delivery before the caller starts a database transaction.
  return messages;
}
