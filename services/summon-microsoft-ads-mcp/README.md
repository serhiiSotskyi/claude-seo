# Summon Microsoft Ads MCP

Read-only MCP service for Summon SEO/GEO workflows using Microsoft Advertising
reporting data.

It exposes controlled reporting tools for:

- campaign performance
- search query performance
- keyword performance
- search term landing page performance
- PPC-to-SEO opportunity analysis

This service is designed to be deployed separately from the Claude plugin ZIP,
the same way the existing DataForSEO and Google Performance connectors are
deployed separately.

## Security Position

Microsoft Advertising uses the broad `https://ads.microsoft.com/msads.manage`
OAuth scope for API access. This service enforces read-only usage through:

- no mutation tools
- no arbitrary report/query tools in the MVP
- fixed Reporting API templates only
- client allowlists
- date and row limits
- audit logging
- read-only Microsoft Advertising account permissions where possible

## Required Environment

At least one connector auth mode:

```text
MCP_AUTH_TOKEN=<static-token-for-admin-tests>
```

or:

```text
PUBLIC_BASE_URL=https://<deployed-service>
MCP_PUBLIC_URL=https://<deployed-service>/mcp
OAUTH_CLIENT_ID=summon-microsoft-ads-claude-team
OAUTH_CLIENT_SECRET=<random-secret>
OAUTH_SIGNING_SECRET=<random-secret>
OAUTH_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
OAUTH_SCOPE=summon-microsoft-ads:read
```

Microsoft Advertising API access:

```text
MICROSOFT_ADS_CLIENT_ID=<azure-app-client-id>
MICROSOFT_ADS_CLIENT_SECRET=<azure-app-client-secret>
MICROSOFT_ADS_REFRESH_TOKEN=<refresh-token-with-msads.manage-consent>
MICROSOFT_ADS_DEVELOPER_TOKEN=<developer-token>
MICROSOFT_ADS_TENANT=common
MICROSOFT_ADS_SCOPE=https://ads.microsoft.com/msads.manage offline_access
MICROSOFT_ADS_ENVIRONMENT=production
MICROSOFT_ADS_REPORT_TIME_ZONE=GreenwichMeanTimeDublinEdinburghLisbonLondon
```

Client allowlist:

```text
CLIENT_ALLOWLIST_JSON='{
  "summon": {
    "label": "Summon",
    "microsoftAdsAccounts": [
      {
        "label": "Summon Microsoft Ads",
        "accountId": "123456789",
        "customerId": "987654321"
      }
    ],
    "brandTerms": ["summon", "summon agency"]
  }
}'
```

## Tools

- `list_clients`
- `microsoft_ads_campaign_performance`
- `microsoft_ads_search_queries`
- `microsoft_ads_keyword_performance`
- `microsoft_ads_landing_pages`
- `microsoft_ads_ppc_to_seo_opportunities`

## Local Check

```bash
npm install
npm run check
```

## Claude Team Connector

Add a custom web connector:

- Name: `Summon Microsoft Ads`
- URL: `https://<deployed-service>/mcp`
- Auth: OAuth
- Client ID: value of `OAUTH_CLIENT_ID`
- Client secret: value of `OAUTH_CLIENT_SECRET`

Keep this Railway service on one replica unless short-lived OAuth authorization
codes are moved to shared storage such as Redis or Postgres.
