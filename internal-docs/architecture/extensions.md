# Zuse Extensions

Zuse Extensions are desktop-only, explicitly trusted TypeScript modules. They
are separate from Claude or Codex plugins: a Zuse Extension can add application
UI, typed backend behavior, and coding-agent providers. Extensions are globally
disabled by default.

## Trust model

An enabled extension is trusted code. Its backend runs unsandboxed in a
supervised child process and its client bundle runs in the context-isolated
renderer through a host-controlled factory. Capability declarations are
disclosure and host-API gates; they do not prevent direct filesystem or network
access. Install or capability changes always require explicit approval.

Managed Git author installs use frozen lockfiles and disable lifecycle scripts.
Catalog installs download bounded, precompiled JSON envelopes containing only a
validated manifest and JavaScript/CSS strings; no archive paths, links, package
manager, compiler, or Git are involved. Catalogs use Ed25519 signatures and
artifacts use SHA-256 content addresses. Signing runs only in a protected release
environment after verifying the credential against the shipped public key.

## Manifest

Every extension has a `zuse-extension.json` at its root:

```json
{
  "schemaVersion": 1,
  "id": "acme-tools",
  "name": "Acme Tools",
  "description": "Acme workflows for Zuse",
  "version": "1.0.0",
  "client": "index.client.tsx",
  "server": "index.server.ts",
  "zuseApi": "^1.0.0",
  "homepage": "https://example.com/acme-tools",
  "repository": "https://github.com/acme/zuse-acme-tools",
  "contributions": ["command", "workspace-panel"],
  "capabilities": ["commands", "ui", "rpc"],
  "publisher": {
    "name": "Acme",
    "url": "https://example.com"
  }
}
```

IDs are stable slugs. Provider IDs must be namespaced under the extension ID,
for example `acme-tools.agent`; built-in provider IDs are reserved.

## Source boundaries

Explicit client and server entries compile independently. The legacy `entry`
field remains supported for shared setup functions like the example below. Use suffixes
to make target-only modules explicit:

- `*.client.tsx` contains React UI and may not be imported by server code.
- `*.server.ts` contains Node/provider behavior and may not be imported by
  client code.
- `*.shared.ts` contains serializable definitions and Effect Schema contracts.

The client allowlist provides React, the extension SDK, Effect Schema, and approved
Zuse UI modules. The server provides Effect Schema, the server SDK, and Node
builtins. Other dependencies are bundled. The host-provided `effect` root exports
only `Schema`; unsupported named imports fail compilation.
Registration must return an async-safe cleanup callback.

```tsx
import { Schema } from "effect";
import { defineRpc, type ExtensionContext } from "@zuse/extension-sdk";

const greeting = defineRpc({
  name: "greeting",
  input: Schema.String,
  output: Schema.String,
});

export default function setup(extension: ExtensionContext) {
  if (extension.target === "server") {
    extension.handle(greeting, (name) => `Hello ${name}`);
  } else {
    extension.addCommand({
      id: "hello",
      title: "Acme: Say hello",
      icon: "sparkles",
      context: "global",
      run: async ({ invoke }) => console.info(await invoke(greeting, "Zuse")),
    });
  }
  return () => {};
}
```

Supported client contributions are global surfaces, sidebar entries,
workspace panels, Cmd+K commands, semantic themes, deterministic timeline
transformers/renderers, and composer snapshot sources. Server contributions
are schema-checked RPC handlers, storage/secret access, cleanup hooks, and
dynamic coding-agent providers.

## Lifecycle and data

Activation compiles and validates before quiescing the current runtime. Zuse then
copies host-managed KV/blob state to a candidate generation, initializes and
migrates it, and atomically commits the code/state pointer. Failed candidates are
discarded and the prior generation restarts. Candidate preparation cannot write
host-managed secrets. Startup recovery removes uncommitted generations. Direct
filesystem/network side effects of trusted code cannot be rolled back.

Lifecycle changes are serialized; invocations during replacement return a
recoverable busy error. Active provider sessions block reload/update. Explicit
disable/removal closes affected sessions with visible terminal events while
retaining conversation history and provider display metadata. Event queues are
bounded and overflow ends the stream visibly. Crash recovery stops after three
failed attempts; only 60 healthy seconds or explicit retry resets the budget.
Enabled extensions start in bounded batches after core server readiness.

Each extension has quota-limited namespaced JSON/blob storage, a schema version,
migrations, and keychain-backed secrets. Removal asks whether to retain or
delete data. Logs are redacted, line-limited, byte-limited, and retain only the
latest 500 entries.

## CLI

The desktop daemon backs both Settings and the CLI with the same typed RPCs:

```sh
zuse extension init ./my-extension --id my-extension --name "My Extension"
zuse extension inspect --path ./my-extension
zuse extension install --path ./my-extension --grant ui --grant commands
zuse extension list
zuse extension status --id my-extension
zuse extension logs --id my-extension
zuse extension reload --id my-extension
zuse extension disable --id my-extension
zuse extension enable --id my-extension
zuse extension update --id my-extension --grant ui --grant commands
zuse extension remove --id my-extension --confirm
```

Use `--git <url> [--ref <commit>] [--subpath <path>]` for managed Git sources,
or `--marketplace <catalog-id>` for the curated marketplace.

## Desktop preview workflows

The three independent official packages live in `extensions/`: Test Reports,
Project Playbook, and Code Follow-ups. They share SDK panels, host-resolved local
workspace context, cancellation, bounded file APIs, and explicit composer snapshot
attachment. Browsing never invokes an agent. Workspace changes cancel requests
and discard incompatible selections. Cloud and mobile extension execution are
not eligible. See `apps/docs/content/docs/extensions/` for user and author guides
and `internal-docs/releases/extensions-preview.md` for outstanding publication gates.
