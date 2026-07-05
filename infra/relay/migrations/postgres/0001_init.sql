-- Relay control-plane schema (PostgreSQL).
--
-- Applied at DEPLOY time (not at Worker boot — Workers are ephemeral and would
-- otherwise migrate on every cold start). See infra/relay/README.md.
--
-- The relay is a thin control plane: it links a WorkOS account to the computers
-- ("environments") that account controls, brokers short-lived connect tokens,
-- and tracks presence. It never stores chat data — chat traffic goes directly
-- phone <-> laptop.

-- Every record below is scoped by `account_id` (the WorkOS user id) so a signed-in
-- user can only ever see and act on their own environments/devices.

-- One-time link challenges. The desktop requests a challenge (authenticated by its
-- WorkOS token), signs it with its per-environment Ed25519 private key, and posts
-- the signed proof back. Challenges are single-use and short-lived.
CREATE TABLE IF NOT EXISTS relay_link_challenges (
  challenge_id  TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  challenge     TEXT NOT NULL,
  relay_issuer  TEXT NOT NULL,
  expires_at    BIGINT NOT NULL,
  consumed_at   BIGINT
);
CREATE INDEX IF NOT EXISTS relay_link_challenges_account_idx
  ON relay_link_challenges (account_id);

-- Linked computers. `environment_public_key` is the Ed25519 public key the desktop
-- sent at link time; the relay verifies every subsequent proof (link, health,
-- connect) against it. Presence is derived from `last_seen_at`.
CREATE TABLE IF NOT EXISTS relay_environments (
  environment_id          TEXT PRIMARY KEY,
  account_id              TEXT NOT NULL,
  org_id                  TEXT,
  provider_kind           TEXT NOT NULL CHECK (provider_kind IN ('desktop','ssh','cloud')),
  label                   TEXT,
  environment_public_key  TEXT NOT NULL,
  http_base_url           TEXT NOT NULL,
  ws_base_url             TEXT NOT NULL,
  tunnel_hostname         TEXT,
  linked_at               BIGINT NOT NULL,
  last_seen_at            BIGINT
);
CREATE INDEX IF NOT EXISTS relay_environments_account_idx
  ON relay_environments (account_id);

-- Per-environment credential the relay issues on link. Stored HASHED (the plaintext
-- `zenv_<id>_<secret>` lives only on the desktop). Presented by the desktop as a
-- bearer on environment-scoped calls (health, agent-activity).
CREATE TABLE IF NOT EXISTS relay_environment_credentials (
  credential_id    TEXT PRIMARY KEY,
  environment_id   TEXT NOT NULL REFERENCES relay_environments (environment_id) ON DELETE CASCADE,
  account_id       TEXT NOT NULL,
  credential_hash  TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  revoked_at       BIGINT
);
CREATE INDEX IF NOT EXISTS relay_environment_credentials_env_idx
  ON relay_environment_credentials (environment_id);

-- Registered mobile devices (for push fan-out). `dpop_jwk` is the device's public
-- proof-of-possession key (thumbprint bound into minted access tokens).
CREATE TABLE IF NOT EXISTS relay_devices (
  device_id    TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  push_token   TEXT,
  dpop_jwk     JSONB,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_devices_account_idx
  ON relay_devices (account_id);

-- DPoP replay guard. Every authenticated client request presents a DPoP proof; its
-- `jti` is inserted here and the UNIQUE constraint rejects replays. Rows are swept
-- once `expires_at` passes.
CREATE TABLE IF NOT EXISTS relay_dpop_proofs (
  thumbprint  TEXT NOT NULL,
  jti         TEXT NOT NULL,
  issued_at   BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  PRIMARY KEY (thumbprint, jti)
);
CREATE INDEX IF NOT EXISTS relay_dpop_proofs_expiry_idx
  ON relay_dpop_proofs (expires_at);

-- Agent-activity events (approval-needed, completed, etc.) used to drive push. Never
-- contains chat content — the ingest endpoint rejects any message/chat payload.
CREATE TABLE IF NOT EXISTS relay_agent_activity (
  id              BIGSERIAL PRIMARY KEY,
  environment_id  TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('approval-needed','question-needed','completed','error','running')),
  title           TEXT,
  occurred_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_agent_activity_env_idx
  ON relay_agent_activity (environment_id, occurred_at);
