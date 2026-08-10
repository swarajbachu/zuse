# Cloud sandbox template

This image contains the managed Zuse server and the supported developer
toolchain. The image's inert `sleep infinity` command is deliberate: template
start commands run while the template is built and cannot receive the
per-sandbox enrollment variables supplied to `Sandbox.create`. The relay starts
`/usr/local/bin/zuse-entrypoint` through the sandbox process API immediately
after creation instead.

Node 22 is intentional. It satisfies the server's runtime floor and remains
compatible with the native tree-sitter dependency; Node 24 currently forces an
incompatible source rebuild of that dependency on Linux.

## Build and configure staging

Build the server tarballs from this exact checkout first. This avoids depending
on a separately published runtime and keeps the external-bind behavior atomic
with the relay change:

```sh
infra/cloud-sandboxes/prepare-artifacts.sh
```

Authenticate the provider CLI with a team access token, then create the current
Dockerfile-based template:

```sh
npx --yes @e2b/cli@latest template create zuse-cloud-sandbox \
  --path infra/cloud-sandboxes \
  --cmd "sleep infinity" \
  --ready-cmd "true" \
  --cpu-count 2 \
  --memory-mb 4096
```

The current CLI's `template create` command is used instead of the legacy
`e2b.toml` workflow. This provider's template ID stays inside its adapter
configuration; it is not part of the provider-neutral Cloud Sandbox offer.
Copy the resulting template ID to `E2B_TEMPLATE_ID`, set the `E2B_API_KEY`
Worker secret with
`bun --filter @zuse/relay secret:e2b`, and deploy the relay only after the
template can be created with the configured API key.

`SANDBOX_DEFAULT_PROVIDER` is only the fallback placement when a provisioning
request does not choose an enabled provider. Future adapters keep their native
image, snapshot, or recipe settings under their own prefixes while sharing the
same sandbox offer and lifecycle contract.

The relay injects enrollment values into the process, not the template's global
environment. The entrypoint fails before starting Zuse if any required value is
missing, serializes repeated starts with `flock`, reports boot phases, and binds
the protected server to port `47837` for the provider's authenticated HTTPS/WSS
proxy.
