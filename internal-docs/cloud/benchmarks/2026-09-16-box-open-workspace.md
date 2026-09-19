# Box open-workspace resume — 2026-09-16

## Change

Source `80ab8e9a9` removes boot quarantine and its readiness wait for ordinary
open-network workspaces. The adapter migrates existing templates with a root-owned
marker and systemd condition, stops any existing firewall job, and clears Zuse's
egress table. Explicitly requested quarantine remains supported and verified.
The template installer defaults to open networking; the publisher tests explicit
quarantine and restores open networking before saving a snapshot.

Healthy resumes reuse the persisted home and repository links without copying
files, recursively changing ownership, or sleeping for a layout marker. They
recreate only the temporary secrets directory. Missing markers fail immediately;
damaged layouts retain the existing repair path. Layout preparation and any
required legacy policy restore use one provider command. This removes our
redundant setup work; it does not disable Box's own snapshot restoration.

## Deployment and method

Staging Worker `4a11bd9e-1fe0-40f0-8161-2b8325f1e8a0`, signed runtime
`dc7d4d93bc5d86f0b5a03a075bfe3b0cbf605618`, existing `zuse-base-v5` template,
small Box. Deployment source hashes were checked against the cloud checkout.
The template publisher change is source-only; no new template was published.
Production and provider keys were not changed.

Workspace `workspace_ytq_SpSc4ta8LhdK`, Box `bx_49rhrbsy`. Each cycle waits for
Box itself to report `archived`, submits a public API message, and measures its
creation timestamp to delivery acknowledgement. This measures session acceptance,
not a successful model answer. Runtime logs include a Codex user-namespace warning.

Each successful cycle checks a persisted file's contents and ownership, the home
and repository links, the open-network marker, inactive firewall service, and
absence of Zuse's egress table. The first cycle repeats these checks after 75
seconds to catch a late boot job. This delay is outside the measured interval.

An earlier fresh allocation (`workspace_YIFfaLXcT-plEhit`) failed with
`syncing-repository-failed` before resume testing. Its detailed diagnostic was not
captured before cleanup, so the cause is unresolved. The subsequent allocation
completed startup. Do not omit that failure when assessing rollout readiness.

## Results

Durations in seconds. The provider-resume total includes its nested stages;
file installation overlaps network preparation.

| Operation | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Box usable-state wait | 33.040 | 33.075 | 37.843 |
| Combined resume preparation command | 1.427 | 52.110 | 7.309 |
| Entire provider resume | 34.974 | 85.864 | 45.704 |
| Open network preparation | 1.994 | 2.301 | 2.827 |
| Signing-key installation, overlapping network | 2.055 | 2.409 | 2.814 |
| Runtime replacement | 1.093 | 1.685 | 1.405 |
| API message creation to delivery | **54.876** | **107.381** | **65.046** |

Median delivery is **65.046 seconds**, mean **75.768 seconds**. The prior
three-run series had a 32.692-second median and 30.957–84.724-second range;
its final-source extra sample was 67.420 seconds. These are different instances
at different times, not a randomized matched comparison. There is **no measured
overall speedup**. Open-network preparation is consistently shorter than the
previous 6.285–45.799-second observations, but provider readiness and command
completion remain variable.

The 52.110-second preparation measurement includes the provider request and all
guest work. It is not proof of 52 seconds spent copying files, restoring disk,
or waiting on a firewall. The healthy path contains no copy, recursive chown,
or explicit sleep. Further diagnosis needs timestamps inside the command to
separate provider dispatch, filesystem access, and repair-path execution.

All three post-resume persistence/network checks passed, as did the delayed
75-second check. The benchmark deleted its workspace and revoked its temporary
API key. Validation: 319 API and 95 provider tests, both type checks, applicable
Biome checks, and shell syntax checks passed. E2B code was unchanged in this
experiment; it was not live-benchmarked again.

Sanitized API timing events and controller results: [JSON](2026-09-16-box-open-workspace.json).
