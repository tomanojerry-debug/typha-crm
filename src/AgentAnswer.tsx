import type { CSSProperties, ReactNode } from 'react';
import './agent-answer.css';

function tableCells(input: string): string[] {
  const line = input.trim();
  const cells: string[] = [];
  let cell = '',
    escaped = false,
    trailingPipe = false;
  for (const character of line) {
    if (escaped) {
      cell += character === '|' ? '|' : `\\${character}`;
      escaped = false;
      trailingPipe = false;
    } else if (character === '\\') {
      escaped = true;
      trailingPipe = false;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
      trailingPipe = true;
    } else {
      cell += character;
      trailingPipe = false;
    }
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  if (line.startsWith('|')) cells.shift();
  if (trailingPipe) cells.pop();
  return cells;
}

function tableHeader(lines: string[], index: number) {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return;
  const headers = tableCells(lines[index]),
    separators = tableCells(lines[index + 1]);
  if (
    headers.length < 2 ||
    headers.length !== separators.length ||
    !separators.every((cell) => /^:?-{3,}:?$/u.test(cell))
  )
    return;
  const alignment: CSSProperties['textAlign'][] = separators.map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left',
  );
  return { headers, alignment };
}

const listItem = (line: string) => line.match(/^\s*(?:([-*+])|(\d+)[.)、])\s+(.+)$/u);

// This renderer creates only React text and fixed elements. Source text cannot
// create HTML, links, images, scripts, attributes, or executable content.
function inlineText(text: string): ReactNode {
  return text
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/gu)
    .map((part, index) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') && part.endsWith('`') ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}

export function AgentAnswer({
  body,
  overview = false,
  fields = false,
}: {
  body: string;
  overview?: boolean;
  fields?: boolean;
}) {
  const lines = body.replace(/\r\n?/gu, '\n').split('\n'),
    blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    const start = index,
      header = tableHeader(lines, index);
    if (header) {
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|')) {
        const cells = tableCells(lines[index]);
        if (cells.length !== header.headers.length) break;
        rows.push(cells);
        index++;
      }
      blocks.push(
        <div
          key={start}
          className="agent-answer-table"
          role="region"
          aria-label="回答中的表格"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                {header.headers.map((cell, column) => (
                  <th key={column} scope="col" style={{ textAlign: header.alignment[column] }}>
                    {inlineText(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td key={column} style={{ textAlign: header.alignment[column] }}>
                      {inlineText(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const item = listItem(lines[index]);
    if (item) {
      const ordered = !!item[2],
        items: string[] = [];
      while (index < lines.length) {
        const next = listItem(lines[index]);
        if (!next || !!next[2] !== ordered) break;
        items.push(next[3]);
        index++;
      }
      blocks.push(
        ordered ? (
          <ol key={start} start={Number(item[2])}>
            {items.map((text, position) => (
              <li key={position}>{inlineText(text)}</li>
            ))}
          </ol>
        ) : (
          <ul key={start}>
            {items.map((text, position) => (
              <li key={position}>{inlineText(text)}</li>
            ))}
          </ul>
        ),
      );
      continue;
    }
    const paragraph = [lines[index++]];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !tableHeader(lines, index) &&
      !listItem(lines[index])
    )
      paragraph.push(lines[index++]);
    // Format literal label/value lines for record cards; preserve every value
    // and leave prose untouched rather than inferring CRM attributes from it.
    const pairs = paragraph.map((line) => {
      const colon = line.search(/[：:]/u);
      return colon > 0 ? [line.slice(0, colon + 1), line.slice(colon + 1)] : null;
    });
    blocks.push(
      fields && paragraph.length > 1 && pairs.every((pair) => pair) ? (
        <dl key={start} className="agent-answer-fields">
          {pairs.map((pair, position) => (
            <div key={position}>
              <dt>{inlineText(pair![0])}</dt>
              <dd>{inlineText(pair![1])}</dd>
            </div>
          ))}
        </dl>
      ) : overview && paragraph.length > 1 && paragraph.every((line) => line.includes('：')) ? (
        <ul key={start}>
          {paragraph.map((line, position) => {
            const colon = line.indexOf('：');
            return (
              <li key={position}>
                <strong>{line.slice(0, colon + 1)}</strong>
                {inlineText(line.slice(colon + 1))}
              </li>
            );
          })}
        </ul>
      ) : (
        <p key={start}>{inlineText(paragraph.join('\n'))}</p>
      ),
    );
  }
  return <div className="agent-answer chat-reply-text">{blocks}</div>;
}
