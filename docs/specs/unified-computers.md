# Unified computers on desktop

The desktop app can keep the local computer and saved remote computers in one
catalog. Projects and chats remain owned by the computer that returned them;
selecting a remote item routes subsequent RPC calls to that computer without
opening another window.

## Prerequisites

Remote connections require the system `ssh` client plus non-interactive
authentication through an existing OpenSSH key or agent. The remote computer
must have Node.js 22.5 or newer and npm. Zuse installs only its compatible Serve
package and does not install or upgrade system software.

OpenSSH remains responsible for aliases, keys, agents, proxy configuration,
known hosts, and host-key policy. A first connection can therefore fail until
the host key has been accepted in a terminal. Password and interactive
passphrase prompts are not supported inside the app.

## Discovery and networking

The Add computer dialog combines concrete aliases from `~/.ssh/config`, online
Tailnet peers when the local CLI is available, and a manual host form. Tailnet
data is used only to suggest an SSH host. Zuse still runs the regular system
`ssh` command and does not change network exposure, access rules, or serving
configuration. Missing, logged-out, slow, or malformed Tailnet CLI output is
treated as unavailable discovery.

See the official [Tailnet CLI documentation](https://tailscale.com/kb/1080/cli)
and [SSH feature documentation](https://tailscale.com/docs/features/tailscale-ssh)
for platform-specific networking behavior. Zuse does not invoke the specialized
SSH subcommand.

The remote service listens on loopback. The desktop app reaches it through an
ephemeral loopback SSH tunnel, verifies the wire protocol and environment
identity, and keeps the returned environment ID with the saved profile.

## Persistence and lifecycle

Saved profiles contain a label, SSH target, verified environment ID, and last
successful connection time. They are stored as a versioned, atomically replaced
file with owner-only permissions in Electron's user-data directory. Passwords,
private keys, bearer tokens, and tunnel ports are never persisted.

Saved computers reconnect independently at launch. A failed remote connection
does not block local startup or other computers, and an exited tunnel is
re-established with bounded connection supervision. Quitting Zuse closes local
tunnels and client sessions but leaves the remote service running.

Disconnect closes a tunnel while retaining the profile. Remove disconnects and
forgets the profile; it does not delete remote projects, chats, data, or the
installed runtime.
