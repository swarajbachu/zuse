# Desktop release channels

Zuse has one desktop installation and one data profile. Settings → General →
Updates selects **Stable** or **Preview**. Existing installations default to
Stable. Preview users receive early builds and newer Stable releases without
losing their Preview preference.

Switching to Stable checks for the current Stable release immediately. When the
installed version is a Preview, this explicit choice also authorizes a downgrade
on restart. That authorization is saved for that installed version only; ordinary
update checks never downgrade a Stable installation. Channel changes revoke any
previously downloaded update before waiting for active work to finish.

## Publishing

Use the GitHub Actions **release** workflow on `main`:

- **Preview:** select `preview`, supply a target such as `0.22.0`, an optional
  commit on `main`, and curated Markdown release notes. The workflow allocates
  `0.22.0-preview.N` using existing tags and releases, including draft reservations.
- **Stable promotion:** select `stable`, supply a published tag such as
  `v0.22.0-preview.3`, and curated notes covering everything since the previous
  Stable release. The workflow rebuilds that exact source commit as `0.22.0`.
- **Bootstrap and Stable fixes:** the existing `vX.Y.Z` tag workflow remains
  available. The package version is set from the tag, and notes come from that
  version's `CHANGELOG.md` section. The existing release PR helper uses the
  published Stable release as its baseline, including after manual promotions.

Use `### Added`, `### Changed`, and `### Fixed` sections, omitting empty sections.
Notes are embedded in updater manifests and published on GitHub. Manual promotion
changes the packaged version; it does not create a version-bump commit on `main`.
GitHub's current Stable release is the authoritative release baseline.

Both platform builds and verification must finish before publication. macOS
retains the signed, notarized universal DMG and updater ZIP; Linux retains
AppImage and deb packages. The final job verifies manifest versions, sizes, and
SHA-512 hashes, uploads to a draft, verifies the uploaded asset inventory, then
publishes. Preview releases are explicitly prereleases and never marked Latest.
Allocation and publication are serialized across both channels.

For build failures, rerun the failed jobs. A failed upload remains a draft;
rerunning the publication job reuses that draft. A new manual invocation never
reuses an existing version tag. Inspect a failed Stable promotion before retrying;
do not delete tags that users may already have installed.

## Compatibility and rollout

Until channel support ships in Stable, install the first Preview by downloading
its installer from GitHub, then select Preview in Settings to receive subsequent
Preview updates. Existing Stable installations stay on Stable. Publishing a
Preview never implicitly publishes a bootstrap Stable release.

Preview data must remain readable and writable by current Stable. CI gates
publication by running the
**actual Stable checkout**, the Preview checkout, and Stable again against one
isolated data directory. The test harness is copied into older Stable checkouts;
their production migrations and persistence code remain unchanged. Each stage reads and writes chats, sessions, and global
settings through the shipped migrations and config store, and checks SQLite
integrity. Extend this probe whenever new durable data behavior is introduced;
a passing representative probe is not a proof for every possible user database.

Incompatible migrations must be deferred to a separately reviewed Stable change.
The shared profile is never restored from an old backup during a channel switch.
Cloud runtime release channels are independent and unchanged.

Before the first public Preview, exercise signed macOS update/relaunch and Linux
AppImage update flows with test installations. Test Stable → Preview, a later
Preview, Preview → promoted Stable, and explicit Preview → older Stable. These
native installation checks require packaged artifacts; unit tests do not replace
them.
