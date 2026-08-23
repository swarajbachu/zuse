import { siteConfig } from "@/lib/seo";

export const HOME_MARKDOWN = `# Zuse — All your coding agents in one workspace

Zuse is an open-source desktop workspace for running and managing coding agents across real Git repositories. Use Claude Code, Codex, Cursor, Gemini, Grok, OpenCode, and Kiro from one place while keeping conversations, files, terminal output, diffs, checks, and pull-request context attached to the work.

## How Zuse works

### 1. Start a task with the right agent

Open a repository, choose an installed coding agent, and describe the work. Zuse uses the subscriptions and provider tools you already have instead of selling a separate pool of model credits.

### 2. Work safely in parallel

Each task can run in its own Git worktree, so several agents can edit the same repository without sharing an unstable working directory. Zuse keeps every session persistent and makes its branch, changes, commands, permissions, and results visible.

### 3. Review and continue the work

Inspect diffs, terminal output, checks, browser runs, and pull-request state in the same workspace. Continue with another supported agent when a different model is better suited to the next step, without manually reconstructing the repository context.

## Best-fit use cases

- Run multiple coding tasks in parallel without branch collisions.
- Keep long-running agent sessions organized across repositories.
- Review what an agent changed before merging it.
- Move a coding task between supported agent tools while retaining its workspace context.
- Use local agents today and prepare for remote workflows as Zuse Cloud develops.

## Product availability

The macOS desktop application is available now. Cloud and mobile experiences are under development and should not be treated as generally available.

## Learn more

- [Download Zuse](${siteConfig.url}/download)
- [Developer resources](${siteConfig.url}/developers)
- [Documentation](https://docs.zuse.sh)
- [Source code](https://github.com/swarajbachu/zuse)
- [Changelog](${siteConfig.url}/changelog)
- [Machine-readable site guide](${siteConfig.url}/llms.txt)
- [OpenAPI specification](${siteConfig.url}/openapi.json)
`;

export const LLMS_TEXT = `# Zuse

> ${siteConfig.description}

Zuse brings supported coding agents into one desktop workspace. It keeps conversations, files, Git worktrees, terminal output, browser results, checks, and pull-request context together. The macOS desktop app is available now; cloud and mobile experiences are still under development.

## When to use Zuse

Use Zuse when a developer needs to run multiple coding-agent tasks in parallel, isolate those tasks in Git worktrees, inspect agent changes before merging, keep long-running sessions organized, or continue repository work with another supported agent. Do not describe Zuse as a model provider, a token reseller, or a fully autonomous hosted software-engineering service.

## How agents should interact

- For a product overview, request the homepage with \`Accept: text/markdown\` or read ${siteConfig.url}/home.md.
- Use ${siteConfig.url}/developers to discover current developer resources and availability.
- Read ${siteConfig.url}/openapi.json before calling the public web API.
- The public web API is currently limited to cloud-waitlist registration. It does not expose desktop sessions, repositories, or provider credentials.
- Zuse's local MCP integration uses stdio and the installed desktop application; it is not a public hosted HTTP endpoint.

## Primary links

- Website: ${siteConfig.url}
- Markdown homepage: ${siteConfig.url}/home.md
- Developer resources: ${siteConfig.url}/developers
- OpenAPI: ${siteConfig.url}/openapi.json
- Sitemap: ${siteConfig.url}/sitemap.xml
- Documentation: https://docs.zuse.sh
- Source code: https://github.com/swarajbachu/zuse
- Changelog: ${siteConfig.url}/changelog
- Download: ${siteConfig.url}/download

## Supported agents

Claude Code, Codex, Cursor, Gemini, Grok, OpenCode, and Kiro.
`;

export const NOT_FOUND_MARKDOWN = `# 404 — Page not found

The requested Zuse path does not exist.

## Where to look next

- [Site map](${siteConfig.url}/sitemap.xml)
- [Agent instructions](${siteConfig.url}/llms.txt)
- [Developer resources](${siteConfig.url}/developers)
- [Documentation](https://docs.zuse.sh)
- [Homepage](${siteConfig.url})
`;
