# DataForSEO MCP on Railway

This service runs the official `dataforseo-mcp-server` HTTP transport behind a
company-controlled auth proxy. DataForSEO credentials stay in Railway variables
and are never sent to Claude users.

It supports two authentication modes:

- OAuth for Claude Team custom connectors in Claude web/Desktop.
- Static bearer token for legacy Claude Code/admin smoke tests.

## Railway Variables

Required:

```text
DATAFORSEO_USERNAME=<DataForSEO API username>
DATAFORSEO_PASSWORD=<DataForSEO API password>
```

Required for Claude Team OAuth:

```text
PUBLIC_BASE_URL=https://dataforseo-mcp-production.up.railway.app
MCP_PUBLIC_URL=https://dataforseo-mcp-production.up.railway.app/mcp
OAUTH_CLIENT_ID=summon-dataforseo-claude-team
OAUTH_CLIENT_SECRET=<random secret>
OAUTH_SIGNING_SECRET=<random secret>
OAUTH_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
OAUTH_SCOPE=dataforseo:read
```

Optional:

```text
MCP_AUTH_TOKEN=<legacy static bearer token>
OAUTH_AUTO_APPROVE=false
OAUTH_ACCESS_TTL_SECONDS=3600
OAUTH_REFRESH_TTL_SECONDS=2592000
ENABLED_MODULES=SERP,KEYWORDS_DATA,ONPAGE,DATAFORSEO_LABS,BACKLINKS,DOMAIN_ANALYTICS,BUSINESS_DATA,CONTENT_ANALYSIS,AI_OPTIMIZATION
INTERNAL_MCP_PORT=3010
```

Only set `FIELD_CONFIG_PATH` if you provide a field configuration that matches
the current official `dataforseo-mcp-server` format.

## Endpoints

- `GET /health` is public and returns service health.
- `GET /.well-known/oauth-protected-resource` returns MCP protected resource
  metadata.
- `GET /.well-known/oauth-authorization-server` returns OAuth authorization
  server metadata.
- `GET|POST /authorize` handles Claude's OAuth authorization-code flow.
- `POST /token` handles authorization-code and refresh-token grants.
- `POST /mcp` requires either a valid OAuth access token or
  `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Claude Team owners should add `/mcp` as a custom web connector and configure the
OAuth Client ID/Secret from Railway.

Keep this Railway service on one replica unless short-lived OAuth authorization
codes are moved to shared storage such as Redis or Postgres.
