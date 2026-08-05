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
