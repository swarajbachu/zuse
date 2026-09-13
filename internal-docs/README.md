# Internal documentation

Repository documentation lives here: cloud usage and integration references,
engineering notes, and operator runbooks. Public documentation is maintained
separately in [apps/docs/content/docs](../apps/docs/content/docs), which powers
docs.zuse.sh, including search, sitemap, and LLM exports. Files here are not
published by the docs site.

- [Cloud guides, systems, and operations](cloud/README.md)
- [Slack app setup and rollout](cloud/slack-app-operations.md)
- [Cloud billing operations](cloud/billing.md)
- [Production runbook](cloud/production.md)
- [Architecture](architecture): runtime and client implementation references.
- [Decisions](adr): historical architecture decisions.
- [Specifications](specs): engineering plans and technical specifications.
- [Research](research): implementation research and findings.
- [Performance](performance): performance evidence and acceptance data.
- [Testing](testing): manual verification and release checks.
- [Agent workflows](agents): repository contributor instructions.

Do not import these files into the docs site's content collection, navigation,
search index, sitemap, or LLM exports. Keep deployment commands, secret setup,
infrastructure identities, migrations, and incident procedures out of customer
guides. Link to customer guides from internal docs when a workflow needs both.

“Internal” describes the audience and publishing boundary, not access control.
These files remain visible to anyone with repository access. Never store actual
secrets here; confidential operational data belongs in an access-controlled system.
