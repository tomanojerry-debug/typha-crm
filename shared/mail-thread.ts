// Only retain bounded, unfolded identifiers. Never accept arbitrary header text.
export function mailMessageId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 998 &&
    /^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/.test(value)
    ? value
    : null;
}
export function mailReferences(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.match(/<[^<>]+>/g) || []
      : [];
  return [...new Set(values.map(mailMessageId).filter((v): v is string => !!v))].slice(-30);
}
