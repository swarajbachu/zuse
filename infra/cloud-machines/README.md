# Managed cloud-machine infrastructure

This directory contains the provider-neutral bootstrap assets for the
invite-only persistent-machine alpha.

The provider adapter must render every `__PLACEHOLDER__` in
`bootstrap/cloud-init.yaml.tmpl`, attach the pre-created shared firewall with
zero inbound rules, and send the resulting document as cloud-init user data.
The host firewall is an independent second layer: it permits SSH and the Zuse
RPC port only on the private-network interface.

Cloud-init embeds `apps/server/scripts/runtime-updater.mjs` as the verified
first-install program. It installs the release selected by the signed stable
manifest into a content-addressed directory under `/opt/zuse/releases` and
atomically points `/opt/zuse/current` at it. The installed copy runs daily and
uses the same signature, hash, compatibility, health-check, and rollback policy.

`.github/workflows/cloud-runtime-staging.yml` publishes the staging channel on
every relevant `main` change. Archives are named by the full source commit SHA;
the stable manifest is uploaded last so clients either install a matching
immutable archive or reject the update and retry later. The signing private JWK
lives only in the GitHub Actions secret
`ZUSE_RUNTIME_SIGNING_PRIVATE_JWK`; cloud-init receives only the public JWK.

The enrollment file is root-owned mode `0600`. The runtime consumes it once,
persists only the issued environment credential in its file credential store,
then unlinks the enrollment file. Private-network auth keys are accepted only
through the authenticated machine RPC and are removed immediately after the
network client exits.

## Developer tools and account access

The signed runtime archive also carries a versioned developer-toolchain
manifest and reconciler. Cloud-init installs that exact manifest after the
runtime, and the daily updater reconciles it again so existing machines receive
validated Git, shell-tool, GitHub CLI, Claude, and Codex versions without being
recreated. Provisioning reports runtime, developer-tool, Zuse-health, and
account-setup stages independently; account authorization is not required for
the machine to become healthy.

Account setup never copies local credential directories. GitHub and Codex use
their supported remote login flows. Claude receives only a short-lived,
environment-bound encrypted credential transfer initiated by the local control
plane. Credentials are absent from API payloads, database rows, renderer
state, and mobile storage.

Ordinary provider backups intentionally preserve the machine's authenticated
CLI state and must be treated as secret-bearing infrastructure. Before a final
retained snapshot, the API requests credential cleanup, the runtime removes
and verifies the known Zuse, GitHub, Claude, and Codex credential files, and
systemd stops the complete Zuse process group. If that handshake cannot be
verified, reconciliation skips the snapshot and deletes the server and bound
backups instead of retaining active credentials.
