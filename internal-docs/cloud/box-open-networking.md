# Box open networking

Box placements support open networking only. This supersedes the Box in-guest
quarantine implementation described in ADR 0035 at the user's explicit request;
ordinary cloud placement already selects open networking under ADR 0034.
E2B network enforcement and the shared network-policy contract are unchanged.

The Box adapter rejects restricted/quarantined create, fork, and setNetwork
requests without contacting the provider. Open setNetwork requests do no work.
The template no longer installs nftables, firewall scripts, firewall units, or
policy markers. Resume only checks/prepares the persisted runtime layout.
There is no legacy firewall cleanup or migration code.

## Deployment

Publish a fresh base template with this installer, select its new version, and
rebuild account images/pools before deploying the adapter removal. Old snapshots
contain the removed firewall service; deleting repository code does not remove
it from those snapshots. Existing benchmark snapshots must not be reused as
evidence that the new template is installed. No user migration is planned because
the user confirmed Box is not in use.

## Startup comparison

For explanation, group a cold Box message wake into six stages (not six HTTP
requests): persist the message, resume the machine, prepare persisted paths and
temporary runtime files, launch Zuse, restore credentials/reconnect, and deliver
the queued message to the agent. Some file preparation runs concurrently.
The former firewall stage has been removed entirely.

In the last measured series, Box's usable-state wait took 33.040–37.843 seconds
every time. The preparation command took 1.427/52.110/7.309 seconds including
provider dispatch and guest execution; the 52-second outlier needs internal
timestamps before assigning a cause. Whole-message delivery took
54.876/107.381/65.046 seconds. These pre-removal results do not establish the
performance of this change.

E2B's successful warm path groups into three stages: persist the message, resume
the machine with its processes, and reconnect/deliver. It reuses the running Zuse
and agent processes instead of rebuilding them. When warm recovery fails, its
cold fallback does more work. The earlier E2B series measured
9.164/7.884/8.838 seconds; no new live comparison was run for this removal.
