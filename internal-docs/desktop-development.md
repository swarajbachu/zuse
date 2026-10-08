# Desktop development and remote connections

The desktop app does not register itself with the account API on startup.
Every copy on a machine shares one sign-in (`~/.zuse/auth-*.json`) but has its
own database and computer identity, so startup registration put the same
machine in the account once per copy. Startup registration stays off until it
is redesigned around a per-machine identity. To publish a computer, turn on
remote access in Settings → Devices, or run `zuse serve`. The installed app
keeps resuming a registration that already exists.

Running `bun run dev`, including named instances in separate worktrees, does not
publish those development copies or resume their saved remote tunnels and
heartbeats. A development copy that finds a registration from an earlier run
removes it from the account on startup, retrying in the background while
signed out or offline, so old dev runs don't linger as offline computers. Sign-in
and cloud workspace access remain available without publishing a development
computer.

Separate development copies retain isolated databases and internal environment
IDs. These IDs protect routing and data isolation; they do not consume computer
slots unless the instance is explicitly linked for remote access.

For remote-access development, opt in before starting the instance:

```sh
ZUSE_DEV_REMOTE_ACCESS=1 bun run dev --instance remote-access-test
```

This keeps the instance's registration and saved tunnel across restarts; link it
from Settings → Devices. A development copy without this opt-in removes its
registration on the next start. To test startup registration, also set
`ZUSE_DESKTOP_AUTO_LINK=1`. Copies from worktrees that no longer exist can't
remove themselves; remove them in Computers.
Use **Show hidden computers** to reveal registrations hidden by earlier versions.
Removing an account computer unregisters it without deleting its host data.
