import { siteConfig } from "@/lib/seo";

const content = `# Zuse

> ${siteConfig.description}

Zuse is an open-source developer tool for running coding agents in isolated local or cloud workspaces. It keeps agent conversations, files, Git changes, terminal output, browser results, checks, and pull-request context together.

## Primary links

- Website: ${siteConfig.url}
- Documentation: https://docs.zuse.sh
- Source code: https://github.com/swarajbachu/zuse
- Changelog: ${siteConfig.url}/changelog
- Download: ${siteConfig.url}/download

## Supported agents

Claude Code, Codex, Cursor, Gemini, Grok, OpenCode, and Kiro.
`;

export function GET() {
	return new Response(content, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}
