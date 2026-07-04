// Central place for Zuse Alpha's brand constants and outbound links so we only
// edit them once.

export const SITE_NAME = "Zuse Alpha";

export const GITHUB_URL = "https://github.com/swarajbachu/zuse";
export const RELEASES_URL = "https://github.com/swarajbachu/zuse/releases";

// Stable site route that redirects to the latest signed `.dmg`.
export const DOWNLOAD_URL = "/download";

export const TAGLINE =
  "Token max every coding agent from one local Mac workspace.";

// The coding agents Zuse Alpha wraps. Used by the logo cloud / brands marquee.
export const AGENTS = [
  "Claude Code",
  "Codex",
  "Cursor",
  "Gemini",
  "Grok",
  "OpenCode",
] as const;
