# Feature: Skills

A "skill" in memoize is a markdown command the user has authored in
their coding-agent tool of choice. Skill discovery is **delegated** to
the active provider — memoize owns no skill directory of its own.

For a Claude session, skills come from `~/.claude/skills/` (global) and
project-level `.claude/skills/` (multiple between cwd and the repo
root). For a Codex session they come from `~/.codex/skills/` and
project-level `.codex/skills/`. The user's existing skill files just
work.

This document covers discovery, the wire schema, and the resolution
path at send time. The popover UI that surfaces skills lives in
[composer.md](composer.md). The rationale for delegating to providers
is in [../decisions/0011-skills-via-provider.md](../decisions/0011-skills-via-provider.md).

## Behavior

### Discovery

Each provider driver knows how to ask its underlying agent for the
list of available skills:

- **Claude** — driver uses `@anthropic-ai/claude-agent-sdk` with
  `settingSources: ["user", "project", "local"]`. The SDK reads
  `~/.claude/skills/`, project `.claude/skills/`, and `.claude/skills.local/`
  on startup and exposes the parsed list via the `init` event's
  `commands` field. The driver projects each entry onto the `Skill`
  schema below.
- **Codex** — driver issues `client.request("skills/list", { cwds:
  [projectCwd] })` over the Codex CLI's RPC interface. The CLI walks
  `.codex/skills/` between cwd and repo root plus `~/.codex/skills/`
  and returns parsed metadata.

Both drivers normalize results into the same `Skill` shape so the
renderer is provider-agnostic.

### Scoping

- Skills are **scoped per active session**. Switching the session's
  provider replaces the visible skill list — the popover's Skills
  section refreshes immediately. Switching projects re-runs discovery
  with the new `projectCwd`.
- A project-scoped skill (one found under the project's local
  `.claude/skills/` or `.codex/skills/`) **shadows** a global skill
  with the same name. Both sources are returned in the list with a
  `scope` tag so the popover can show a small badge; the project entry
  appears first.

### Hot reload

Both SDKs already report changes:

- Claude SDK emits messages of type `system` with subtype `init` again
  whenever the user's settings change in a way that affects commands.
  The driver re-runs discovery on these.
- Codex CLI emits `SkillsChangedNotification` over its RPC channel.
  The driver re-runs discovery on each.

After re-discovery, the driver's `subscribeSkills.onChange` callback
fires; the server pushes the new list to subscribers of `skill.stream`;
the renderer's popover re-renders without an app restart.

The target latency is "appears within a couple of seconds of saving
the file"; no hard SLA.

### Authoring

Authoring is out of scope for 0.03. Users create and edit skills in
their preferred text editor, in the directory their provider expects.
Memoize introduces no skill format of its own.

## Driver capability

`apps/server/src/provider/drivers/index.ts` (or the existing driver
interface file — confirm at implementation time) gains:

```ts
interface ProviderDriver {
  // …existing methods…
  listSkills(opts: { projectCwd: string }): Promise<Skill[]>;
  subscribeSkills(opts: {
    sessionId: SessionId;
    onChange: () => void;
  }): () => void;          // returns unsubscribe
}
```

## RPC contracts

```ts
// packages/contracts/src/skill.ts (new)
export class Skill extends Schema.Class<Skill>("Skill")({
  name: Schema.String,                              // "rate"
  scope: Schema.Literal("global", "project"),
  description: Schema.String,
  arguments: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      optional: Schema.Boolean,
    }),
  ),
  filePath: Schema.NullOr(Schema.String),           // jump-to-source if provider exposes it
  providerId: ProviderId,
}) {}

export const SkillListRpc = Rpc.make("skill.list", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Array(Skill),
  error: SessionNotFoundError,
});

export const SkillStreamRpc = Rpc.make("skill.stream", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Array(Skill),                     // full list on each emission
  error: SessionNotFoundError,
  stream: true,
});
```

`skill.list` is one-shot for the initial hydrate; `skill.stream` emits
the new full list on every provider change notification — same pattern
as `messages.stream` in `packages/contracts/src/session.ts:243`.

## Renderer state

```ts
// apps/renderer/src/store/skills.ts (new)
type SkillsState = {
  readonly skillsBySession: Record<SessionId, ReadonlyArray<Skill>>;
  readonly hydrate: (sessionId: SessionId) => Promise<void>;
};
```

The store mirrors the Fiber pattern in
`apps/renderer/src/store/messages.ts:97-125`: a single live fiber
subscribes to `skill.stream` for the current session; switching
sessions tears it down and starts a new one. The slash command
popover reads `skillsBySession[activeSessionId]`.

## Resolution at send time

When the user confirms a skill row in the slash popover, the editor
inserts a `skill` chip carrying `{ name, scope, args: "" }`. Anything
the user types after the chip is treated as the `args` payload (free
text — provider-specific argument parsing happens on the provider
side; memoize passes the raw string).

At send time, the composer walks the document and produces:

```ts
ComposerInput = {
  text: "/<skill-name> [args] …",
  attachments: [],
  fileRefs: [],
  skillRefs: [{ name, scope, args }],
}
```

`ProviderService.send` (`apps/server/src/provider/services/provider-service.ts`)
inspects `skillRefs` and calls into the driver:

- **Claude driver** — invokes the SDK's command-invocation path
  (`init.commands` exposes both names and a callable handle); the SDK
  expands the skill body before sending to the model.
- **Codex driver** — sends the equivalent `skills/run` request (CLI
  expands the body before invoking the model).

Memoize never inlines the skill body into the prompt. Expansion is
the provider's responsibility, which keeps skill semantics identical
to using the underlying CLI directly.

## Components added / changed

| File                                         | Status | Purpose                                                  |
| -------------------------------------------- | ------ | -------------------------------------------------------- |
| `packages/contracts/src/skill.ts`                 | new    | `Skill` schema + `skill.list` / `skill.stream` RPCs.     |
| `packages/contracts/src/rpc.ts`                   | edit   | Register the skill RPC group.                            |
| `apps/server/src/provider/drivers/claude.ts` | edit   | Implement `listSkills` from `init.commands`; `subscribeSkills` on init re-emits. |
| `apps/server/src/provider/drivers/codex.ts`  | edit   | Implement `listSkills` via `skills/list`; `subscribeSkills` on `SkillsChangedNotification`. |
| `apps/server/src/skill/skill-bridge.ts`      | new    | Thin handler that wires `skill.list` / `skill.stream` to the active session's driver. |
| `apps/renderer/src/store/skills.ts`          | new    | Per-session skill list, fed by `skill.stream`.           |
| `apps/renderer/src/components/composer/slash-command-popover.tsx` | edit / new (tracked in composer.md) | Renders the Skills section. |

## Acceptance criteria

S1. With a Claude session active and no skill files, the slash popover
    shows only the Commands section. Creating
    `~/.claude/skills/foo.md` (with valid frontmatter) makes `foo`
    appear in the popover within 2 s, no app restart.

S2. With both `~/.claude/skills/foo.md` and `<project>/.claude/skills/foo.md`
    present, the popover shows a single `foo` row tagged `project`.
    The body of the project file is what executes when invoked.

S3. Switching the session's provider from Claude to Codex (or back)
    clears the popover's Skills section and replaces it with the new
    provider's list. No global "merged across providers" view.

S4. Confirming a skill row inserts a `skill` chip into the editor.
    Submitting the message yields a `ComposerInput` whose `skillRefs`
    contains exactly one entry with the skill's name, scope, and any
    text the user typed after the chip as `args`.

## Future hooks (intentional shape, not built yet)

- **In-app authoring UI** — a "New skill" affordance that drops a
  templated markdown file into the right directory for the active
  provider. Schema reserves `filePath` so a future "Edit skill" link
  in the popover can `shell.openExternal` to it.
- **Skill argument typing** — current shape carries description and
  optional flag; a future schema field for `type: "path" | "string"`
  would let the popover offer typed argument autocompletion.
- **Cross-provider skill aliasing** — out of scope here, but the
  `Skill` shape carries `providerId` so a future "convert skill to
  Codex format" command has the data it needs.
