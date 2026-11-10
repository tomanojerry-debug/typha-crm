import { useState } from 'react';

type Display = { key: string; fields: string[] };

function readDisplay(key: string, defaults: string[]): Display {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (
      saved &&
      Array.isArray(saved.fields) &&
      saved.fields.every((field: unknown) => typeof field === 'string')
    )
      return { key, fields: [...new Set<string>(saved.fields)] };
  } catch {
    // Display preferences are optional; business records are never stored here.
  }
  return { key, fields: defaults };
}

export function useKanbanDisplay(key: string, defaults: string[]) {
  const [stored, setStored] = useState(() => readDisplay(key, defaults));
  // A new scope reads its own preference immediately, without rendering the old actor's fields.
  const display = stored.key === key ? stored : readDisplay(key, defaults);
  function setFields(fields: string[]) {
    const next = { key, fields };
    setStored(next);
    try {
      localStorage.setItem(key, JSON.stringify({ fields: next.fields }));
    } catch {
      // The current board stays usable when local storage is unavailable.
    }
  }
  return {
    fields: display.fields,
    setFields,
  };
}
