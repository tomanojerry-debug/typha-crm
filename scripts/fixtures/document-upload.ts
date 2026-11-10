import { crc32, deflateRawSync } from 'node:zlib';

// Small, real PDF/OOXML fixtures for isolated upload verification. Never customer data.
// PDF text uses only standard fonts and predefined CMaps; no images, scripts or URLs.
export function createDocumentPdf(pages: string[], chinese = false): Buffer {
  if (!pages.length) throw new Error('A fixture PDF needs at least one page');
  const unicode = chinese || pages.some((page) => /[^\x00-\x7f]/.test(page));
  const descendantId = 4 + pages.length * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    unicode
      ? `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${descendantId} 0 R] >>`
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((page) => {
    const lines = page.split(/\r?\n/).flatMap((line) => {
      const characters = [...line];
      const width = unicode ? 48 : 90;
      const wrapped: string[] = [];
      for (let index = 0; index < characters.length; index += width)
        wrapped.push(characters.slice(index, index + width).join(''));
      return wrapped.length ? wrapped : [''];
    });
    if (lines.length > 52) throw new Error('Split the fixture into more pages (52 lines per page)');
    const stream = lines
      .map((line, index) => {
        const value = unicode
          ? `<${Buffer.from(line, 'utf16le').swap16().toString('hex')}>`
          : `(${line.replace(/[\\()]/g, '\\$&')})`;
        return `BT /F1 10 Tf 32 ${790 - index * 14} Td ${value} Tj ET`;
      })
      .join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  if (unicode)
    objects.push(
      `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${descendantId + 1} 0 R /DW 1000 >>`,
      '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
    );
  let value = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function createDocumentDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((paragraph) => {
      const text = paragraph
        .split(/(\t|\r?\n)/)
        .map((part) => {
          if (part === '\t') return '<w:tab/>';
          if (/^\r?\n$/.test(part)) return '<w:br/>';
          return `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
        })
        .join('');
      return `<w:p><w:r>${text}</w:r></w:p>`;
    })
    .join('');
  const entries = [
    {
      name: '[Content_Types].xml',
      value:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      value:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      value: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.value);
    const compressed = deflateRawSync(data);
    const name = Buffer.from(entry.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
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
