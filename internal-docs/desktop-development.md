# Desktop development and remote connections

The installed desktop app is the default remote contact for a computer. Running
`bun run dev`, including named instances in separate worktrees, does not
register those development copies with the account API or resume their saved
remote tunnels and heartbeats. Sign-in and cloud workspace access remain
available without publishing a development computer.

Separate development copies retain isolated databases and internal environment
IDs. These IDs protect routing and data isolation; they do not consume computer
slots unless the instance is explicitly linked for remote access.

For remote-access development, opt in before starting the instance:

```sh
ZUSE_DEV_REMOTE_ACCESS=1 bun run dev --instance remote-access-test
```

This enables automatic registration and saved-tunnel resume for that instance.
Explicit linking through the app remains available. Existing registrations are
preserved when changing the startup default; remove unused ones in Computers.
Use **Show hidden computers** to reveal registrations hidden by earlier versions.
Removing an account computer unregisters it without deleting its host data.
