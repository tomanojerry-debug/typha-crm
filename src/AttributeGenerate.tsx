import { useEffect, useRef, useState } from 'react';
import {
  isEmptyAttributeValue,
  type AttributeRun,
  type CompanyAttribute,
  type CompanyAttributeValue,
} from '../shared/attributes';
import { api, HttpError } from './api';

export type AttributeCompany = {
  id: string;
  name: string;
  can_edit: boolean;
  archived_at: string | null;
};
export type AttributeJob = {
  customer: AttributeCompany;
  attributeId: string;
  status: 'queued' | 'generating' | 'saving' | 'saved' | 'empty' | 'skipped' | 'stopped' | 'error';
  message?: string;
};
export const attributeJobKey = (customer: string, attribute: string) => `${customer}:${attribute}`;
export const attributeJobBusy = (job?: AttributeJob) =>
  !!job && ['queued', 'generating', 'saving'].includes(job.status);

// Each company gets its own generation and version-checked write. A result is
// applied immediately; no customer data or model context is combined in a batch.
export async function fillAttributeCells({
  workspace,
  field,
  customers,
  values,
  signal,
  onJob,
  onSaved,
  request = api,
}: {
  workspace: string;
  field: CompanyAttribute;
  customers: AttributeCompany[];
  values: CompanyAttributeValue[];
  signal: AbortSignal;
  onJob: (job: AttributeJob) => void;
  onSaved: (value: CompanyAttributeValue) => void;
  request?: typeof api;
}) {
  const rows = Array.from(new Map(customers.slice(0, 30).map((c) => [c.id, c])).values()).map(
    (customer): AttributeJob => {
      const current = values.find(
        (v) => v.customer_id === customer.id && v.attribute_id === field.id,
      );
      const reason = customer.archived_at
        ? '公司已归档'
        : !customer.can_edit
          ? '没有编辑权限'
          : !isEmptyAttributeValue(current?.value)
            ? '已有内容，已保留'
            : undefined;
      return {
        customer,
        attributeId: field.id,
        status: reason ? 'skipped' : 'queued',
        message: reason,
      };
    },
  );
  rows.forEach(onJob);
  const pending = rows.filter((r) => r.status === 'queued');
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const update = (status: AttributeJob['status'], message?: string) =>
      onJob({ ...row, status, message });
    if (signal.aborted) {
      pending.slice(i).forEach((r) => onJob({ ...r, status: 'stopped' }));
      break;
    }
    let applying = false;
    update('generating');
    try {
      const run = await request<AttributeRun>(`/customers/${row.customer.id}/attribute-runs`, {
        workspace,
        method: 'POST',
        signal,
        body: {
          attribute_id: field.id,
          attribute_version: field.version,
          use_saved_guidance: true,
          only_empty: true,
        },
      });
      if (signal.aborted) {
        update('stopped');
        continue;
      }
      update('saving');
      applying = true;
      // Once a write starts, await its outcome even if the user stops the queue.
      const saved = await request<CompanyAttributeValue>(
        `/customers/${row.customer.id}/attribute-runs/${run.id}/apply`,
        {
          workspace,
          method: 'POST',
          body: {},
        },
      );
      onSaved(saved);
      update(
        isEmptyAttributeValue(run.value) ? 'empty' : 'saved',
        isEmptyAttributeValue(run.value) ? '无相关信息' : undefined,
      );
    } catch (error) {
      if (signal.aborted && !applying) update('stopped');
      else
        update(
          'error',
          applying && !(error instanceof HttpError)
            ? '保存结果未确认，请刷新核对'
            : error instanceof Error
              ? error.message
              : '生成失败，点击星星重试',
        );
      if (
        signal.aborted ||
        !(error instanceof HttpError) ||
        error.status === 429 ||
        error.status >= 500
      ) {
        pending.slice(i + 1).forEach((r) => onJob({ ...r, status: 'stopped' }));
        break;
      }
    }
  }
}

export function useAttributeGeneration(
  workspace: string,
  onSaved: (value: CompanyAttributeValue) => void,
  onSettled: () => void,
) {
  const [state, setState] = useState<{
    workspace: string;
    jobs: Record<string, AttributeJob>;
    busy: boolean;
  }>({ workspace, jobs: {}, busy: false });
  const controller = useRef<AbortController | null>(null);
  const scope = useRef<object>({});
  const callbacks = useRef({ onSaved, onSettled });
  callbacks.current = { onSaved, onSettled };
  useEffect(() => {
    const token = {};
    scope.current = token;
    setState({ workspace, jobs: {}, busy: false });
    return () => {
      scope.current = {};
      controller.current?.abort();
      controller.current = null;
    };
  }, [workspace]);
  async function start(
    field: CompanyAttribute,
    customers: AttributeCompany[],
    values: CompanyAttributeValue[],
  ) {
    if (controller.current || !field.ai_enabled || field.archived) return;
    const c = new AbortController(),
      token = scope.current;
    controller.current = c;
    setState({ workspace, jobs: {}, busy: true });
    try {
      await fillAttributeCells({
        workspace,
        field,
        customers,
        values,
        signal: c.signal,
        onJob: (job) => {
          if (scope.current === token)
            setState((prev) => ({
              ...prev,
              jobs: { ...prev.jobs, [attributeJobKey(job.customer.id, field.id)]: job },
            }));
        },
        onSaved: (saved) => {
          if (scope.current === token) callbacks.current.onSaved(saved);
        },
      });
    } finally {
      if (scope.current === token) {
        controller.current = null;
        setState((prev) => ({ ...prev, busy: false }));
        callbacks.current.onSettled();
      }
    }
  }
  return {
    jobs: state.workspace === workspace ? state.jobs : {},
    busy: state.workspace === workspace && state.busy,
    start,
    stop: () => controller.current?.abort(),
  };
}
