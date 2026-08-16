export type LanAuthPolicy = "local" | "protected";

export const resolveAuthPolicy = (host: string): LanAuthPolicy => {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "localhost"
  ) {
    return "local";
  }
  return "protected";
};
