# Muse Code provider

Install Muse Code 1.4.6 or newer on the computer hosting the Zuse server with `curl -fsSL https://dev.meta.ai/install.sh | bash` (Windows: `irm https://dev.meta.ai/install.ps1 | iex`). Settings shows the command for the server's OS; use `bash`, not `sh`, because the script requires `pipefail`. Then run `muse login` there (or `/login` inside an interactive `muse` session). Because the driver drops an inherited `META_API_KEY`, store API keys with `muse auth set`. Enable Muse Code in provider settings. If `muse` is outside PATH, set its absolute binary path in the same settings panel.

The driver uses the pinned `@muse-code/sdk` and Muse Session Protocol. Models come from the host's `model/list`; there are no speculative bundled model IDs. Reasoning tiers use the host's variants when supplied, with `low`, `medium`, `high`, `xhigh`, and `max` as the fallback when variants are missing or unknown. Discovery does not establish authentication: a cached catalog can be available while logged out. Authentication failures surface when sending a turn.

Sessions retain the native session ID and resume it directly. A missing session is an error rather than an implicit replacement. Each turn supplies the current checkout as its workspace root. The driver supports streamed text and reasoning, tool results, native questions, image attachments, usage, interruption, `/compact`, and the session MCP gateway. Workflow and other item kinds use generic tool presentation. Native plan mode is not advertised.

The driver requires the `:ask-me` permission profile and keeps Muse in `promptUnmatched` mode. Zuse's shared permission policy decides native approval requests; the driver submits only offered, single-use choices. Protected writes remain interactive even under full access. Read-only sessions disable native shell/write tools and deny other non-read approvals. An inherited `META_API_KEY` is excluded unless explicitly supplied in the session environment.

Run the protocol regression tests with:

```sh
bunx vitest run packages/agents/test/unit/drivers/muse.test.ts
```

The opt-in server smoke harness includes `ZUSE_LIVE_MUSE=1`. It requires an installed CLI and an authenticated account; fake-host tests do not establish live service compatibility.
