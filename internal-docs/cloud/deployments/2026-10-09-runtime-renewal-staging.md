# Signed runtime renewal staging deployment

Deployed October 9, 2026 from branch `swarajbachu/prod-chat-connection-failure`.
Production was not deployed.

- Source/artifact commit: `b171b7accd33ce2c1ab6ebcef29da1c0f7a41fad`.
- API: `zuse-relay-staging`, version `5d096577-fd84-40b0-9afd-e4efcab6a028`,
  serving `https://api-staging.zuse.sh` and the preserved legacy issuer domain.
- Hyperdrive: `dfc67e0586ff4c288cb645ed63c65d9a`, confirmed staging Supabase origin.
- Runtime: signed `cloud-runtime-staging` channel; manifest signature verified
  against the staging API's configured public key.
- Build/publication: https://github.com/swarajbachu/zuse/actions/runs/37964277004.

The API was built in the cloud and deployed using the Mac's existing Wrangler
login. The synced worker checksum was verified before upload. An initial upload
was rejected before activation because extracted text modules were omitted;
the successful upload included the modules. No signing keys or database
credentials were changed. No workspaces, sessions, or databases were recreated.

Post-merge validation: 844 unit tests, applicable Biome checks, API/server types,
and Worker build passed. Earlier PostgreSQL renewal tests passed for two owner
contexts. Live smoke probes verify route handling and authentication rejection;
these do not establish successful renewal in an authenticated real conversation.

## Testing

Use a new staging workspace or explicitly upgrade an existing staging workspace
to the published runtime. Confirm its actual runtime version before testing:
older running processes retain the expiry-triggered shutdown behavior.

1. Run a conversation and verify meaningful agent/tool output.
2. Leave the workspace idle until it sleeps, then return and send a message.
   Verify the same workspace/chat/session and preserved repository state.
3. Repeat with sleep beyond the 15-minute access lifetime. The runtime should
   renew using a fresh signed proof and resume delivery without replacement.
4. Exercise brief network loss and restore it; verify no duplicate accepted
   commands or execution replacement.

Authenticated sleep/wake and extended provider soak remain pending. Production
promotion requires that evidence; publishing the staging channel alone is not a
claim that existing workspaces have upgraded or that the reliability redesign
is complete.
