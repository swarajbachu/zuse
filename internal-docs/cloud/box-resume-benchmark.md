# Box resume benchmark

Run `infra/cloud-sandboxes/box-resume-benchmark.ts` with Bun and a Box key in
`BOX_API_KEY`. It creates a disposable small Box from `BOX_TEMPLATE_SNAPSHOT`,
starts the published Zuse server with account linking disabled, and measures
three archive/resume cycles. The account is billed for this live test.

```bash
BOX_TEMPLATE_SNAPSHOT=zuse-base-v5 \
BOX_BENCH_VARIANT=current \
bun infra/cloud-sandboxes/box-resume-benchmark.ts
```

The key is read from the environment and is never written to the results.
Results go to `.context/box-resume-benchmark/current.json`. The test deletes its
Box on completion or failure. Use `BOX_BENCH_KEEP=1` to pause it instead, then
`BOX_BENCH_REUSE_ID` to compare another revision against the same disk state.
Only Boxes named `zuse-resume-benchmark-*` may be reused. Confirm archival has
finished before reusing a kept Box. `BOX_BENCH_ADAPTER` accepts an absolute path
to a checked-out adapter revision; its relative imports must remain resolvable.
`BOX_BENCH_ROUNDS` accepts 1–10 and `BOX_BENCH_OUTPUT` overrides the result path.

The timer starts immediately before `adapter.resume`. It separately records:

- Resume: provider restore, persistent filesystem preparation, and restored policy.
- Network: the requested open policy, including any readiness retries.
- Launch: replacing the tagged runtime process.
- Runtime readiness: polling the real server's loopback `/healthz` endpoint.

The runner waits for archival before timing and verifies health again three
seconds after readiness. Failures are recorded, not discarded. Network retries
wait one second and are included in elapsed time; this deliberately avoids
counting a transient provider response as a successful resume.

This measures adapter-to-server readiness from the benchmark client. It does
not measure the desktop composer, API reconciliation scheduling, runtime update
downloads, authenticated cloud bootstrap, restored agent sessions, or first model
token. Public API/staging chat tests are still needed for end-to-end latency.
Box hardware, snapshot layers, and storage caching vary between resumes, so
small samples do not establish a production percentile or a causal speedup.

## Systemd behavior

Tagged Box processes use transient systemd services, with full control-group
cleanup on replacement. Untagged commands keep their detached provider launch.
The service is started explicitly after the API authorizes a fresh runtime boot
and generation. `Restart=no` is intentional: replaying a consumed cloud boot token
with freshly generated runtime keys fails authentication. Automatic process
restarts would need a separate credential/re-enrollment design.

The launcher preserves account environment, target user/home, cwd, and literal
shell arguments. It disables systemd's own variable expansion so embedded shell
syntax and credentials arrive unchanged; this requires systemd 254 or later
(the tested Box base has 255). See the [systemd 255 run documentation](https://github.com/systemd/systemd/blob/v255/man/systemd-run.xml).

The existing firewall readiness boundary remains in place. An experiment that
explicitly started restored firewall units earlier shortened that gate but
produced runtime startup failures, including a temporary file owned by UID 1000
while Zuse ran as UID 1001. That experiment was removed rather than treating early
VM availability as proof that runtime storage was ready.

Setup failures are recorded as `round: 0`, `phase: "setup"`. Each numbered round
records failures from its pre-round health check, pause, archive polling, and
resume/launch checks. Failed `elapsedMs` covers the whole attempted round;
successful `totalMs` remains resume-to-health time and excludes archival.
