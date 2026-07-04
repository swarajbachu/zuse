export const slugConnectionKey = (key: string): string =>
  key.replace(/[^a-zA-Z0-9._-]+/g, "_");

export const parsePairingUrl = (
  value: string
): { host: string; port: number; token?: string } => {
  const url = new URL(value);
  const pairingUrl = url.searchParams.get("pairingUrl") ?? url.host;
  const normalized = pairingUrl.includes("://")
    ? new URL(pairingUrl)
    : new URL(`ws://${pairingUrl}`);
  const token = url.hash.startsWith("#token=")
    ? decodeURIComponent(url.hash.slice("#token=".length))
    : undefined;
  return {
    host: normalized.hostname,
    port: Number(normalized.port || "8787"),
    token
  };
};
