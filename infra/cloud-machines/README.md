# Managed cloud-machine infrastructure

This directory contains the provider-neutral bootstrap assets for the
invite-only persistent-machine alpha.

The provider adapter must render every `__PLACEHOLDER__` in
`bootstrap/cloud-init.yaml.tmpl`, attach the pre-created shared firewall with
zero inbound rules, and send the resulting document as cloud-init user data.
The host firewall is an independent second layer: it permits SSH and the Zuse
RPC port only on the private-network interface.

`__INSTALL_VERIFIED_RUNTIME_COMMAND__` must install the release selected by the
signed stable manifest into `/opt/zuse/releases/<version>` and atomically point
`/opt/zuse/current` at it. The same verification and rollback policy is
implemented by `apps/server/scripts/runtime-updater.mjs`.

The enrollment file is root-owned mode `0600`. The runtime consumes it once,
persists only the issued environment credential in its file credential store,
then unlinks the enrollment file. Private-network auth keys are accepted only
through the authenticated machine RPC and are removed immediately after the
network client exits.
