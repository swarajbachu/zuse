# Spike result sheet — <provider>

Date: · SDK version: · Machine shape: · Base image/template:

## Gate results

| Gate | Threshold | Measured | Pass |
| --- | --- | --- | --- |
| Fork with live processes (all 6 workload processes, same PIDs/start ticks) | all survive on 10/10 descendants | | |
| SQLite integrity + post-fork writes | `integrity_check=ok`, history advances | | |
| Descendant divergence (boot id–stamped rows, marker files) | independent on 10/10 | | |
| File watcher observes post-fork changes | yes | | |
| Headless Chromium CDP | `/json/version` answers post-fork | | |
| Electron under Xvfb + CDP | window live, `/json/version` answers | | |
| Evidence video recorded + shipped | 90 s, 1440x900, 24 fps, H.264, intact off-box | | |
| Source interruption | p95 ≤ 5 s | | |
| Fork-to-command | p95 ≤ 5 s | | |
| Fork-to-healthy | p95 ≤ 15 s | | |
| Fork-to-CDP | (record; informs preview UX) | | |
| Lifecycle error rate | < 1% | | |
| Cleanup convergence | zero orphaned machines/snapshots after delete | | |

## Latency distribution (10-descendant functional pass)

| Metric | p50 | p95 | max | errors |
| --- | --- | --- | --- | --- |
| fork-to-command | | | | |
| fork-to-healthy | | | | |
| fork-to-CDP | | | | |

## Broke on fork (and workaround)

- sockets / PTYs:
- tunnel connector + URL routing:
- clocks (wall vs monotonic jump):
- other:

## Cost observed

- machine-hour rate at this shape: · snapshot storage: · evidence egress:

## Deferred phases (run before the final lock if functional pass holds)

- [ ] 100-machine (or max-permitted) saturation + throttling behavior
- [ ] 4 h pause → resume → health + real bill inspection
- [ ] Failure injection: API timeout, snapshot-during-write, killed tunnel,
      expired credential, lost WebSocket, failed resume — idempotent retries,
      no duplicate descendants, partial fleet fully discoverable + deletable

## Verdict

Fallback (if any leg failed) and its UX cost:
