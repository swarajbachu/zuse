CREATE TABLE api_cloud_provider_connections (
    connection_id text PRIMARY KEY,
    account_id text NOT NULL,
    provider text NOT NULL CONSTRAINT cloud_provider_connection_provider CHECK (provider IN ('e2b', 'boxd', 'box')),
    envelope text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    template_id text,
    organization text,
    created_at bigint NOT NULL
);
CREATE UNIQUE INDEX api_cloud_provider_connections_active ON api_cloud_provider_connections (account_id, provider) WHERE active;
CREATE INDEX api_cloud_provider_connections_owner ON api_cloud_provider_connections (account_id);
