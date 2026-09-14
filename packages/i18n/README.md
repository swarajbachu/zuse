# @zuse/i18n

Shared locale rules, offline catalogs, typed translation APIs, and display formatters.

```text
locales/
  registry.json                 Native language names
  en/                           English source
    desktop/<feature>.json
    website/<feature>.json
  fr/, de/, zh-Hans/, zh-Hant/, ja/, ko/  Translation drafts
  en-XA/desktop/                Generated expanded pseudolocale
context/
  desktop.json, website.json    Translator context and source locations
review/
  desktop.json, website.json    Independent review records and source revisions
src/
  generated/                    Generated types, loaders, and registrations
  website/                      Isolated website React and server APIs
  index.ts, react.tsx            Desktop runtime, bindings, and Intl helpers
  registry.ts, locales.ts        Shared registry and desktop locale negotiation
```

Edit English source and translations under `locales`, then run `bun run i18n:generate`
from the repository root. Do not edit `src/generated` or `en-XA` directly. Run
`bun run check:i18n` and the affected behavior tests before submitting changes.

See [the localization guide](../../internal-docs/localization.md) for integration, glossary,
review workflow, website routes, and desktop release requirements. Draft translations
must never be marked reviewed without native-speaker review and screen QA.
