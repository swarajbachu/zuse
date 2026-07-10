# Agent Notes

## About Zuse

Zuse is a clean, fast, reliable desktop GUI for working with many kinds of AI models and coding agents. The most important things are UX, consistent design, cleanliness, speed, and reliability.

## Biome

- Biome is the repository's formatter and static-analysis tool. Use it for formatting and linting as the workspace transitions away from ESLint and Prettier.
- Before declaring a task complete, run the applicable Biome checks, type checks, and behavior tests. Report any check that could not run and why.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures, including session restarts, reconnects, and partial streams.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

- Long-term maintainability is a core priority.
- Before adding new logic, check whether the codebase already has a shared way to do it. If it does, use that instead of making another version.
- Do not duplicate logic. One behavior should have one source of truth. If the same or very similar logic exists in multiple places, extract it into shared code and use the shared code everywhere.
- Do not take shortcuts by adding isolated local logic for a problem that belongs in an existing shared module. Change existing code when that is the clean solution.

## Design Decisions

- When making UI or UX decisions, explicitly use the `emil-design-engineering` skill. It helps keep the product fast, accessible, consistent, and polished.

## Workspace Boundaries

- `apps/desktop` owns the Electron shell and native desktop integration; `apps/renderer` owns the desktop UI; `apps/server` owns backend services, persistence, providers, sessions, and IPC.
- `apps/mobile`, `apps/web`, and `apps/mcp-server` own the mobile client, marketing site, and MCP integration respectively.
- `packages/contracts` contains contracts and schemas, `packages/ui` contains reusable UI, and focused packages own their specific shared capability. Do not place application behavior in contract packages.

## Reference Repositories

- Local reference checkouts live in `~/.zuse/reference-repos`.
- When writing Effect code, first read `~/.zuse/reference-repos/effect-smol/LLMS.md`. Use its documentation and source code as the reference for Effect patterns and APIs.
- Treat them as read-only implementation research: inspect relevant source and tests before guessing about unfamiliar integrations, protocols, or library patterns.
- Never import application code from a reference checkout or modify it unless the task explicitly requests that work.
- Keep this repository self-contained: use its declared dependencies and its own conventions in production code.
