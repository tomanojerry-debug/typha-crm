import { crc32, deflateRawSync } from 'node:zlib';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { documentLimits } from '../shared/documents.js';
import { parseDocumentFile, validateDocumentFile } from '../server/document-parser.js';
import { createDocumentDocx, createDocumentPdf } from '../scripts/fixtures/document-upload.js';

// Real, self-contained PDF/OOXML bytes. No model, external converter, customer data or CRM.
function pdf(
  pages: string[],
  extra?: {
    catalog?: string;
    objects?: string[];
    encrypted?: boolean;
    fontSize?: number;
    chinese?: boolean;
  },
) {
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R ${extra?.catalog || ''} >>`,
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    extra?.chinese
      ? '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((text) => {
    const encoded = extra?.chinese
      ? `<${Buffer.from(text, 'utf16le').swap16().toString('hex')}>`
      : `(${text.replace(/[\\()]/g, '\\$&')})`;
    const stream = text ? `BT /F1 ${extra?.fontSize || 12} Tf 20 700 Td ${encoded} Tj ET` : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  if (extra?.chinese)
    objects.push(
      '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>',
      '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
    );
  objects.push(...(extra?.objects || []));
  let encryption = '';
  if (extra?.encrypted) {
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /O <${'11'.repeat(32)}> /U <${'22'.repeat(32)}> /P -4 >>`,
    );
    encryption = `/Encrypt ${objects.length} 0 R /ID [<${'33'.repeat(16)}><${'33'.repeat(16)}>]`;
  }
  let value = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

type ZipEntry = {
  name: string;
  data: Buffer | string;
  deflate?: boolean;
  declaredSize?: number;
  encrypted?: boolean;
};
function zip(entries: ZipEntry[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const payload = entry.deflate ? deflateRawSync(data) : data;
    const compressed = entry.encrypted ? Buffer.concat([Buffer.alloc(12), payload]) : payload;
    const name = Buffer.from(entry.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.declaredSize ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    header.copy(central, 8, 6, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const mainType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
function docx(
  body: string,
  extras: ZipEntry[] = [],
  options?: { type?: string; before?: string; rootTarget?: string; compressed?: boolean },
) {
  return zip([
    {
      name: '[Content_Types].xml',
      deflate: options?.compressed,
      data: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${options?.type || mainType}"/></Types>`,
    },
    {
      name: '_rels/.rels',
      deflate: options?.compressed,
      data: `<Relationships xmlns="${relationNamespace}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${options?.rootTarget || 'word/document.xml'}"/></Relationships>`,
    },
    {
      name: 'word/document.xml',
      deflate: options?.compressed,
      data: `${options?.before || ''}<w:document xmlns:w="${wordNamespace}"><w:body>${body}</w:body></w:document>`,
    },
    ...extras,
  ]);
}
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const input = (data: Buffer, name = '公司介绍.docx') => ({
  name,
  content_base64: data.toString('base64'),
});
const parsePdf = (data: Buffer) => parseDocumentFile(input(data, 'company.pdf'));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

it('extracts real PDF bytes into page-located text and reports the text-only boundary', async () => {
  const data = pdf(['Synthetic Company Introduction', 'Our products are dancewear.']);
  expect(await parsePdf(data)).toEqual({
    format: 'pdf',
    mime: 'application/pdf',
    size: data.length,
    sections: [
      { label: '第 1 页', text: 'Synthetic Company Introduction' },
      { label: '第 2 页', text: 'Our products are dancewear.' },
    ],
    warnings: [expect.stringContaining('图片、图表和版式未解析')],
  });
});

it('extracts Chinese PDF text using only locally bundled Adobe CMaps', async () => {
  const result = await parsePdf(createDocumentPdf(['星澜舞蹈学校（合成）', '公司介绍测试'], true));
  expect(result.sections).toEqual([
    { label: '第 1 页', text: '星澜舞蹈学校（合成）' },
    { label: '第 2 页', text: '公司介绍测试' },
  ]);
});

it('extracts a standard Deflate-compressed DOCX without a text converter or filesystem extraction', async () => {
  const result = await parseDocumentFile(
    input(createDocumentDocx(['星澜舞蹈学校（合成）', '压缩文档正文'])),
  );
  expect(result.sections).toEqual([
    { label: '第 1 段', text: '星澜舞蹈学校（合成）' },
    { label: '第 2 段', text: '压缩文档正文' },
  ]);
});

it('keeps DOCX paragraph locations across blanks, tables, Unicode and line breaks', async () => {
  const data = docx(
    paragraph('星澜舞蹈用品（虚构）') +
      '<w:p/>' +
      '<w:tbl><w:tr><w:tc>' +
      paragraph('主营产品：舞服 &amp; 配件') +
      '</w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:t>上海</w:t><w:tab/><w:t>联系地址</w:t><w:br/><w:t>仅作测试</w:t></w:r></w:p>',
  );
  expect(await parseDocumentFile(input(data))).toMatchObject({
    format: 'docx',
    size: data.length,
    sections: [
      { label: '第 1 段', text: '星澜舞蹈用品（虚构）' },
      { label: '第 3 段', text: '主营产品：舞服 & 配件' },
      { label: '第 4 段', text: '上海\t联系地址\n仅作测试' },
    ],
    warnings: [],
  });
});

it('locates optional DOCX headers separately and does not mix removed revisions into current text', async () => {
  const body =
    '<w:p><w:del><w:r><w:delText>旧称</w:delText></w:r></w:del>' +
    '<w:ins><w:r><w:t>现称</w:t></w:r></w:ins></w:p>';
  const result = await parseDocumentFile(
    input(
      docx(body, [
        {
          name: 'word/header1.xml',
          data: `<x:hdr xmlns:x="${wordNamespace}"><x:p><x:r><x:t>页眉说明</x:t></x:r></x:p></x:hdr>`,
        },
      ]),
    ),
  );
  expect(result.sections).toEqual([
    { label: '第 1 段', text: '现称' },
    { label: '页眉 1 · 第 1 段', text: '页眉说明' },
  ]);
  expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('修订')]));
});

it('warns about DOCX images and ignores external image/hyperlink targets without fetching them', async () => {
  let requests = 0;
  const server = createServer((_, response) => {
    requests++;
    response.end('should never be read');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not start');
  const result = await parseDocumentFile(
    input(
      docx(paragraph('公开公司介绍') + '<w:p><w:r><w:drawing/></w:r></w:p>', [
        {
          name: 'word/_rels/document.xml.rels',
          data: `<Relationships xmlns="${relationNamespace}"><Relationship Id="outside" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://127.0.0.1:${address.port}/external" TargetMode="External"/></Relationships>`,
        },
        { name: 'word/media/image1.png', data: Buffer.from([137, 80, 78, 71]) },
      ]),
    ),
  );
  expect(result.sections).toEqual([{ label: '第 1 段', text: '公开公司介绍' }]);
  expect(result.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining('图片'), expect.stringContaining('外部链接')]),
  );
  expect(requests).toBe(0);
});

it('fails explicitly for image-only/scanned content and identifies empty pages in mixed PDFs', async () => {
  await expect(parsePdf(pdf(['']))).rejects.toThrow('当前不支持 OCR');
  await expect(
    parseDocumentFile(input(docx('<w:p><w:r><w:drawing/></w:r></w:p>'))),
  ).rejects.toThrow('当前不支持 OCR');
  const result = await parsePdf(pdf(['Real text', '']));
  expect(result.sections).toEqual([{ label: '第 1 页', text: 'Real text' }]);
  expect(result.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining('1 页未提取到文字')]),
  );
});

it('rejects DOC, mismatched signatures, noncanonical Base64 and unsafe filenames before parsing', () => {
  expect(() => validateDocumentFile(input(Buffer.from('legacy'), 'old.doc'))).toThrow(
    '另存为 DOCX',
  );
  expect(() =>
    validateDocumentFile(
      input(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'encrypted.docx'),
    ),
  ).toThrow('加密 DOCX');
  expect(() => validateDocumentFile(input(pdf(['test']), 'wrong.docx'))).toThrow('扩展名不一致');
  expect(() => validateDocumentFile(input(docx(paragraph('test')), 'wrong.pdf'))).toThrow(
    '扩展名不一致',
  );
  for (const content_base64 of [
    '',
    'abc',
    'YWJj\n',
    'YR==',
    '=AAA',
    'AAAA===',
    'data:application/pdf;base64,AAAA',
  ])
    expect(() => validateDocumentFile({ name: 'test.pdf', content_base64 })).toThrow(/Base64|编码/);
  for (const name of ['../a.pdf', 'C:\\a.pdf', 'a\u0000.pdf', 'x.pdf.exe'])
    expect(() => validateDocumentFile(input(pdf(['test']), name))).toThrow();
});

it('enforces original size without silently truncating', async () => {
  const data = Buffer.alloc(documentLimits.bytes + 1, 32);
  data.write('%PDF-1.7');
  await expect(parsePdf(data)).rejects.toThrow('10 MiB');
});

it('rejects damaged PDF and encrypted PDF with distinct safe messages', async () => {
  await expect(parsePdf(Buffer.from('%PDF-1.7\nbroken'))).rejects.toThrow('文档已损坏');
  await expect(parsePdf(pdf(['Encrypted text'], { encrypted: true }))).rejects.toThrow('已加密');
});

it('rejects executable PDF JavaScript and embedded file attachments', async () => {
  await expect(
    parsePdf(
      pdf(['script'], {
        catalog: '/Names << /JavaScript << /Names [(test) 6 0 R] >> >>',
        objects: ['<< /S /JavaScript /JS (app.alert\(1\)) >>'],
      }),
    ),
  ).rejects.toThrow('含脚本');
  await expect(
    parsePdf(
      pdf(['attachment'], {
        catalog: '/Names << /EmbeddedFiles << /Names [(hidden.txt) 6 0 R] >> >>',
        objects: [
          '<< /Type /Filespec /F (hidden.txt) /EF << /F 7 0 R >> >>',
          '<< /Type /EmbeddedFile /Length 4 >>\nstream\ntest\nendstream',
        ],
      }),
    ),
  ).rejects.toThrow('嵌入附件');
});

it('rejects PDF page and extracted text limits rather than returning partial success', async () => {
  await expect(parsePdf(pdf(Array.from({ length: 201 }, () => 'page')))).rejects.toThrow(
    '最多 200 页',
  );
  await expect(
    parsePdf(pdf(['A'.repeat(documentLimits.text + 1)], { fontSize: 0.0001 })),
  ).rejects.toThrow('100 万字符');
});

it('rejects DOCX paragraph and text limits rather than returning partial success', async () => {
  await expect(parseDocumentFile(input(docx(paragraph('p').repeat(5001))))).rejects.toThrow(
    '最多 5000 段',
  );
  await expect(
    parseDocumentFile(input(docx(paragraph('文'.repeat(documentLimits.text + 1))))),
  ).rejects.toThrow('100 万字符');
});

it('rejects DOCX ZIP bombs from declared expansion, high compression ratio and falsified entry size', async () => {
  await expect(
    parseDocumentFile(
      input(
        docx(paragraph('valid'), [
          {
            name: 'word/media/large.png',
            data: Buffer.alloc(1),
            deflate: true,
            declaredSize: 51 * 1024 * 1024,
          },
        ]),
      ),
    ),
  ).rejects.toThrow('解压体积');
  await expect(
    parseDocumentFile(
      input(
        docx(paragraph('valid'), [
          {
            name: 'word/media/ratio.png',
            data: Buffer.alloc(2 * 1024 * 1024),
            deflate: true,
          },
        ]),
      ),
    ),
  ).rejects.toThrow('压缩比例');
  await expect(
    parseDocumentFile(
      input(
        docx(paragraph('valid'), [
          {
            name: 'word/media/forged.png',
            data: Buffer.alloc(2 * 1024 * 1024),
            deflate: true,
            declaredSize: 10,
          },
        ]),
      ),
    ),
  ).rejects.toThrow(/文档已损坏|实际解压体积/);
});

it('rejects corrupt ZIP data/CRC, duplicate entries, traversal and encrypted entries', async () => {
  await expect(parseDocumentFile(input(Buffer.from('PK\x03\x04broken')))).rejects.toThrow(
    '文档已损坏',
  );
  const damaged = docx(paragraph('keep-this'));
  const position = damaged.indexOf(Buffer.from('keep-this'));
  damaged[position] = 0x78;
  await expect(parseDocumentFile(input(damaged))).rejects.toThrow('文档已损坏');
  await expect(
    parseDocumentFile(
      input(docx(paragraph('ok'), [{ name: 'word/document.xml', data: '<duplicate/>' }])),
    ),
  ).rejects.toThrow('文档已损坏');
  await expect(
    parseDocumentFile(input(docx(paragraph('ok'), [{ name: '../escape.xml', data: '<escape/>' }]))),
  ).rejects.toThrow('文档已损坏');
  await expect(
    parseDocumentFile(
      input(docx(paragraph('ok'), [{ name: 'private.xml', data: '<private/>', encrypted: true }])),
    ),
  ).rejects.toThrow('已加密');
});

it('rejects DOCX containing macros, embedded objects, external entity declarations or excessive nesting', async () => {
  await expect(
    parseDocumentFile(
      input(
        docx(paragraph('ok'), [], {
          type: 'application/vnd.ms-word.document.macroEnabled.main+xml',
        }),
      ),
    ),
  ).rejects.toThrow('含宏');
  await expect(
    parseDocumentFile(
      input(docx(paragraph('ok'), [{ name: 'word/embeddings/oleObject1.bin', data: 'embedded' }])),
    ),
  ).rejects.toThrow('嵌入对象');
  await expect(parseDocumentFile(input(docx(paragraph('ok') + '<w:altChunk/>')))).rejects.toThrow(
    '外部文档',
  );
  await expect(
    parseDocumentFile(
      input(
        docx(paragraph('&evil;'), [], {
          before: '<!DOCTYPE document [<!ENTITY evil SYSTEM "file:///not-a-real-file">]>',
        }),
      ),
    ),
  ).rejects.toThrow('实体声明');
  await expect(
    parseDocumentFile(
      input(docx('<w:r>'.repeat(129) + paragraph('nested') + '</w:r>'.repeat(129))),
    ),
  ).rejects.toThrow('结构过于复杂');
});

it('rejects a plain ZIP renamed DOCX and a package with the wrong main document relationship', async () => {
  await expect(
    parseDocumentFile(input(zip([{ name: 'hello.txt', data: 'hello' }]))),
  ).rejects.toThrow('文档已损坏');
  await expect(
    parseDocumentFile(input(docx(paragraph('ok'), [], { rootTarget: 'word/other.xml' }))),
  ).rejects.toThrow('文档已损坏');
});
