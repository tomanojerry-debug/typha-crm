import { describe, expect, it } from 'vitest';
import { catalog } from '../server/reports.js';
import type { Context } from '../server/security.js';
import {
  instantiateReportWidgets,
  reportCsvCell,
  reportTemplates,
} from '../src/report-templates.js';

describe('report CSV export', () => {
  it('quotes cells and preserves commas, newlines, Chinese text and literal quotes', () => {
    expect(reportCsvCell('客户, "甲"\n第二行')).toBe('"客户, ""甲""\n第二行"');
    expect(reportCsvCell(null)).toBe('""');
    expect(reportCsvCell(undefined)).toBe('""');
    expect(reportCsvCell(0)).toBe('"0"');
    expect(reportCsvCell(false)).toBe('"false"');
  });

  it.each([
    '=HYPERLINK("https://example.invalid")',
    '+SUM(1,2)',
    '-2+3',
    '@SUM(1,2)',
    '  =1+1',
    '\t=1+1',
    '\r=1+1',
    '\n=1+1',
  ])('neutralizes spreadsheet formula prefixes in %j', (value) => {
    expect(reportCsvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
  });

  it('keeps ordinary customer names and data as plain quoted values', () => {
    expect(reportCsvCell('芭蕾舞服经销商')).toBe('"芭蕾舞服经销商"');
    expect(reportCsvCell('client@example.invalid')).toBe('"client@example.invalid"');
    expect(reportCsvCell(1234.5)).toBe('"1234.5"');
  });
});

describe('report starter template contracts', () => {
  it('instantiates templates and copies with fresh server-compatible UUIDs', () => {
    const first = instantiateReportWidgets(reportTemplates[0].widgets);
    const second = instantiateReportWidgets(first);
    for (const [index, widget] of first.entries()) {
      expect(widget.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(second[index].id).not.toBe(widget.id);
      expect({ ...widget, id: '' }).toEqual({ ...reportTemplates[0].widgets[index], id: '' });
    }
  });
  it('uses fields from the actual server catalog, with no required business configuration', async () => {
    // No customers or custom fields are needed to construct the base catalog.
    // This exercises the service's source/field definitions instead of copying
    // a second allowlist into the test.
    const ctx = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      actorId: '00000000-0000-4000-8000-000000000002',
      role: 'admin',
      tx: { query: async () => ({ rows: [] }) },
    } as unknown as Context;
    const available = await catalog(ctx);
    expect(reportTemplates).toHaveLength(3);
    for (const template of reportTemplates) {
      expect(template.widgets.length).toBeGreaterThan(0);
      expect(new Set(template.widgets.map((widget) => widget.id)).size).toBe(
        template.widgets.length,
      );
      for (const widget of template.widgets) {
        const source = available.sources.find((item) => item.id === widget.source);
        expect(source, `${template.name}: ${widget.title}`).toBeDefined();
        if (widget.groupBy !== 'none') {
          expect(source?.fields.some((field) => field.id === widget.groupBy)).toBe(true);
        }
        if (widget.visualization === 'line') {
          expect(source?.fields.find((field) => field.id === widget.groupBy)?.kind).toBe('date');
        }
        expect(['count', 'distinct_customers']).toContain(widget.metric);
        expect(widget.metricField).toBeUndefined();
      }
    }
  });
});
