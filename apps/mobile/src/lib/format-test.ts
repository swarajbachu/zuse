/** Dummy formatting utilities for Zuse PR review testing. */

export function truncateMiddle(value: string, max = 24): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function formatSessionLabel(name: string, unread: number): string {
  const badge = unread > 0 ? ` (${unread} unread)` : "";
  return `${truncateMiddle(name)}${badge}`;
}