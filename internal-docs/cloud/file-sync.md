# Cloud-to-local repository snapshots

The source of truth is the cloud working tree, not a filesystem event stream.
Ready cloud catalog entries start sync independently of the legacy environment
catalog. A ready transition during queued teardown is reconciled after teardown
completes, so reconnection cannot lose the restart.
The desktop starts a scan immediately after access preparation, then scans every
30 seconds after completion. A hint can accelerate a scan, subject to a 15-second
batch interval. Activity never postpones scans or invalidates completed downloads.
Only one scan/apply operation runs per workspace. Disable and reconnect cancel and
join the previous operation before starting another.

## Selection

The remote helper uses `git ls-files --cached --others --exclude-standard -z`.
Git handles nested ignore files, negations, `.git/info/exclude`, and configured
global excludes. Tracked outputs remain included regardless of ignore rules.
Deleted tracked paths are absent. Initialized submodules are enumerated recursively;
uninitialized submodules and unsupported special files produce explicit errors.
Non-Git directories produce errors, not an unrestricted directory copy.

The only reserved names are Git metadata and `.zuse-sync.json`. There are no
language, framework, cache, log, or build-directory heuristics. An untracked output
not ignored by Git is intentionally considered repository content.

## Transfer and publication

The Mac sends a baseline verified against actual local contents and completed
objects in a persistent sibling cache (`<localPath>.zuse-sync-cache`). The remote
Python standard-library helper reuses hashes when device, inode, size, nanosecond
mtime/ctime, and mode match the prior source signature. Otherwise it hashes and
snapshots one file at a time outside the repository, with bounded memory. It verifies
file identity, size, mtime and ctime across the read, retrying a changing file up to three
times. The stream contains JSON metadata followed by exact-sized binary bodies
for changed files only. Symlinks are transmitted as links, never followed during traversal.
A completion record and successful subprocess exit are both required.

The desktop uses SSH only to launch a short-lived archive producer. It sends a
compressed baseline, receives a small descriptor, and downloads the compressed
snapshot through the existing authenticated workspace gateway file-read RPC.
This bypasses the provider's public port proxy for bulk data. Archive parts are
at most 4 MB, with two reads in flight, below the RPC's file/message limits.
They are never written into the
live checkout. No new public listener, provider port, or runtime deployment is
required.

The helper uses a private temporary directory, checks the snapshot producer's
exit status, and waits for the desktop's completion acknowledgement before
removing it. Disconnects, cancellation, and a ten-minute hard lifetime also clean
up. Renderer gateway requests are correlated, cancellable, and limited to 30
seconds. Late replies cannot complete another worker's request.

The receiver validates relative paths, rejects ancestor conflicts, verifies SHA-256
and stages all changed files outside the checkout. Incomplete, corrupt or failed
streams cannot publish. Completed objects and a receipt journal survive failed
transfers, so retries reuse verified files. Incomplete objects are never accepted.
Successful transfers compact the journal and prune obsolete objects. Local parent
symlinks are rejected rather than followed.
The helper emits progress during long snapshot reads. There is a 60-second
no-progress timeout, gateway request cancellation, and TERM/KILL cancellation for SSH.

Publication preflights destination conflicts, writes an ownership journal, renames
complete files, removes only previously managed paths, and commits the new manifest.
This is not an atomic whole-repository transaction. A process/disk failure during
publication can leave a partially published batch; the ownership journal and local
content verification allow the next scan to repair it without losing deletion
ownership. Local-only files are never recursively deleted to make room for a file.

`.zuse-sync.json` records workspace identity and committed/pending owned paths.
Existing legacy markers are adopted with an empty ownership list: files from old
sync that are no longer selected are left alone because their ownership is unknown.
Markers belonging to another workspace are rejected. No-op scans do not rewrite
files or the marker. An explicit manifest reset is never automatic.

## Tradeoffs

The desktop verifies local and cached bytes each scan; remote hashing uses source
metadata to skip unchanged files. Network transfer is incremental and memory is
bounded per file, but local verification cost scales with selected repository size.
Ignoring generated output is the repository's responsibility.
Publication groups complete-file replacements into a batch; filesystem watchers
still receive individual file events, so a single hot reload cannot be guaranteed.
Individual-file snapshots are validated, but concurrent edits across different
files are not a transaction. A later scan converges without waiting for global quiet.

The renderer prepares SSH access with a bounded wait and starts the desktop worker;
it does not subscribe to `fs.watchTree`. Cancelled setup cannot later start a worker,
and rejected desktop configuration is an error, not permanent “Waiting”.

The menu and local terminal share status presentation. Idle is shown as paused;
setup, scanning, receiving (file counts and received bytes), and publication are
distinct. Transfer progress updates are throttled to four per second. Initial sync
still depends on gateway throughput; progress does not imply publication
until the complete batch verifies.
