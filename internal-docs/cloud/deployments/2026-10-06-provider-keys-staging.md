# Customer provider keys staging deployment

Source: uncommitted working tree on `swarajbachu/bring-your-own-token` (on top
of `adc9b991`). Production was not changed.

- Database: migration `0037_cloud_provider_connections` applied to staging
  (`0036` was the latest recorded). Applied through the staging Hyperdrive
  binding (`dfc67e05…`) by a temporary Worker that ran the SQL in a transaction
  and recorded the same drizzle hash and journal timestamp `drizzle-kit
  migrate` would; it was deleted immediately afterwards. Staging now records 41
  migrations and has `api_cloud_provider_connections`.
- API: `zuse-relay-staging`, version `14bded98-f4dd-4561-abfe-c95621958fb3`,
  serving `https://api-staging.zuse.sh`. Previous version:
  `c830fdb6-1c5b-47c0-837a-0464aa3220a2`.

The first two deploy attempts were rejected with "Script startup exceeded CPU
time limit" (code 10021). `main` alone measured the same startup cost, so the
cause was not this change: the plugin engine (`@zuse/executor-v2`) and the MCP
SDK, with their Zod copies, were evaluated at module load. Both now load on
first use (`plugin-vault.ts`, `plugin-routes.ts`), cutting local startup CPU
from about 550 ms to about 380 ms. Production deploys of `main` need the same
change.

Verification before deploy: API unit tests, the plugin vault integration test,
and contracts/client-runtime/server/renderer type checks passed. Live checks
confirmed `/v1/cloud/provider-connections` and `/v1/cloud/providers` reject a
missing bearer (401).

Manual staging checks remain: connect, replace and disconnect a key for each
provider; build an image and create, pause, resume and delete a workspace with
a customer key; confirm no Zuse billing is recorded; and use a plugin MCP tool
to exercise the lazily loaded engine.

Rollback: redeploy the previous API version. Migration `0037` only adds a table
and is safe to leave in place.

## Stuck queued build follow-up

A clean boxd rebuild pinned to a customer key stayed `queued` with no output:
boxd answered the first step (`machines.get` while recovering by label) with
PermissionDenied, and the reconciler died and retried every lease without
saving anything. Queued builds now fail with `provider-rejected` and a log
message when the provider permanently refuses the lookup, create or fork, and
with `project-start-timeout` when a queued build makes no progress for 15
minutes. The stuck build was closed by the timeout. Redeployed API version:
`7c4e50e7-0a09-4e8d-8bf5-456e96ddd987`.

Open: the same key passed the save-time lookup, so why boxd refuses it during
the build is not yet known.
