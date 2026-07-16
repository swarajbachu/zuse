# Domain docs

This repository uses a multi-context domain-documentation layout. A root `CONTEXT-MAP.md`, when present, points to the relevant context documents under `apps/` and `packages/`.

## Before exploring

- Read the root `CONTEXT-MAP.md` when it exists, then read each linked `CONTEXT.md` relevant to the work.
- Read relevant system-wide decisions under `docs/adr/`.
- Read relevant context-specific decisions in an app or package's `docs/adr/` directory.

If these files do not exist, proceed silently. Domain-modeling workflows create them when terminology or decisions are actually resolved.

## Vocabulary

Use the terms defined in the relevant `CONTEXT.md` in issue titles, plans, hypotheses, tests, and implementation notes. Avoid introducing synonyms for concepts the glossary already names.

If a needed concept is absent, reconsider whether it belongs to the domain or record the gap for a domain-modeling session.

## Architectural decisions

Surface any conflict with an existing architectural decision explicitly instead of silently overriding it.
