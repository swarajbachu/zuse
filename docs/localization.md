# Desktop localization

Zuse ships offline interface catalogs for English, French, German, Simplified Chinese,
Traditional Chinese, Japanese, and Korean. English is enabled for production. The six
other catalogs are machine translation drafts and must pass native-speaker review and
screen QA before activation. `en-XA` is an expanded development pseudolocale.

## Architecture

`packages/i18n` owns locale negotiation, catalogs, typed message keys, review status,
React bindings, and cached `Intl` formatters. Its core does not require React.
`packages/contracts/src/locale.ts` contains only the desktop wire contract.
Electron persists `language.json` in its installation's user-data directory; language
is independent of connected computer settings. A versioned, revision-numbered snapshot
initializes the main and notch renderers before rendering. Preference writes are
serialized and published only after successful persistence. Renderers ignore stale
loads and share one runtime per window. Switching does not recreate the application,
change action IDs, discard drafts, or alter agent instructions.

System mode uses Electron's preferred system languages at launch and activation.
Explicit Chinese scripts take precedence over region: Taiwan, Hong Kong, and Macao
resolve to Traditional; China, Singapore, and bare `zh` resolve to Simplified.
Unsupported or unreviewed languages fall back to English. OS-owned controls can follow
the operating system's language.

Feature English resources are registered alongside their consuming modules. Other
catalogs load by language and namespace through bundled dynamic imports, with English
fallback. No runtime translation service or network connection is required. Inactive
catalogs must stay out of startup chunks; renderer bundle budgets remain unchanged.

## Adding or changing interface text

1. Add a stable, descriptive key to the appropriate English feature catalog. Translate
   complete sentences with named values. Keep distinct meanings in distinct keys.
2. In React, import the feature's `@zuse/i18n/english/<namespace>` module and use
   `const { message } = useMessages("<namespace>")`. Include `message` in memo/effect
   dependencies when derived output uses translations. Outside React, call `message`
   at use time; do not freeze translated labels at module initialization.
3. Use i18next `_one`/`_other` and locale-appropriate plural variants with `count`.
   Use `RichMessage` only with explicitly mapped components and named values. Catalog
   HTML, event handlers, and arbitrary component attributes are forbidden. React escapes
   interpolated text; core output is for text-only native APIs, never HTML sinks.
4. Use shared `Intl` helpers for presentation. Preserve currencies, time zones,
   machine-readable dates, protocol values, provider/model names, code, paths, and user
   content. Interface language must not alter prompts or request a response language.
5. Update all draft catalogs, run `bun run i18n:generate`, then `bun run check:i18n`
   and `bun run test:i18n`. Generation updates pseudolocalization, typed loaders,
   English registration modules, source references, and the English source hash.
   Changed English requires renewed review for every enabled translation.

The targeted AST check rejects literal JSX text and common display/accessibility
properties, including conditional/template text. It is a guard, not a replacement for
screen review: dynamically assembled messages and third-party boundaries need human
inspection. Technical exceptions belong in `scripts/i18n-exceptions.json` and must be
specific. Do not exempt an entire component to bypass translation.

## Translator context and glossary

`packages/i18n/src/context.json` records English copy and source locations. Open the
referenced screen and retain screenshots with the review evidence. Preserve `{{name}}`
values and rich component markers exactly; components may move to suit grammar.

| Term | Meaning and translation guidance |
| --- | --- |
| Agent | AI coding assistant performing tasks; distinguish from a human user. |
| Workspace | Working environment associated with a project; not a conversation. |
| Session | One agent conversation/execution context, including reconnection state. |
| Worktree | Git worktree: a separate checkout sharing a repository; retain Git terminology. |
| Approval | User permission for an agent action; distinguish from authentication. |
| Connection | Link to a local/cloud computer or service; preserve hostnames. |
| Provider / model | Keep product and model names unchanged. |

Native reviewers should establish a consistent target-language glossary before editing
individual strings. Current drafts are not evidence of terminology approval.

## Review and progressive release

`src/review.json` is the activation gate. Each translation starts with `status: "draft"`,
a null reviewer, and draft provenance. `draftSourceRevision` records the English version
used for the initial draft; it is not automatically advanced during regeneration.
After native-speaker review and acceptance checks, set `status: "reviewed"`, record the
reviewer's identity and the current English `sourceRevision`, and attach screen QA
results to the reviewing PR. Never mark a draft reviewed just to enable the selector.
CI rejects stale enabled translations, missing/obsolete keys, malformed placeholders,
invalid plural structure, and unsafe rich-text markup. Development exposes drafts and
the pseudolocale; packaged production exposes only reviewed languages.

For an additional language, extend the locale wire union and locale registry, add
catalogs and draft review metadata, update negotiation/plural tests, and regenerate.
Arabic and Hebrew remain disabled until a dedicated RTL layout and interaction pass.
Mobile, marketing, documentation translation, and translated release notes are separate.

## Acceptance checklist

- First launch, corrupt preferences, unsupported system languages, Chinese scripts,
  explicit override, restart, offline startup, rapid changes, and multiple windows.
- Failed persistence/catalog loading preserves recoverable UI and offers retry.
- Switch during streaming, reconnection, approvals, and open dialogs; preserve drafts,
  focus, selection, stable commands, and English command-search aliases.
- Review every screen in all seven languages and expanded pseudo at 720 × 480, including
  errors, menus, notifications, keyboard access, and accessibility labels. Settings
  controls remain `h-7`; long labels wrap without losing actions.
- Exercise actual Chinese/Japanese/Korean IMEs in composer, search, rename, and dialogs.
  Enter during composition must not submit. Synthetic unit events supplement real IMEs.
- Run applicable Biome, `bun run check-types`, affected behavior tests, and
  `bun run build:desktop`. Check startup/default-route/lazy-chunk budgets.
- Build unsigned macOS/Linux packages without publishing; verify offline catalogs,
  native menus, notifications, fonts, startup recovery, and restart on each platform.
  Browser fixtures and bundle startup smoke tests do not replace packaged acceptance.

Reference APIs: [i18next plurals](https://www.i18next.com/translation-function/plurals),
[i18next TypeScript](https://www.i18next.com/overview/typescript), and
[Electron app locale APIs](https://www.electronjs.org/docs/latest/api/app).
