# Box in-guest quarantine — live verification record

Status: **Pending** — required before `BoxSandboxProviderModule` flips
`productionReady: true` (ADR 0035).

This is the Box analog of `quarantined-fork-verification.md`. It records live
evidence, against a published `zuse-base-v<N>` named snapshot on production
Box, that the in-guest barrier holds. The automated portion is
`packages/sandbox-providers/test/live/box.live.test.ts`
(`BOX_API_KEY=… BOX_TEMPLATE_SNAPSHOT=… bun --filter @zuse/sandbox-providers
test:live`); the manual probes below cover what the suite cannot.

## Checklist

| # | Claim | How to verify | Result |
|---|---|---|---|
| 1 | A fresh create boots with zuse egress denied | live suite: canary curl as `zuse` fails while quarantined | ☐ |
| 2 | A fork of an **open-network** parent still boots quarantined | live suite: fork canary fails before `setNetwork(open)` | ☐ |
| 3 | `setNetwork(open)` lifts the barrier in one call | live suite: canary succeeds after open | ☐ |
| 4 | `restricted` allows only the allowlist | manual: apply `{allowOut:[api host]}`; curl api ok, curl example.com fails | ☐ |
| 5 | `zuse` cannot alter the ruleset | manual: as zuse, `sudo -n nft flush ruleset` and direct `nft` both fail | ☐ |
| 6 | zuse has no path to root | manual: `sudo -l` as zuse shows deny-all; zuse not in sudo/admin/docker groups | ☐ |
| 7 | Quarantine survives the boot ordering race | manual: systemd-analyze verify ordering; unit is `Before=network.target`, enabled in sysinit | ☐ |
| 8 | Hosted-port traffic cannot carry zuse egress during quarantine | manual: while quarantined, connect inbound to a zuse-owned listener on 47837 via the hosted URL; server must not be able to respond (established output dropped for zuse) | ☐ |
| 9 | Box control-plane channel unaffected by quarantine | live suite implicitly: `/commands` works while quarantined | ☐ |
| 10 | **WebSockets work on hosted ports** (production gate, not quarantine) | staging SSH bridge end-to-end over `wss://<subdomain>-47837.on.ascii.dev/ssh` | ☐ |
| 11 | Named-snapshot cap headroom | confirm account limits with ascii.dev; under the account-image architecture each Zuse account's image consumes one snapshot, so record the raised limit and the eviction plan | ☐ |

## Evidence

_Record run ids, box ids, dates, and command transcripts here as items are
completed._
