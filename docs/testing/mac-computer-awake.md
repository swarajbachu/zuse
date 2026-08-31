# macOS computer-awake release check

Run this check on a physical MacBook before a macOS release that changes the
computer-awake controller. Automated tests verify assertion ownership, but a VM
cannot verify lid behavior.

1. Connect the MacBook to power and open Zuse Settings → General → Power.
2. Select **Auto**, start an agent turn, and confirm the row reports the agent
   trigger as active.
3. Run `pmset -g assertions` and confirm Zuse/Electron has an idle-sleep
   assertion and `/usr/bin/caffeinate -i -s` is running.
4. Close the lid for at least two minutes, reopen it, and confirm the agent made
   progress without a reconnect or session restart.
5. Let the turn finish and close every remote browser/mobile client. Confirm the
   row becomes inactive, the `caffeinate` process exits, and the Zuse assertion
   disappears from `pmset -g assertions`.
6. Repeat Always → Off and confirm Off releases both assertions immediately.

Closed-lid operation is best effort. Record the Mac model, macOS version, power
source, and whether an external display was attached. Do not change
`pmset disablesleep`; Zuse does not install a privileged helper or override the
user's global sleep policy.
