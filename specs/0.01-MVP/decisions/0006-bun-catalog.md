# ADR 0006: Bun catalog + overrides for shared dependencies

**Status**: Accepted

**Date**: 2026-05-02

## Context

The monorepo has multiple workspaces that share dependencies — most notably the Effect ecosystem (`effect`, `@effect/rpc`, `@effect/platform`, `@effect/platform-node`), React (`react`, `react-dom`, `@types/react`), and tooling (`typescript`, `eslint`, `@types/node`).

Without coordination, each workspace package declares its own version range. Three failure modes follow:

1. **Drift** — `effect ^3.21.0` in one package, `^3.22.0` in another, six months later. Updates become per-package archaeology.
2. **Duplicate installs** — Bun resolves two ranges to two different versions, ships both into `node_modules`. Larger installs; in some ecosystems, runtime breakage from duplicate type instances (e.g. two `effect` copies → `instanceof` checks fail across boundaries).
3. **Transitive surprise** — a third-party dep pulls in its own `effect`, resolver picks the wrong one, instance identity breaks.

## Decision

### Bun catalog as the source of version truth

Every dependency that appears in 2+ workspaces (or that we want to upgrade in lockstep across workspaces, even if currently in 1) goes in the catalog at the root `package.json`:

```json
"workspaces": {
  "packages": ["apps/*", "packages/*"],
  "catalog": {
    "effect": "^3.21.0",
    "@effect/platform": "^0.96.0",
    "@effect/platform-node": "^0.106.0",
    "@effect/rpc": "^0.75.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "@types/react": "19.2.2",
    "@types/react-dom": "19.2.2",
    "typescript": "5.9.2",
    "@types/node": "^22.15.3",
    "eslint": "^9.39.1",
    "prettier": "^3.7.4",
    "turbo": "^2.9.7"
  }
}
```

Workspace `package.json` files reference the catalog with `catalog:`:

```json
"dependencies": {
  "effect": "catalog:",
  "@effect/rpc": "catalog:"
}
```

To upgrade `effect` across the monorepo: edit one line in the root catalog and `bun install`. No per-package sweep.

### Root-level `overrides` for transitive consistency

For dependencies where transitive instance identity matters — the Effect family — we add `overrides` at the root:

```json
"overrides": {
  "effect": "^3.21.0",
  "@effect/platform": "^0.96.0",
  "@effect/platform-node": "^0.106.0",
  "@effect/rpc": "^0.75.0"
}
```

This forces every transitive resolution of these packages to the specified range. Any dependency that pulls in its own `effect` is rewritten to the catalog version.

**Why duplicate the version between catalog and overrides:** `catalog:` is a workspace-level convention (only resolves when a `package.json` says `"catalog:"`), while `overrides` operates on the resolution tree. They serve different layers.

### What does NOT go in the catalog

Single-workspace deps that aren't part of an ecosystem we want to coordinate stay inline:

- `electron` — only `apps/desktop`
- `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss` — only `apps/renderer`
- `lucide-react`, `clsx`, `zustand` — only `apps/renderer`
- `tsdown` — only `apps/desktop`
- `next`, `@repo/ui` — only `apps/docs` (legacy scaffold)

The bar: if a version drift here would be inconvenient but harmless, it's not a catalog candidate. If a drift would break something (Effect instance identity, React type compatibility), it goes in.

## Consequences

- One-line dependency upgrades for the Effect family.
- Transitive deps cannot accidentally bring in a stale `effect` version.
- Adding a new workspace that uses Effect is a copy-paste of `"effect": "catalog:"` — no version research.
- Cost: anyone adding a dep has to decide "catalog or inline." Default rule: if it's already in the catalog or used by 2+ workspaces, catalog it.

## What we deliberately rejected

- **Per-workspace pinned versions, no catalog** — the original Turborepo template default. Drift is inevitable; we've already seen it in adjacent codebases.
- **Bun named catalogs (`catalog:react19`)** — adds a layer of indirection without buying us anything at v1. Single default catalog is enough until we genuinely need version multiplexing (e.g., supporting React 18 and React 19 in different workspaces — not a real need).
- **`resolutions` field instead of `overrides`** — `overrides` is the npm-standard name; Bun supports it; `resolutions` is the Yarn-flavored alias. Pick one, use it.
