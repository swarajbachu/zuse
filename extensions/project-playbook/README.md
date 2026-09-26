# Project Playbook

Bring your team’s procedures into any agent conversation.

Independent official Zuse desktop preview extension. Install this directory through Settings → Extensions → local directory, review capabilities, then open its workspace tab. Open a conversation to attach selected results; the ordinary composer controls sending.

## Development

From the repository root, run `bun install --frozen-lockfile`, `bunx vitest run extensions/project-playbook/test`, and `bun run --cwd extensions/project-playbook check-types`. Dependencies are pinned in this directory and resolved by the repository's committed `bun.lock`. Official distribution bundles dependencies ahead of time; users do not run a package manager.

`index.client.tsx` registers the panel and attachment picker. `index.server.ts` registers the shared workspace-tool backend. The adjacent parser/scanner produces immutable snapshots with references; `fixtures/` and `test/` exercise it. There are no dependencies on other extensions.

See the full [user workflows](../../apps/docs/content/docs/extensions/tools.mdx), [SDK guide](../../apps/docs/content/docs/extensions/authoring.mdx), and [trust/recovery guide](../../apps/docs/content/docs/extensions/trust-and-recovery.mdx).

This is trusted, unsandboxed local code. It does not run tests or send prompts automatically. Public catalog availability remains gated on signing and packaged desktop verification.
