# Cloud Grok CLI installation

`infra/cloud-sandboxes/install-grok.sh` installs Grok CLI 1.0.13 for Linux x86_64
and aarch64. Base provisioning and older workspace repair share this installer.
It downloads the binary directly, verifies its pinned SHA-256 before execution,
checks that it starts, and atomically replaces only the CLI. A failed download,
digest check, or startup check preserves the existing executable. It does not
modify runtime databases, agent credentials, shell configuration, or provider config.

## Artifact source and trust

The source is the public GCS bucket used as the fallback in the
[upstream installer](https://x.ai/cli/install.sh). Each download specifies a GCS
object generation, so a replacement at the same versioned path cannot change
what this installer accepts. The mutable upstream installer is not downloaded
or executed by cloud provisioning.

The following pins were collected on 2026-10-07 from upstream HTTPS downloads:

| Artifact under `https://storage.googleapis.com/grok-build-public-artifacts/cli/` | GCS generation | SHA-256 |
| --- | --- | --- |
| `grok-1.0.13-linux-x86_64` | `1787956692848119` | `edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1` |
| `grok-1.0.13-linux-aarch64` | `1787956595467474` | `b926fc5308374396e260e7efbd6107231a8dae13c084ddaf0fe89b7ebb3edd25` |

These are repository-pinned digests, not publisher-signed integrity evidence.
The upstream installer does not verify binary signatures or digests, and the
`.sha256`, `.sha256sum`, and `.sig` endpoints for these artifacts returned 404
when checked. Initial artifact trust rests on the upstream HTTPS source; the
repository pins detect subsequent substitutions. Pin the version, generation,
and digest together when upgrading. Verify supported architectures and run the
installer behavior tests plus a fresh isolated install before changing the pins.
If a pinned generation is removed upstream, installation fails rather than
silently selecting another artifact.
