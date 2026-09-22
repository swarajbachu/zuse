# Box to Boat migration

The provider adapter now calls `https://boat.dev/api/v1/sandboxes`, reads
`sandbox`/`sandboxes` envelopes and `sandboxId`/`sandboxType` usage fields,
and creates hosted links under `on.boat.dev`. Snapshot requests also use
`sandboxId`. The template publisher and benchmark use the same new vocabulary.
Provider display names and public documentation say Boat.

Zuse retains the internal `box` provider ID, `/box` webhook route, and module
filenames. These are Zuse configuration and database identifiers, not calls to retired provider endpoints. Keeping them
preserves workspace placement, existing secrets, prices, and event-window pairing.
Existing API keys remain valid; no secret rotation is required by this change.
Deployment settings now use `BOAT_*`. Legacy `BOX_*` bindings remain a fallback;
`BOAT_*` takes precedence, including explicit empty or disabled values. Existing
production secrets are not replaced. New secret commands use `secret:boat` and
`secret:boat:production`.
Any explicitly configured `BOAT_API_BASE_URL` (or legacy `BOX_API_BASE_URL`)
must point to the Boat API. An explicit `BOAT_HOSTED_PORT_DOMAIN`
(or legacy `BOX_HOSTED_PORT_DOMAIN`) must be `on.boat.dev` before deployment.

Signed webhooks accept both legacy `box.*` with `data.box` and new `sandbox.*`
with `data.sandbox`. Signature verification still uses the original raw body and
unchanged X-Ascii headers. New event names normalize to the existing ledger's
`box.*` names before pairing; raw payloads remain intact for audit. Recovery polls
read Boat's new response shape. There is no second provider or billing ledger.

Existing provider webhook registrations keep their old payload vocabulary.
Recreate them through Boat's API and retire the old registrations as a separate
deployment operation; this code change does not modify external registrations.
Likewise, existing published hosted URLs are not rewritten in stored records.

Source: [Boat migration guide](https://docs.boat.dev/migrating-from-box), checked
September 16, 2026. The email announces retirement October 31; the current guide
describes that as the advertised Sunset date and says retirement policy is not
yet settled. Migrate without depending on continued legacy endpoint support.
