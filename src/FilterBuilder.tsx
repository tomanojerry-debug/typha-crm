import { Plus, X } from 'lucide-react';
import {
  filterFields,
  fieldOperators,
  operatorLabels,
  type FilterGroup,
  type FilterRule,
} from '../shared/filters';
import type { RecordObject } from '../shared/views';
import type { Member } from '../shared/domain';
export function FilterBuilder({
  object,
  value,
  members,
  onChange,
}: {
  object: RecordObject;
  value: FilterGroup;
  members: Member[];
  onChange: (value: FilterGroup) => void;
}) {
  const fields = filterFields(object);
  function patch(index: number, change: Partial<FilterRule>) {
    onChange({
      ...value,
      rules: value.rules.map((r, i) => (i === index ? { ...r, ...change } : r)),
    });
  }
  return (
    <div className="filter-builder">
      <label className="filter-match">
        满足
        <select
          aria-label="筛选匹配方式"
          value={value.match}
          onChange={(e) => onChange({ ...value, match: e.target.value as 'all' | 'any' })}
        >
          <option value="all">全部条件（AND）</option>
          <option value="any">任一条件（OR）</option>
        </select>
      </label>
      {value.rules.map((rule, index) => {
        const field = fields[rule.field];
        const options =
          field?.kind === 'member'
            ? {
                me: '当前用户',
                ...Object.fromEntries(members.map((m) => [m.actor_id, m.display_name])),
              }
            : field?.options;
        return (
          <div className="filter-rule" key={index}>
            <select
              aria-label={`条件 ${index + 1} 字段`}
              value={rule.field}
              onChange={(e) => {
                const f = fields[e.target.value];
                patch(index, {
                  field: e.target.value,
                  operator: fieldOperators(f.kind)[0],
                  value:
                    f.kind === 'member'
                      ? 'me'
                      : f.kind === 'date'
                        ? new Date().toISOString().slice(0, 10)
                        : Object.keys(f.options || {})[0] || '',
                });
              }}
            >
              {Object.entries(fields).map(([k, f]) => (
                <option key={k} value={k}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              aria-label={`条件 ${index + 1} 运算符`}
              value={rule.operator}
              onChange={(e) => patch(index, { operator: e.target.value as FilterRule['operator'] })}
            >
              {fieldOperators(field?.kind || 'text').map((k) => (
                <option key={k} value={k}>
                  {operatorLabels[k]}
                </option>
              ))}
            </select>
            {!['empty', 'not_empty'].includes(rule.operator) &&
              (options ? (
                <select
                  aria-label={`条件 ${index + 1} 值`}
                  value={rule.value}
                  onChange={(e) => patch(index, { value: e.target.value })}
                >
                  {Object.entries(options).map(([k, v]) => (
                    <option value={k} key={k}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={`条件 ${index + 1} 值`}
                  type={field?.kind === 'date' ? 'date' : 'text'}
                  value={rule.value}
                  maxLength={200}
                  placeholder="输入条件值"
                  onChange={(e) => patch(index, { value: e.target.value })}
                />
              ))}
            <button
              className="icon-button"
              aria-label={`移除条件 ${index + 1}`}
              onClick={() =>
                onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) })
              }
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      <button
        className="text-button"
        disabled={value.rules.length >= 20}
        onClick={() =>
          onChange({
            ...value,
            rules: [...value.rules, { field: 'name', operator: 'contains', value: '' }],
          })
        }
      >
        <Plus size={13} />
        添加筛选条件
      </button>
      {!value.rules.length && (
        <p className="popover-caption">选择任意属性设置条件，支持组合筛选。</p>
      )}
    </div>
  );
}
