# DataForSEO MCP on Railway

This service runs the official `dataforseo-mcp-server` HTTP transport behind a
company bearer token. DataForSEO credentials stay in Railway variables and are
never sent to Claude Code users.

## Railway Variables

Required:

```text
DATAFORSEO_USERNAME=<DataForSEO API username>
DATAFORSEO_PASSWORD=<DataForSEO API password>
MCP_AUTH_TOKEN=<random team token>
```

Optional:

```text
ENABLED_MODULES=SERP,KEYWORDS_DATA,ONPAGE,DATAFORSEO_LABS,BACKLINKS,DOMAIN_ANALYTICS,BUSINESS_DATA,CONTENT_ANALYSIS,AI_OPTIMIZATION
INTERNAL_MCP_PORT=3010
```

Only set `FIELD_CONFIG_PATH` if you provide a field configuration that matches
the current official `dataforseo-mcp-server` format.

## Endpoints

- `GET /health` is public and returns service health.
- `POST /mcp` requires `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Claude Code should connect to the `/mcp` endpoint.
