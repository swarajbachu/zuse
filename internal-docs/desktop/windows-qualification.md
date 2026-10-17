# Windows release qualification

Windows support is under qualification. A successful hosted CI job is not evidence
that the installed application is reliable on a 4 GB laptop. Windows artifacts are
not included in the public release publisher or update feeds yet.

## Latest setup candidate

The owner's `windows-support` branch at `a6d0f103` was tested with `bun dev`,
not an installed EXE. Its duplicate `win`/`nsis` YAML sections prevented packaging
in [run 39041498860](https://github.com/swarajbachu/zuse/actions/runs/39041498860).
The integrated branch retains the project-loading, provider, and cold-start fixes,
combines the installer sections, preserves native-file pruning and user data, and
adds desktop/Start menu shortcuts. A config regression test covers this failure.
Unsigned Windows publication remains excluded from the public release pipeline.

[Run 39043451240](https://github.com/swarajbachu/zuse/actions/runs/39043451240)
passed at `586c5a42` on 2026-10-17, including native runtime checks, two development
launches, installation, twenty installed launches across reinstall, preference
preservation, protocol registration, uninstall, and engine/provider recovery.
The [current setup artifact](https://github.com/swarajbachu/zuse/actions/runs/39043451240)
contains the `windows-candidate-<run-id>` artifact with
`Zuse-0.22.1-windows-x64-setup.exe`; extract the ZIP before running it.
It is unsigned and retained for seven days. Rerun the **Windows compatibility**
workflow from the Actions tab when a fresh candidate is needed. The laptop's installed-app test and
constrained-device qualification remain outstanding.

On the hosted runner, median readiness was 6.02 s before reinstall and 6.01 s after
reinstall; median summed startup working sets were 894 MiB and 913 MiB respectively.
No matching Application crash events were recorded. These are startup snapshots
on the hosted runner, not a 4 GB soak or evidence of sustained memory behavior.

## Earlier passing compatibility candidate

[Windows CI run 38954164943](https://github.com/swarajbachu/zuse/actions/runs/38954164943)
passed at `17eef7b3` on 2026-10-16. The runner reported Windows build
`10.0.26100`, approximately 16 GB RAM, and four logical processors.

It passed dependency installation/native rebuilding, Biome, desktop/system types,
focused regressions, two `bun dev` launches with cleanup, packaging, and native
SQLite, Credential Manager, SDK, tree-sitter, and PowerShell PTY checks. The
installer completed under a path with spaces and Unicode, followed by ten cold
launches, same-version reinstall, ten existing-profile launches, saved-channel
preservation, protocol registration, and uninstall. The repeated launch test
exposed an updater IPC startup race; handlers now register before renderer
navigation instead of waiting for engine startup.

Engine tests also passed detach/reattach, worker crash with durable data recovery,
linked-account HTTP outage, active-provider update refusal, interrupted provider
tool cleanup without command replay, supervisor shutdown, authenticated idle
shutdown, and rejection of mismatched engine builds before modifying data.
No matching Application crash events were recorded.

| Installed startup samples | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: |
| First install: readiness (10 launches) | 5.19 s | 5.42 s | 7.48 s |
| Reinstalled: readiness (10 launches) | 5.20 s | 5.57 s | 5.80 s |
| First install: summed working set | 890 MiB | 908 MiB | 923 MiB |
| Reinstalled: summed working set | 892 MiB | 912 MiB | 919 MiB |

Memory is a process-tree snapshot at readiness, not peak, steady idle, or active
agent memory. Working sets can double-count shared pages. These measurements do
not establish constrained-device budgets or a memory-growth trend.

The [unsigned internal installer](https://github.com/swarajbachu/zuse/actions/runs/38954164943)
and diagnostic reports are retained for seven days. This is an internal test
candidate at the repository version, not a signed/public Preview release. The
Preview pipeline supplies release metadata when producing a release candidate.
Signing, the constrained one-hour soak, real deep-link delivery, cross-version
updates, and the remaining manual/provider scenarios below remain release gates.

## Initial Windows evidence

The [2026-10-16 compatibility run](https://github.com/swarajbachu/zuse/actions/runs/38936057456)
at `16a76003` passed native rebuilding, Biome, type checks, focused regression
tests, and two development launches. Its Windows build was `10.0.26100`, with
16 GB RAM and four logical processors. Engine readiness took 23.5 and 13.4 seconds;
both runs exited with code 0 and no observed surviving processes. Sampled summed
development process working sets peaked at 3,693 and 3,760 MiB. These sums can
double-count shared pages; they describe development tooling, not installed-app
memory or a 4 GB qualification. The laptop's original crash remains unconfirmed.
Later testing exposed stale Windows parent PIDs being attributed to newly created
processes. The collector now records creation times and rejects those relationships;
retain the initial totals as provisional evidence, not qualification baselines.

That run then stopped at the renderer bundle budget: 554.7 KiB versus the 501 KiB
default-route limit. The renderer build plugin compared native Windows paths with
Vite-normalized paths, preventing its existing schema test-data exclusion from
matching. The Windows fix normalizes those paths and retains the original budget.

The later [installer run](https://github.com/swarajbachu/zuse/actions/runs/38944633238)
passed packaged native checks, then its first NSIS installation exited with
`0xC0000005`. The pinned app-builder-lib template contains the known unsafe
fixed-size shell-path read. `patches/app-builder-lib@25.1.8.patch` backports the
[upstream bounded-copy fix](https://github.com/electron-userland/electron-builder/commit/a356198ec7c54c7795659342bff36d9a5162cd93).
The next run completed installation without the crash but exposed the legacy
`/D=` parser truncating paths at spaces. The patch also backports the upstream
`GetDParameter` parser from that same pinned template. Remove it when upgrading
to a version containing both fixes. Windows CI
retains bounded Application crash events to distinguish subsequent failures.

Provider subprocesses use the shared `@zuse/utils/spawn-command` launcher, which
uses cross-spawn on Windows for npm `.cmd` wrappers and native Node spawning on
other systems. ACP shutdown uses the existing owned-process tree cleanup.

## Build and compatibility lane

Use Node 24 and Bun 1.3.10 on native Windows x64, with Visual Studio C++ build tools
(including Spectre-mitigated libraries) and Python available for native modules.
Run `bun install --frozen-lockfile` from the repository root. If a previous install
was interrupted, run `bun run --cwd apps/desktop postinstall` explicitly.
The rebuild script supplies the Bun workspace root to electron-rebuild and fails
if either node-pty or keytar was not found. It builds sequentially.

`bun dev` is the normal development entrypoint. It uses the shared owned-process
cleanup for build tooling and a private IPC quit request for the desktop shell.
The engine intentionally survives shell reloads; Windows taskkill on that shell's
whole tree would also kill the engine. Unresponsive shell shutdown still falls
back to terminating the shell. Crash/forced-shutdown descendant cleanup remains a
Windows qualification case; a successful graceful quit does not prove it.

`bun run build:desktop` builds the renderer once, then bundles Electron from
workspace source. It does not build the independently distributed server package.
Electron executable entrypoints do not generate TypeScript declaration files;
`check-types` remains a separate required check.

- `bun run dist:win:unsigned`: internal NSIS candidate, never publishes.
- `bun run dist:win`: requires code signing and never publishes.
- `bun run --cwd apps/desktop check-package:win`: validates archive contents and
  native runtime loading, SQLite, Credential Manager round-trip, and PowerShell PTY.

The **Windows compatibility** workflow can run manually and on non-main pushes
that change desktop/Windows test files. Preview release preparation also calls it.
It runs development startup twice, checks cleanup, packages the app, installs it
under a path containing spaces and Unicode, cold-launches it ten times, reinstalls,
verifies saved update-channel preferences, checks protocol registration, and
uninstalls. Existing engine recovery/provider-fixture checks also run. Reinstalling
the same version is not a cross-version update test. Protocol registration is not
an end-to-end OAuth/deep-link delivery test.

Reports and bounded sanitized development logs are uploaded as
`windows-diagnostics-<run-id>`. Successful installers are uploaded as internal
`windows-candidate-<run-id>` artifacts. Application profiles and tokens are not
uploaded. Never publish these unsigned artifacts to the public update feed.

## 4 GB qualification

Use Windows 11 x64 with 4 GB physical/assigned RAM and two logical processors.
Build on a separate machine and transfer the installer; do not benchmark with
watchers, a compiler, or development tools running. Hosted Windows Server CI does
not replace this test. Keep the Windows page-file setting and graphics driver
version in the report, along with the build SHA and hardware details.

After installing, run ten cold launches using the packaged smoke script. For
memory/responsiveness capture, use an isolated test profile, log in to a test
account, and exercise one agent, continuous terminal output, and a long transcript:

```powershell
node --import tsx tests/system/scripts/packaged-desktop-smoke.ts 'C:\path\Zuse.exe'
node --import tsx tests/system/scripts/windows-soak.ts 'C:\path\Zuse.exe' 'C:\zuse-test-profile'
```

The soak collects one hour of process-tree working sets (including the persistent
engine), system free memory, workload counts, and renderer IPC round-trip latency.
It requires observing an active agent and a terminal. It is operator-driven; it
does not invent activity or automatically verify every user interaction. Working
sets can count shared pages more than once and must be interpreted alongside
system memory pressure. The renderer probe is not a full interaction-latency test.

The first run is **baseline only**, never a passing qualification. Before changing
performance behavior, record agreed positive budgets in a JSON file with keys
`peakWorkingSetBytes`, `workingSetGrowthBytes`, and `p95RendererProbeMs`, then rerun
with that file as the third argument. Growth compares the first and last 30
samples; use comparable workloads in those windows. Retain evidence under
`.context/windows/soak/` for review before another run overwrites it.

Release gates still require:

- No crashes, lost sessions, unexplained restarts, sustained memory growth, or
  orphaned owned helpers; distinguish the intentionally persistent engine.
- Fresh/existing profiles, offline startup, interrupted streaming, engine crash
  recovery, long chat scrolling, and terminal responsiveness.
- Real `zuse://` cold/warm delivery and authentication callback handling.
- Signed installation and a real previous-version → candidate update, preserving
  credentials, projects, transcripts, and user settings, followed by uninstall.
- A passing constrained soak with baseline budgets and manually verified work.

Do not add Windows artifacts to the public publisher until these gates have
recorded passing evidence. Signing credentials and a constrained Windows machine
are external prerequisites, not outcomes of Linux tests.

## Reference review

T3 Code was inspected at commit
`cfafb4bb54d244e4612f5681aad3832ea64cb0fb`: desktop package scripts, the development
runner, and its [Windows workflow](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/.github/workflows/windows-tests.yml).
Its dedicated Windows lane explicitly described incomplete test compatibility.
Adopt the dedicated diagnostic lane and native-runtime checks, not an assumption
that its code is already Windows-qualified. No T3 application code is imported.
