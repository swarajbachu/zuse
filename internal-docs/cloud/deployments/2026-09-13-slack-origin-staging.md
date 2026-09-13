# Slack logout origin fix, staging

Status: DONE_WITH_CONCERNS. Deployment and live header checks passed. A live
authenticated logout remains for the user to verify; no account was disconnected.
Applied the deployment and careful safety workflow to staging only. No merge,
production change, or database migration.

- Worker: `zuse-relay-staging`, `https://api-staging.zuse.sh`.
- Active version: `33ab5996-1ee0-42e2-89f3-aa8cc150b6c1`, 100% traffic.
- Activated: `2026-09-13T19:55:42.712Z`.
- Previous version: `6291a485-9ffe-4a2f-b6d3-6bf87f90cb65`.
- Source SHA-256: `a9bf79da2dbdc2afcaad1f05cb40728fbbf1b286fc4b7731a0343defaa593fdb`.
  All 221 files matched the Mac mirror using the account-switch deployment's scope.
- Dry-run passed; bundle 4374.22 KiB, gzip 720.64 KiB, startup 481 ms.

The page's no-referrer policy made Chromium native form POSTs send Origin: null.
Slack browser pages now use same-origin referrer policy; strict origin validation
and CSRF validation remain intact. A local browser reproduction changed from
Origin: null to the expected same-origin value after the fix.

Before deployment: 430 API tests, 34 Slack tests, both type checks, Biome and
diff whitespace checks passed. Live GET /slack returned 200 with same-origin
policy; GET /slack/setup and same-origin unauthenticated POST logout returned
401 with that policy. GET logout returned 405.

Previously opened pages still carry the old policy. Reopen through a fresh private
connection link before trying logout; resubmitting the old error page is not enough.
