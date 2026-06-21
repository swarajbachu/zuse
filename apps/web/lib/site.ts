// Central place for memoize's brand constants and outbound links so we only
// edit them once.

export const SITE_NAME = "memoize";

export const GITHUB_URL = "https://github.com/swarajbachu/memoize";

// Stable site route that redirects to the latest signed `.dmg`.
export const DOWNLOAD_URL = "/download";

export const TAGLINE =
  "Token max every coding agent from one local Mac workspace.";

// The coding agents memoize wraps. Used by the logo cloud / brands marquee.
export const AGENTS = [
  "Claude Code",
  "Codex",
  "Cursor",
  "Gemini",
  "Grok",
  "OpenCode",
] as const;
