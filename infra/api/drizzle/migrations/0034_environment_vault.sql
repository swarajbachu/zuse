CREATE TABLE api_environment_vaults (
    owner text PRIMARY KEY,
    revision integer NOT NULL CHECK (revision > 0),
    ciphertext text NOT NULL
);
CREATE TABLE api_environment_vault_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner text NOT NULL,
    event text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_environment_vault_audit_owner ON api_environment_vault_audit (owner, id);
