/**
 * Subdomain + Vercel project naming. Project names are namespaced by a hash
 * of the WorkOS user id so two users' "my-app" never collide; the public
 * subdomain prefers the bare slug and falls back to a user-suffixed one.
 */

export const slugify = (name: string): string => {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/g, "");
  return slug === "" ? "app" : slug;
};

/** Stable 8-hex-char hash (FNV-1a) — not cryptographic, just a namespace. */
export const userHash8 = (userId: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const projectNameFor = (userId: string, slug: string): string =>
  `zuse-${userHash8(userId)}-${slug}`;

export const subdomainCandidates = (
  userId: string,
  slug: string,
): ReadonlyArray<string> => [slug, `${slug}-${userHash8(userId).slice(0, 4)}`];
