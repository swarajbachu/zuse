# Box resume measurements — 2026-09-16

The systemd implementation did **not demonstrate a resume speed improvement**.
Baseline median was **37.87 s**; systemd median was **58.51 s**. Each series has only
three samples, and Box restore/preparation time varied substantially even though
that code is identical in both versions. Do not interpret the difference as a
causal systemd slowdown or a production percentile.

Measured on one disposable small Box, from `zuse-base-v5`, using the real published
Zuse server. Baseline adapter: `512f0f7745eb0b239bd6a54c3a0abaab8cdfd6c5`.
All columns are seconds from the same client clock. Network time includes retries.

| Sample | Restore/preparation | Network | Launch | Server health | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before 1 | 6.79 | 29.41 | 0.42 | 1.25 | 37.87 |
| Before 2 | 12.49 | 34.74 | 0.58 | 1.31 | 49.12 |
| Before 3 | 9.89 | 18.91 | 0.61 | 1.38 | 30.79 |
| Systemd 1 | 42.98 | 10.14 | 1.30 | 4.09 | 58.51 |
| Systemd 2 | 52.69 | 19.92 | 1.37 | 4.79 | 78.76 |
| Systemd 3 | 10.69 | 16.03 | 0.29 | 0.57 | 27.59 |

A follow-up run of the **original adapter**, using the same final runner, took
**65.45 s**: restore/preparation 52.69 s, network 7.82 s, launch 1.38 s, and
server health 3.55 s. This also shows the later restore slowdown in unchanged
code; the measurements do not isolate a systemd speed benefit.

The implementation manages tagged processes with transient systemd services,
performs replacement in one provider command, and stops the entire process tree.
Live checks confirmed literal environment values (including dollar syntax,
quotes, percent signs, newlines, and Unicode), the target UID/home, and cleanup
of a child that detached with `setsid`. E2B and untagged commands are unchanged.

These are adapter-to-server measurements, **not authenticated chat readiness**.
They exclude API scheduling, boot-token exchange, agent/session recovery, runtime
update downloads, and model response time. The later runner additionally checked
health three seconds after startup. Initial baseline samples used a prototype
runner without that post-start stability check; the follow-up control uses the
same checked-in runner as the systemd series.

An earlier experiment explicitly started the restored firewall unit to skip the
existing readiness wait. It had two successful samples (108.0 s and 67.6 s) and
two startup failures, including the file-ownership failure recorded in the raw
results. That optimization was removed. Initial baseline exploration also hit a
provider 502 and exhausted firewall waits; none are represented as successful
measurements in this table. This remains an exploratory test, not an availability
estimate.

The firewall readiness boundary and fresh boot-token authorization remain intact.
Systemd does not restore RAM, bypass disk restore, or automatically replay an
already consumed runtime boot token. The change has not been deployed to staging
or production; it should be reviewed as process management, not a proven latency
optimization.

See [the reproducible runner](../box-resume-benchmark.md) and
[raw measurements](./2026-09-16-box-resume.json).
