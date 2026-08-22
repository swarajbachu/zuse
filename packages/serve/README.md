# Zuse Serve

`@zusehq/serve` runs a durable Zuse environment and provides a JSON-only CLI
for agent orchestration.

```bash
npx @zusehq/serve
```

Install the package globally to use the shorter executable:

```bash
npm install --global @zusehq/serve
zuse serve status
```

By default, `zuse serve` signs in to your Zuse account and creates a stable
HTTPS tunnel. The computer then appears automatically on other signed-in Zuse
clients. Open the printed `Browser` address anywhere; the first visit asks for
the short-lived pairing code printed by the server, and later visits reuse the
browser's secure session.

Tailscale can be enabled as an additional private route:

```bash
zuse serve --tailscale
```

Direct local-network access is opt-in. It uses plaintext HTTP only on the local
network, while authentication remains required:

```bash
zuse serve --lan                    # listen on 0.0.0.0:4859
zuse serve --host 192.168.1.20      # bind one interface
zuse serve --port 5000              # override the serve port
```

Use `--no-account` only when you intentionally do not want account discovery or
the managed tunnel. `--ssh-managed` remains loopback-only for SSH forwarding.

## Agent CLI

Discover the available computers, projects, models, chats, and sessions:

```bash
zuse commands
zuse computer list
zuse project list
zuse model list
zuse chat list --project <project-id>
zuse session list --project <project-id> --chat <chat-id>
```

Create work or send a message with structured input:

```bash
zuse chat create --input-json @request.json
zuse session send --input-json '{"project":"<project-id>","session":"<session-id>","message":"Continue with the approved plan."}'
```

Fork and hand off conversations without copying large transcripts through the
shell:

```bash
zuse session fork --project <project-id> --session <source-session-id> --message <message-id> --destination tab
zuse session send --project <project-id> --session <target-session-id> --message "Continue this handoff." --transcript <source-session-id> --plan <planning-session-id>
```

Use `session model` to change only the active model. Provider changes remain a
separate `session provider` command.

Agent commands emit one versioned JSON envelope on stdout. Check both the exit
code and the envelope's `ok` field before treating a mutation as successful.
Creation commands support `--idempotency-key` for safe retries.

See the complete [agent CLI documentation](https://docs.zuse.sh/serve/agent-cli)
and [Serve command reference](https://docs.zuse.sh/serve/command-reference).
