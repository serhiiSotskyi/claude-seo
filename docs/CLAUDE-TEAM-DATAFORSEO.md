# Claude Team DataForSEO Setup

This setup lets nontechnical users in an Anthropic Team workspace use live
DataForSEO data from normal Claude web or Claude Desktop. DataForSEO credentials
stay server-side in Railway.

## Deployed MCP Service

```text
https://dataforseo-mcp-production.up.railway.app/mcp
```

Railway project/service:

```text
summon-dataforseo-mcp / dataforseo-mcp
```

## Railway Variables

Required for DataForSEO:

```text
DATAFORSEO_USERNAME
DATAFORSEO_PASSWORD
ENABLED_MODULES
```

Required for Claude Team OAuth connector auth:

```text
PUBLIC_BASE_URL=https://dataforseo-mcp-production.up.railway.app
MCP_PUBLIC_URL=https://dataforseo-mcp-production.up.railway.app/mcp
OAUTH_CLIENT_ID=summon-dataforseo-claude-team
OAUTH_CLIENT_SECRET=<secret generated in Railway>
OAUTH_SIGNING_SECRET=<secret generated in Railway>
OAUTH_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
OAUTH_SCOPE=dataforseo:read
```

Optional:

```text
OAUTH_AUTO_APPROVE=false
MCP_AUTH_TOKEN=<legacy Claude Code/admin token>
INTERNAL_MCP_PORT=3010
```

Keep `MCP_AUTH_TOKEN` only for Claude Code/admin smoke tests. Claude web and
Claude Desktop use OAuth.

## Owner Setup in Claude Team

You must be an Owner or Primary Owner in the Anthropic Team workspace.

Before adding the plugin, confirm organization settings allow Claude
collaboration/plugin features:

- **Cowork** is enabled.
- **Skills** are enabled.

### 1. Add the DataForSEO custom connector

1. Open Claude.
2. Go to **Organization settings**.
3. Open **Connectors**.
4. Click **Add**.
5. Choose **Custom** then **Web**.
6. Name it `DataForSEO`.
7. Set the remote MCP server URL:

```text
https://dataforseo-mcp-production.up.railway.app/mcp
```

8. Open **Advanced settings**.
9. Set OAuth Client ID from Railway:

```text
summon-dataforseo-claude-team
```

10. Set OAuth Client Secret from Railway variable `OAUTH_CLIENT_SECRET`.
11. Save the connector.

Do not paste the DataForSEO username or password into Claude.

### 2. Upload the SEO plugin for the team

Build the upload ZIP locally:

```bash
./scripts/package-claude-team-plugin.sh
```

The script creates:

```text
dist/claude-seo-team-plugin.zip
```

In Claude:

1. Go to **Organization settings**.
2. Open **Plugins**.
3. Click **Add plugins**.
4. Choose **Upload a file**.
5. Upload `dist/claude-seo-team-plugin.zip`.
6. Set the plugin to **Installed by default** or **Required**.

The ZIP does not contain DataForSEO credentials or OAuth secrets.

## Member Usage

Each team member uses normal Claude:

1. Open Claude web or Claude Desktop.
2. Go to **Customize > Connectors**.
3. Find **DataForSEO** and click **Connect**.
4. If a consent screen appears, click **Connect**.
5. In a chat, click `+` then **Connectors** and enable **DataForSEO**.
6. Ask naturally:

```text
Use DataForSEO to get Google SERP results for "seo tools" in the United States.
```

For the SEO workflow:

```text
Run an SEO and DataForSEO competitor analysis for example.com.
```

## Verification

Public health check:

```bash
curl https://dataforseo-mcp-production.up.railway.app/health
```

OAuth discovery:

```bash
curl https://dataforseo-mcp-production.up.railway.app/.well-known/oauth-protected-resource
curl https://dataforseo-mcp-production.up.railway.app/.well-known/oauth-authorization-server
```

Unauthenticated MCP requests should return `401` with a
`WWW-Authenticate` header that points Claude to the OAuth metadata.

## Rotation

To rotate Claude connector access:

1. Generate a new `OAUTH_CLIENT_SECRET`.
2. Update it in Railway.
3. Update the OAuth Client Secret in Claude **Organization settings >
   Connectors > DataForSEO**.
4. Ask users to reconnect the connector if Claude prompts them.

To revoke all existing OAuth access tokens, rotate `OAUTH_SIGNING_SECRET`.

## Security Notes

- DataForSEO username/password stay only in Railway variables.
- OAuth Client Secret is shared only between Railway and Claude Team connector
  settings.
- The team plugin ZIP contains only instructions, scripts, and templates.
- Keep the Railway service on one replica unless short-lived OAuth
  authorization codes are moved to Redis/Postgres.
- Do not commit `.claude/settings.json`, shell profiles containing tokens, or
  copied Railway variables.
