import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { fromBufferPromise, type Entry } from 'yauzl';
import { documentLimits, type DocumentFormat, type DocumentSection } from '../shared/documents.js';
import { ApiError } from './security.js';

const require = createRequire(import.meta.url);
export const documentParserLimits = {
  ...documentLimits,
  paragraphs: 5000,
  entries: 1000,
  expandedBytes: 50 * 1024 * 1024,
  xmlBytes: 8 * 1024 * 1024,
  xmlDepth: 128,
  timeoutMs: 30_000,
};
const mimeTypes = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;
type DocumentInput = { name: string; content_base64: string };
export interface ParsedDocumentFile {
  format: DocumentFormat;
  mime: string;
  size: number;
  sections: DocumentSection[];
  warnings: string[];
}
type ExtractedDocument = Pick<ParsedDocumentFile, 'sections' | 'warnings'>;
const invalidDocument = () =>
  new ApiError(400, '文档已损坏或格式不受支持，请重新导出 PDF／DOCX 后上传');

/** Validate before allocating the decoded original; never interpret a filename as a path. */
export function validateDocumentFile(input: DocumentInput) {
  if (
    !input ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 240 ||
    /[\u0000-\u001f\u007f/\\]/.test(input.name)
  )
    throw new ApiError(400, '文件名无效，请使用不含路径的 PDF／DOCX 文件名');
  if (/\.doc$/i.test(input.name))
    throw new ApiError(400, '暂不支持旧版 DOC，请在 Word 中另存为 DOCX 或文字 PDF 后上传');
  const extension = /\.(pdf|docx)$/i.exec(input.name)?.[1].toLowerCase() as
    DocumentFormat | undefined;
  if (!extension) throw new ApiError(400, '当前仅支持文字 PDF 和 DOCX 文件');
  const encoded = input.content_base64;
  if (typeof encoded !== 'string' || !encoded.length)
    throw new ApiError(400, '文件内容为空或 Base64 编码无效');
  if (encoded.length > Math.ceil(documentLimits.bytes / 3) * 4)
    throw new ApiError(413, '单个文件最多 10 MiB');
  // Buffer.from is intentionally permissive; require canonical padded Base64 instead.
  if (
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    (encoded.indexOf('=') !== -1 && encoded.indexOf('=') < encoded.length - 2)
  )
    throw new ApiError(400, '文件 Base64 编码无效，请重新选择文件');
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.toString('base64') !== encoded)
    throw new ApiError(400, '文件 Base64 编码无效，请重新选择文件');
  if (data.length > documentLimits.bytes) throw new ApiError(413, '单个文件最多 10 MiB');
  const pdf = /^%PDF-\d\.\d/.test(data.subarray(0, 8).toString('ascii'));
  const zip = data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
  if (
    extension === 'docx' &&
    data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  )
    throw new ApiError(400, '文件可能是加密 DOCX 或旧版 Word，请移除密码并另存为 DOCX 后上传');
  if ((extension === 'pdf' && !pdf) || (extension === 'docx' && !zip))
    throw new ApiError(400, '文件内容与扩展名不一致，请上传原始 PDF／DOCX 文件');
  return { format: extension, mime: mimeTypes[extension], size: data.length, data };
}

// Loading only our own source through the same TS runtime as the server keeps the worker
// independent of the caller's loader (including Vitest). Uploaded content is never code.
const workerBootstrap = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.tsxUrl)
  .then(({ tsImport }) => tsImport(workerData.parserUrl, workerData.parserUrl))
  .catch(() => parentPort.postMessage({ error: '文档解析器启动失败，请稍后重试' }));
`;

/** Parse off the HTTP event loop, with bounded heap and a terminable wall-clock deadline. */
export async function parseDocumentFile(input: DocumentInput): Promise<ParsedDocumentFile> {
  const validated = validateDocumentFile(input);
  const data = Uint8Array.from(validated.data);
  const extracted = await new Promise<ExtractedDocument>((resolve, reject) => {
    const worker = new Worker(workerBootstrap, {
      eval: true,
      execArgv: [],
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      workerData: {
        lightCrmDocumentParser: true,
        parserUrl: import.meta.url,
        tsxUrl: require.resolve('tsx/esm/api'),
        format: validated.format,
        data,
      },
      transferList: [data.buffer],
    });
    // Library diagnostics may contain document strings. Keep them out of application logs.
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const finish = (error?: string, result?: ExtractedDocument) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(new ApiError(400, error));
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish('文档解析超时，请拆分文件后重试'),
      documentParserLimits.timeoutMs,
    );
    worker.once('message', (message: { error?: string; result?: ExtractedDocument }) => {
      if (message.error) finish(message.error);
      else if (message.result) finish(undefined, message.result);
      else finish('文档解析失败，请重新导出文件后重试');
    });
    worker.once('error', () => finish('文档过于复杂或解析失败，请拆分或重新导出后重试'));
    worker.once('exit', () => finish('文档解析中断，请重试'));
  });
  return {
    format: validated.format,
    mime: validated.mime,
    size: validated.size,
    ...extracted,
  };
}

function textLimit(size: number) {
  if (size > documentLimits.text)
    throw new ApiError(413, '文档展开文字超过 100 万字符，请拆分后上传');
}

async function parsePdf(data: Uint8Array): Promise<ExtractedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bundle = dirname(require.resolve('pdfjs-dist/package.json'));
  // PDF.js may request its predefined CMaps/fonts. Permit only flat filenames inside
  // these bundled directories, never a document-supplied URL or filesystem path.
  class BundledBinaryDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      const directory = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts' }[kind];
      if (!directory || !/^[A-Za-z0-9_+.-]+$/.test(filename) || filename.includes('..'))
        throw new Error('External document resources are disabled');
      return new Uint8Array(await readFile(join(bundle, directory, filename)));
    }
  }
  const task = pdfjs.getDocument({
    data,
    stopAtErrors: true,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: 0,
    cMapUrl: `${bundle}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${bundle}/standard_fonts/`,
    BinaryDataFactory: BundledBinaryDataFactory,
  });
  try {
    const document = await task.promise;
    if (document.numPages > documentLimits.pages)
      throw new ApiError(413, 'PDF 最多 200 页，请拆分后上传');
    if (document.isPureXfa || (await document.hasJSActions()))
      throw new ApiError(400, '不支持含脚本或动态表单的 PDF，请导出静态文字 PDF 后上传');
    if ((await document.getAttachments())?.size)
      throw new ApiError(400, '不支持含嵌入附件的 PDF，请移除嵌入对象后上传');
    const sections: DocumentSection[] = [];
    let total = 0;
    let emptyPages = 0;
    let externalLinks = false;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const annotations = await page.getAnnotations();
      if (
        annotations.some((a) =>
          ['FileAttachment', 'RichMedia', 'Movie', 'Sound', 'Screen', '3D'].includes(a.subtype),
        )
      )
        throw new ApiError(400, '不支持含嵌入对象的 PDF，请导出静态文字 PDF 后上传');
      externalLinks ||= annotations.some((a) => a.url || a.unsafeUrl);
      const reader = page.streamTextContent({ disableNormalization: true }).getReader();
      const parts: string[] = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!('str' in item)) continue;
            const text = item.str + (item.hasEOL ? '\n' : ' ');
            total += text.length;
            textLimit(total);
            parts.push(text);
          }
        }
      } finally {
        reader.releaseLock();
      }
      const text = parts
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
      if (text) sections.push({ label: `第 ${index} 页`, text });
      else emptyPages++;
      page.cleanup();
    }
    if (!sections.length)
      throw new ApiError(
        400,
        'PDF 中没有可提取的文字，可能是扫描件；当前不支持 OCR，请上传文字 PDF 或 DOCX',
      );
    return {
      sections,
      warnings: [
        '仅提取可复制文字；图片、图表和版式未解析，未进行 OCR。',
        ...(emptyPages ? [`有 ${emptyPages} 页未提取到文字，请核对是否包含扫描页或图片。`] : []),
        ...(externalLinks ? ['外部链接仅保留显示文字，没有访问链接或加载外部资源。'] : []),
      ],
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'PasswordException')
      throw new ApiError(400, 'PDF 已加密或需要密码，请移除密码后上传');
    throw invalidDocument();
  } finally {
    await task.destroy();
  }
}

const wordNamespaces = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const contentTypeNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const docxContentType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
function attribute(tag: SaxesTagNS, local: string) {
  return Object.values(tag.attributes).find((a) => a.local === local)?.value;
}

function readXml(
  xml: Buffer,
  onOpen: (tag: SaxesTagNS) => void,
  handlers?: {
    close?: (tag: SaxesTagNS) => void;
    text?: (text: string) => void;
  },
) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(xml);
  } catch {
    throw new ApiError(400, 'DOCX 内部文字编码无效，请在 Word 中重新另存为 DOCX 后上传');
  }
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  parser.on('doctype', () => {
    throw new ApiError(400, 'DOCX 包含不允许的 XML 文档类型或实体声明');
  });
  parser.on('error', () => {
    throw invalidDocument();
  });
  parser.on('opentag', (tag) => {
    if (++depth > documentParserLimits.xmlDepth || Object.keys(tag.attributes).length > 100)
      throw new ApiError(400, 'DOCX 结构过于复杂，请重新导出后上传');
    onOpen(tag);
  });
  parser.on('closetag', (tag) => {
    handlers?.close?.(tag);
    depth--;
  });
  parser.on('text', (value) => handlers?.text?.(value));
  parser.on('cdata', (value) => handlers?.text?.(value));
  for (let offset = 0; offset < text.length; offset += 65536)
    parser.write(text.slice(offset, offset + 65536));
  parser.close();
}

async function parseDocx(data: Uint8Array): Promise<ExtractedDocument> {
  const zip = await fromBufferPromise(Buffer.from(data), {
    lazyEntries: true,
    validateEntrySizes: true,
    strictFileNames: true,
    autoClose: false,
  });
  const warnings = new Set<string>();
  const entries: Entry[] = [];
  const names = new Set<string>();
  let expanded = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= documentParserLimits.entries)
        throw new ApiError(413, 'DOCX 内部文件过多，请简化后上传');
      const name = entry.fileName;
      if (names.has(name.toLowerCase())) throw invalidDocument();
      names.add(name.toLowerCase());
      if (entry.isEncrypted()) throw new ApiError(400, 'DOCX 已加密，请移除密码后上传');
      if (
        /(?:^|\/)(?:embeddings|activex|customui)(?:\/|$)/i.test(name) ||
        /vbaproject|\.(?:exe|dll|com|bat|cmd|ps1|vbs|js|jar|scr|msi)$/i.test(name)
      )
        throw new ApiError(400, 'DOCX 含宏、程序或嵌入对象，请移除后重新上传');
      expanded += entry.uncompressedSize;
      if (
        expanded > documentParserLimits.expandedBytes ||
        (entry.uncompressedSize > 1024 * 1024 &&
          entry.uncompressedSize > entry.compressedSize * 200)
      )
        throw new ApiError(413, 'DOCX 解压体积或压缩比例超限，请简化后上传');
      if (/\.(?:xml|rels)$/i.test(name) && entry.uncompressedSize > documentParserLimits.xmlBytes)
        throw new ApiError(413, 'DOCX 内部 XML 文字过大，请拆分后上传');
      entries.push(entry);
    }
    const xmlFiles = new Map<string, Buffer>();
    let actualExpanded = 0;
    for (const entry of entries) {
      if (entry.fileName.endsWith('/')) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      let checksum = 0;
      const isXml = /\.(?:xml|rels)$/i.test(entry.fileName);
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          actualExpanded += bytes.length;
          if (
            size > entry.uncompressedSize ||
            actualExpanded > documentParserLimits.expandedBytes ||
            (isXml && size > documentParserLimits.xmlBytes)
          )
            throw new ApiError(413, 'DOCX 实际解压体积超限，请简化后上传');
          checksum = crc32(bytes, checksum);
          if (isXml) chunks.push(bytes);
        }
      } finally {
        stream.destroy();
      }
      if (checksum !== entry.crc32 || size !== entry.uncompressedSize) throw invalidDocument();
      if (isXml) xmlFiles.set(entry.fileName, Buffer.concat(chunks));
      if (/^word\/media\//i.test(entry.fileName))
        warnings.add('图片、图表和嵌入图形未解析，未进行 OCR。');
    }
    const types = xmlFiles.get('[Content_Types].xml');
    const main = xmlFiles.get('word/document.xml');
    const rootRelationships = xmlFiles.get('_rels/.rels');
    if (!types || !main || !rootRelationships) throw invalidDocument();
    let mainType = false;
    readXml(types, (tag) => {
      const type = attribute(tag, 'ContentType') || '';
      if (/macroenabled|vba|oleobject|activex/i.test(type))
        throw new ApiError(400, 'DOCX 含宏或嵌入对象，请移除后上传');
      if (
        tag.uri === contentTypeNamespace &&
        tag.local === 'Override' &&
        attribute(tag, 'PartName') === '/word/document.xml' &&
        type === docxContentType
      )
        mainType = true;
    });
    if (!mainType) throw invalidDocument();
    let officeDocument = false;
    for (const [name, xml] of xmlFiles) {
      if (!name.endsWith('.rels')) continue;
      readXml(xml, (tag) => {
        if (tag.uri !== relationshipNamespace || tag.local !== 'Relationship') return;
        const type = attribute(tag, 'Type') || '';
        if (/\/oleObject$|\/package$|\/vbaProject$|\/control$|\/aFChunk$/i.test(type))
          throw new ApiError(400, 'DOCX 含嵌入对象或外部文档，请移除后上传');
        const external = attribute(tag, 'TargetMode')?.toLowerCase() === 'external';
        if (external) warnings.add('外部链接与资源未访问；仅提取文档内已有的显示文字。');
        if (
          name === '_rels/.rels' &&
          /\/officeDocument$/.test(type) &&
          !external &&
          attribute(tag, 'Target')?.replace(/^\//, '') === 'word/document.xml'
        )
          officeDocument = true;
      });
    }
    if (!officeDocument) throw invalidDocument();
    const sections: DocumentSection[] = [];
    let totalParagraphs = 0;
    let totalText = 0;
    const stories = [...xmlFiles]
      .filter(([name]) =>
        /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name),
      )
      .sort(([a], [b]) =>
        a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b),
      );
    for (const [name, xml] of stories) {
      const storyName =
        name === 'word/document.xml'
          ? ''
          : name.includes('header')
            ? `页眉 ${/\d+/.exec(name)?.[0]} · `
            : name.includes('footer')
              ? `页脚 ${/\d+/.exec(name)?.[0]} · `
              : name.includes('footnotes')
                ? '脚注 · '
                : '尾注 · ';
      let paragraphIndex = 0;
      const paragraphs: { index: number; parts: string[] }[] = [];
      let textDepth = 0;
      let deletedDepth = 0;
      readXml(
        xml,
        (tag) => {
          if (['OLEObject', 'object', 'altChunk'].includes(tag.local))
            throw new ApiError(400, 'DOCX 含嵌入对象或外部文档，请移除后上传');
          if (['drawing', 'pict', 'graphic'].includes(tag.local))
            warnings.add('图片、图表和嵌入图形未解析，未进行 OCR。');
          if (!wordNamespaces.has(tag.uri)) return;
          if (tag.local === 'p') {
            if (++totalParagraphs > documentParserLimits.paragraphs)
              throw new ApiError(413, 'DOCX 最多 5000 段，请拆分后上传');
            paragraphs.push({ index: ++paragraphIndex, parts: [] });
          }
          if (tag.local === 'del' || tag.local === 'moveFrom') deletedDepth++;
          if (['del', 'ins', 'moveFrom', 'moveTo'].includes(tag.local))
            warnings.add('文档含修订：提取插入与当前文字，删除及移出文字未作为正文。');
          if (tag.local === 't') textDepth++;
          if (!deletedDepth && paragraphs.length && ['tab', 'br', 'cr'].includes(tag.local)) {
            paragraphs.at(-1)!.parts.push(tag.local === 'tab' ? '\t' : '\n');
            totalText++;
            textLimit(totalText);
          }
          if (tag.local === 'instrText')
            warnings.add('Word 域指令未执行，仅提取文件内已有的显示文字。');
        },
        {
          text(value) {
            if (!textDepth || deletedDepth || !paragraphs.length) return;
            totalText += value.length;
            textLimit(totalText);
            paragraphs.at(-1)!.parts.push(value);
          },
          close(tag) {
            if (!wordNamespaces.has(tag.uri)) return;
            if (tag.local === 't') textDepth--;
            if (tag.local === 'del' || tag.local === 'moveFrom') deletedDepth--;
            if (tag.local === 'p') {
              const paragraph = paragraphs.pop()!;
              const text = paragraph.parts.join('').trim();
              if (text) sections.push({ label: `${storyName}第 ${paragraph.index} 段`, text });
            }
          },
        },
      );
    }
    if (!sections.length)
      throw new ApiError(400, 'DOCX 中没有可提取的正文文字，可能仅包含图片；当前不支持 OCR');
    return { sections, warnings: [...warnings] };
  } finally {
    zip.close();
  }
}

if (!isMainThread && workerData?.lightCrmDocumentParser === true) {
  // The parsers work exclusively on provided bytes. Do not permit network fetches,
  // including attempted external relationships, font URLs or embedded hyperlinks.
  globalThis.fetch = async () => {
    throw new Error('External document resources are disabled');
  };
  const parse = workerData.format === 'pdf' ? parsePdf : parseDocx;
  parse(workerData.data as Uint8Array)
    .then((result) => parentPort!.postMessage({ result }))
    .catch((error: unknown) =>
      parentPort!.postMessage({
        error: error instanceof ApiError ? error.message : invalidDocument().message,
      }),
    );
}
