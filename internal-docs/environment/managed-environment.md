# App-managed environment

## Rollout

This is the personal-vault implementation. Team entries are rejected server-side and `teamEnabled` remains false. Enable Team only after the organization branch supplies membership authorization and shared-execution isolation; a team “use” grant permits reading the value in code.

Apply API migration `0034_environment_vault.sql` through the normal migration workflow before setting `ENVIRONMENT_VAULT_ENABLED=true` on the API worker. The flag defaults off. The existing `CLOUD_DATA_ENCRYPTION_KEY` encrypts the vault. Deploy compatible desktop, server, and cloud runtimes together before enabling it. No runtime directory or database is replaced by this feature.

The Environment settings page contains account metadata, explicit reveal/copy, editing, import, defaults, selected projects, and exclusions. `.env` import treats expressions as literal data. Successful edits affect new processes; running processes retain their previous environment. Restart notices do not terminate them.

## Identity and authorization

`infra/api` owns an encrypted aggregate per `[accountId, organizationId|null]`. WorkOS authentication gates management and local resolution. Sandbox runtime credentials can resolve only the project derived from their authorized workspace; they cannot list, reveal, or modify the vault. Existing runtime expiry and lifecycle fences also apply to resolution.

Local checkouts receive a stable account project UUID on first resolution. The local metadata file maps account/context/folder IDs to account project IDs; it contains no values. To use the same project-specific values in local and cloud, explicitly choose the cloud project's identity in the local repository Environment panel. Names and filesystem paths never establish cross-machine identity. All-project defaults work for newly registered projects automatically.

Account and organization contexts are distinct. This branch does not authorize shared workspaces or Team entries. Metadata lists and effective previews omit values. Reveal is an explicit operation. Updates use aggregate revision comparison and a database compare-and-swap; stale writes fail instead of overwriting.

## Execution and disclosure

`EnvironmentRuntime` resolves once per launch. It supplies an immutable-by-convention value record through server-only launch interfaces. It does not mutate `process.env`, public session inputs, repository configuration, cloud bootstrap payloads, image builds, or durable launch records.

Coverage includes PTYs and applications started through them, setup/run/archive scripts, and Claude, Codex, Grok, Gemini, Kiro, Pi, and OpenCode process launches. Child processes, including session-owned MCP subprocesses, inherit the environment. Standalone MCP probes have no project grant and receive no managed values. Cursor's in-process SDK has no per-session environment API; its permission-checked `run_with_environment` custom tool launches commands with the resolved environment. Cursor's other built-in tools do not acquire these values.

Zuse's terminal journal, setup/archive output, and provider event persistence mask known Secret values. Streaming masking withholds incomplete suffixes until subsequent data disambiguates them. Agent guidance contains names only. Raw payload diagnostics are disabled for managed-environment agent sessions before truncation or logging. Subprocess stdin and pipes remain unchanged, so deployment tools receive exact values.

Masking is accidental-disclosure mitigation. Code can read injected values. Encoded output, deliberate network exfiltration, third-party provider transcripts, and files written by child processes are outside the masking guarantee. Values already delivered cannot be recalled; revoke future resolution and rotate exposed credentials.

## Offline behavior

Personal cache entries use the existing native OS-backed master-key CredentialsService. Headless/file-backed credentials explicitly do not enable offline caching. Cache keys include account, organization context, and project. Concurrent cache writes serialize; account changes are rechecked around delivery and writes. Logout clears caches.

Only transport failures or an explicitly classified token-refresh network failure permit cached personal values. HTTP authorization/not-found responses and invalid authentication clear caches and fail closed. Cloud values stay in runtime memory and always require a fresh authorized resolution for a new execution context. The project panel exposes the last cached sync time after offline use.

## Encryption and rotation

Both Secret and Variable values are encrypted. The authenticated envelope binds owner, aggregate revision, and encryption-key version; authenticated document contents include entry IDs/revisions. The key identifier is derived from the key, never from a value.

For rotation, retain the old key in the secret `CLOUD_DATA_PREVIOUS_ENCRYPTION_KEYS` (comma-separated), configure the new `CLOUD_DATA_ENCRYPTION_KEY`, and deploy. Reads accept previous versions; any subsequent write uses the current key. The authenticated `rotate` vault command with `expectedRevision` re-encrypts an unchanged vault under the new key and advances its aggregate revision. Keep previous keys until **every vault and other legacy encrypted cloud record** has migrated. This command does not rotate unrelated cloud records. Never put encryption keys in checked-in worker configuration.

## Migration

“Move to Environment” previews names, saves encrypted project entries, explicitly reads them back to verify values, and then offers removal from repository settings. Cloud-only assignments remain cloud-only; an overriding cloud value causes the legacy default to be local-only. Partial migrations preserve original values and can retry already-verified identical entries. Conflicting existing values stop migration. Changed repository values invalidate the removal action. No `.env` files are discovered or uploaded automatically. Removing current values does not remove them from Git history.

## Validation and release gate

Behavior tests cover resolution precedence, exclusions, cross-account/context isolation, revision conflicts, encryption bindings/rotation, bounded import parsing, personal offline caching, authorization denial, authenticated cloud resolution, runtime-token management denial, PTY replay masking, and a real local HTTP deployment receiving the exact secret through stdin. Provider regression tests cover existing translation and protocol behavior.

The UI was exercised with the actual renderer components and an in-memory control-plane fixture: add, masked list, explicit reveal, edit, and failed-save state. This is not live WorkOS or deployed-cloud verification. Before enabling the production flag, validate real native keychain behavior and local/cloud launch, pause/resume, upgrade of a populated workspace, account removal, and cloud reconnect with deployed credentials. The existing cloud bootstrap/recovery regression suite remains mandatory. Organization acceptance tests remain gated with Team support.
