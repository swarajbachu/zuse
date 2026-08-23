// Central place for Zuse's brand constants and outbound links so we only
// edit them once.

export const SITE_NAME = "Zuse";

export const GITHUB_URL = "https://github.com/swarajbachu/zuse";
export const RELEASES_URL = "https://github.com/swarajbachu/zuse/releases";
export const X_URL = "https://x.com/zuse_sh";
export const INSTAGRAM_URL = "https://www.instagram.com/zuse.sh/";
export const DISCORD_URL = "https://discord.gg/cvGpmMGd5";

// Stable site route that redirects to the latest installer for the visitor's OS.
export const DOWNLOAD_URL = "/download";

export const TAGLINE =
	"All your coding agents in one workspace, with isolated tasks and shared context.";

// The coding agents Zuse wraps. Used by the agent strip.
export const AGENTS = [
	"Claude Code",
	"Codex",
	"Cursor",
	"Gemini",
	"Grok",
	"OpenCode",
	"Kiro",
] as const;
