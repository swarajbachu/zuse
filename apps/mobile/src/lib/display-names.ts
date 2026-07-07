export const visibleConnectionLabel = (
  label: string | null | undefined,
  fallback = "Computer",
): string => {
  const trimmed = label?.trim();
  if (!trimmed) return isRawIdentifier(fallback) ? "Computer" : fallback;
  if (isRawIdentifier(trimmed)) return fallback === trimmed || isRawIdentifier(fallback) ? "Computer" : fallback;
  return trimmed;
};

const isRawIdentifier = (value: string): boolean => {
  if (/^env[_-]/i.test(value)) return true;
  if (/^[0-9a-f-]{24,}$/i.test(value)) return true;
  return false;
};

export const visibleProjectPath = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
};

export const projectAvatarUrl = (path: string, name: string): string | null => {
  const text = `${path} ${name}`;
  const match =
    /github\.com[:/](?<owner>[^/\s:]+)\/(?<repo>[^/\s]+?)(?:\.git)?(?:\s|$)/i.exec(text) ??
    /(?:^|[\s/])(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)(?:\s|$)/.exec(name);
  const owner = match?.groups?.owner;
  if (!owner) return null;
  return githubOwnerAvatarUrl(owner);
};

export const githubOwnerAvatarUrl = (owner: string): string =>
  `https://github.com/${encodeURIComponent(owner)}.png?size=80`;
