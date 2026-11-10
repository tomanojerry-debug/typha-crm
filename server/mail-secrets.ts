import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
export async function mailKey(options: { production?: boolean; key?: string; path?: string } = {}) {
  if (options.key) {
    const key = Buffer.from(options.key, 'base64');
    if (key.length !== 32) throw new Error('MAIL_ENCRYPTION_KEY 必须是 32 字节的 base64 密钥');
    return key;
  }
  if (options.production) return undefined;
  const path = resolve(options.path ?? '.local/mail-encryption.key');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  await chmod(path, 0o600);
  const key = await readFile(path);
  if (key.length !== 32) throw new Error('本机邮箱密钥损坏，请恢复备份');
  return key;
}
export function seal(secret: string, key: Buffer, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((x) => x.toString('base64')).join('.');
}
export function unseal(value: string, key: Buffer, context: string) {
  const [iv, tag, body] = value.split('.').map((x) => Buffer.from(x, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
