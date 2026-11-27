# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's
**Security → Report a vulnerability** flow (private security advisory). If the
repository does not have private reporting enabled, contact the maintainer
privately through the channels on their GitHub profile instead. Do not file a
public issue for a security report.

Include, where possible:

- The affected version or commit.
- The steps to reproduce the problem.
- The impact — what an attacker can do, and what they cannot.

The maintainers review private reports and respond on the advisory thread.

## Supported versions

Zuse ships rolling releases. Only the **latest release** receives security
fixes. If you run an older build, update before reporting.

## Trust model

The trust model below describes what protects what. It is useful context when
reporting or reviewing a fix.

- **Permissions.** Tool calls go through a permission broker that classifies
  each request (`read`, `write`, `execute`, `network`, `other`) against the
  session's runtime mode and permission mode. `full-access` auto-approves all
  non-sensitive requests; `approval-required` prompts; `plan` denies mutations
  without prompting. Sensitive paths (credentials, `.ssh`, `.env`) force a
  prompt in every mode, including `full-access`.
- **Repository-supplied configuration.** A cloned repository can carry
  `.zuse/` settings. Treat an untrusted repository the way you would treat an
  untrusted binary: review it before opening it in Zuse.
- **Local and remote access.** Browser and LAN clients authenticate over a
  pairing flow with rate-limited codes. Browser-facing endpoints — pairing
  and the WebSocket upgrade — reject handshakes whose `Origin` does not match
  the server's origin policy. The in-app browser bridge pins command replies
  to the subscribing renderer.
- **Cloud.** Managed tunnels accept only loopback origins. OAuth flows use
  per-flow `state` and PKCE. Zuse-issued API access tokens are DPoP-bound;
  identity-provider access tokens (for example, WorkOS) are bearer tokens.

## Scope

In scope for reports: authentication and pairing bypasses, permission/scope
escalation, cross-project data access, arbitrary file access or code
execution, tunnel or credential abuse, and supply-chain issues in the release
pipeline.

Out of scope: vulnerabilities in third-party agent CLIs (Claude Code, Codex,
Grok, Gemini, Cursor, OpenCode) or in MCP servers you install — report those
upstream. Self-inflicted configurations (deliberately running `full-access` on
an untrusted project) are usage choices, not defects.
