# Unified computers on desktop

The desktop app can keep the local computer and saved remote computers in one
catalog. Projects and chats remain owned by the computer that returned them;
selecting a remote item routes subsequent RPC calls to that computer without
opening another window.

## Prerequisites

The simplest private connection requires Tailscale to be installed, signed in,
and on the same Tailnet on both devices. In desktop Settings → Devices, choose
**Share over Tailscale**, then **Connect a device**. Scan the QR code on mobile
or copy the one-time pairing link into **Add computer → Tailscale** on another
desktop. No SSH keys or account api are involved.

A headless computer must have Node.js 22.5 or newer, npm, and the Tailscale CLI.
Run `zuse serve --tailscale`; Zuse installs its durable user service, enables a
loopback-only Tailscale Serve proxy, and prints a one-time pairing link. Zuse
does not install or upgrade Node, npm, or Tailscale.

SSH remains available as an advanced alternative. It requires the system `ssh`
client plus non-interactive authentication through an existing OpenSSH key or
agent.

OpenSSH remains responsible for aliases, keys, agents, proxy configuration,
known hosts, and host-key policy. A first connection can therefore fail until
the host key has been accepted in a terminal. Password and interactive
passphrase prompts are not supported inside the app.

## Discovery and networking

Tailscale sharing uses `tailscale serve --bg` to expose only Zuse's loopback
listener through Tailnet HTTPS. It does not open a public port, enable Funnel,
or change Tailnet access rules. If another application already owns the
Tailscale Serve configuration, Zuse refuses to replace it.

The SSH tab combines aliases from `~/.ssh/config`, online Tailnet peers when the
local CLI is available, and a manual host form. In that tab, Tailnet discovery
is only an SSH host suggestion and Zuse still runs regular OpenSSH.

See the official [Tailnet CLI documentation](https://tailscale.com/kb/1080/cli)
and [SSH feature documentation](https://tailscale.com/docs/features/tailscale-ssh)
for platform-specific networking behavior. Zuse does not invoke the specialized
SSH subcommand.

The remote service listens on loopback. Direct Tailnet connections use a
revocable bearer credential obtained from the one-time pairing link and stored
in the operating system credential vault. SSH connections use an ephemeral
loopback tunnel. Both paths verify the wire protocol and saved environment
identity before exposing projects or chats.

## Persistence and lifecycle

Saved profiles contain a label, connection address or SSH target, verified
environment ID, and last successful connection time. Metadata is stored as a
versioned, atomically replaced file with owner-only permissions in Electron's
user-data directory. Tailnet bearer credentials are stored in the operating
system credential vault. Passwords, private keys, bearer tokens, and tunnel
ports are never written to the profile file.

Saved computers reconnect independently at launch. A failed remote connection
does not block local startup or other computers, and an exited tunnel is
re-established with bounded connection supervision. Quitting Zuse closes local
tunnels and client sessions but leaves the remote service running.

Disconnect closes a tunnel while retaining the profile. Remove disconnects and
forgets the profile; it does not delete remote projects, chats, data, or the
installed runtime.
