# Claude Team DataForSEO Setup

The team DataForSEO MCP service is deployed on Railway:

```text
https://dataforseo-mcp-production.up.railway.app/mcp
```

DataForSEO credentials are stored only as Railway variables on the
`summon-dataforseo-mcp` project, `dataforseo-mcp` service. They are not stored
in this repository or in the Claude plugin.

## How Team Members Use It

Install or enable the Claude SEO plugin, then set the team MCP token in the
shell that starts Claude Code:

```bash
export DATAFORSEO_MCP_TOKEN="<team-token-from-admin>"
claude
```

The plugin's `.mcp.json` reads that token and connects Claude Code to the
Railway-hosted MCP endpoint.

You can also add the remote MCP server directly for a user:

```bash
claude mcp add --transport http dataforseo \
  https://dataforseo-mcp-production.up.railway.app/mcp \
  --scope user \
  --header "Authorization: Bearer $DATAFORSEO_MCP_TOKEN"
```

## Verification

Inside Claude Code, run:

```text
/mcp
```

The `dataforseo` server should show as connected. Then test:

```text
Use the DataForSEO MCP tools to list available SEO data tools.
```

Or use the SEO skill:

```text
/seo dataforseo serp seo tools
```

## Operations

Railway variables required by the service:

```text
DATAFORSEO_USERNAME
DATAFORSEO_PASSWORD
MCP_AUTH_TOKEN
ENABLED_MODULES
```

Rotate access by changing `MCP_AUTH_TOKEN` in Railway and giving the new value
to approved team members as `DATAFORSEO_MCP_TOKEN`.

Do not commit `.claude/settings.json`, local shell profiles containing tokens,
or copied Railway variables.
