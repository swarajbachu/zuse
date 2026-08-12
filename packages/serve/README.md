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

Agent commands emit one versioned JSON envelope on stdout. Check both the exit
code and the envelope's `ok` field before treating a mutation as successful.
Creation commands support `--idempotency-key` for safe retries.

See the complete [agent CLI documentation](https://docs.zuse.sh/serve/agent-cli)
and [Serve command reference](https://docs.zuse.sh/serve/command-reference).
