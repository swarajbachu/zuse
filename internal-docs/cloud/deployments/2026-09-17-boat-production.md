# Boat production rollout

Production `api.zuse.sh` (`zuse-relay`) now advertises Boat and E2B. Boat uses
`zuse-base-v6`; E2B retains its configured production template. The existing
production provider key was preserved. Worker configuration now uses `BOAT_*`,
with legacy `BOX_*` fallback for installed secrets and older deployments.
Internal provider and billing identifiers remain `box`.

Applied the previously pending production migrations 0021–0024, after checking
the installed migration hashes. Verified the resulting ledger, Boat price
schedule, lifecycle-pair table, and valid resource/time usage index. The temporary
Hyperdrive migration worker was deleted after verification.

Published `zuse-base-v6` through the Mac bridge. The signed production runtime
remains `5f283a45ec63a6a626d7352089b655dba42333a3` (0.21.0, wire protocol 5).
Final production API version, including filesystem readiness:
`58d21342-680f-4158-913a-3fe62839e381`.

## Authentication prerequisite

The first workspace reached the runtime in about 16 seconds and its SSH
WebSocket returned an OpenSSH banner, but Codex returned 401: production still
had broker enrollment/serving disabled. Boat cannot inherit the account login
snapshot from the E2B authority. Enabled the existing Codex and provider broker
enrollment/serving gates and rebuilt the Boat image. Existing E2B legacy images
retain their authentication mode; newly rebuilt images enroll in broker mode.

## Filesystem readiness fix

The first v6 account image failed with EACCES while creating the runtime archive.
A later build succeeded, but pause/resume reproduced the same failure. The new
staging directory belonged to UID 1000 rather than Zuse's UID 1001, and the runtime
release directory was empty after Boat switched filesystem mounts. Boat's logs
showed its system filesystem restoration completed about 57 seconds into this
resume, after Zuse had already started writing to the temporary FUSE view.

The adapter now checks the system mounts before modifying the runtime layout or
starting processes. It retries while `/usr`, `/etc`, `/opt`, or `/srv` is backed
by FUSE, with the existing bounded readiness deadline. It starts immediately
when the real mounts are available. No firewall or fixed startup sleep was added.
This can expose provider restoration time that the previous path skipped, but
avoids starting the runtime against files being replaced underneath it.

## Verification

- 334 API and 96 provider unit tests, API/provider type checking, scoped Biome, publisher shell syntax,
  and whitespace checks passed.
- Authenticated production discovery returns Boat (three sizes) and E2B.
- Production bindings contain the new Boat names and the unchanged legacy
  `BOX_API_KEY` secret. Both sets of broker gates are enabled.
- Rebuilt broker image `image_fRRoR0WFqFJ89Lho` is ready.
- A fresh Boat workspace enrolled with both authentication modes `broker-v1`
  and came online in 66.47 seconds from a cold fork. The earlier prepared-machine
  smoke launch took 15.84 seconds. These are single observations, not averages.
- SSH WebSocket reached `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.19`.
- A real Codex reply is blocked by `codex-auth-reconnect-required` from the
  account login service. The saved UI status still reports its August 31
  verification as connected. The user must reconnect Codex before this check
  can pass; no replacement account credentials were installed.

- Direct live adapter pause/resume passed with the readiness fix: 56.98 seconds
  total, including 52.32 seconds waiting for real system mounts. The saved file
  survived and a new write as Zuse succeeded after resume.
- The previously failed workspace recovered through the deployed production API
  and returned online after retry (22.96 seconds on an already restored VM).
- Both temporary smoke workspaces were deleted, the disposable diagnostic
  sandbox was deleted, the smoke API key was revoked, and local temporary
  credential files were removed. Production account images and pool resources
  remain available for normal use.
