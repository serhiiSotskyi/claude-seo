# Summon Google Performance MCP

Read-only MCP service for Summon SEO/GEO workflows.

It exposes controlled reporting tools for:

- GA4 Data API
- Google Search Console API
- Google Ads API reporting
- PPC-to-SEO opportunity analysis

This service is designed to be deployed separately from the Claude plugin ZIP,
the same way the existing DataForSEO connector is deployed separately.

## Security Position

GA4 and Search Console use read-only OAuth scopes.

Google Ads API uses `https://www.googleapis.com/auth/adwords`, so this service
enforces read-only usage through:

- no mutation tools
- no arbitrary GAQL tools in the MVP
- templated report queries
- client allowlists
- date and row limits
- audit logging
- read-only Google Ads account permissions where possible

## Required Environment

At least one connector auth mode:

```text
MCP_AUTH_TOKEN=<static-token-for-admin-tests>
```

or:

```text
PUBLIC_BASE_URL=https://<deployed-service>
MCP_PUBLIC_URL=https://<deployed-service>/mcp
OAUTH_CLIENT_ID=summon-google-performance-claude-team
OAUTH_CLIENT_SECRET=<random-secret>
OAUTH_SIGNING_SECRET=<random-secret>
OAUTH_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
OAUTH_SCOPE=summon-google-performance:read
```

Google API access:

```text
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_REFRESH_TOKEN=<refresh-token-with-required-scopes>
GOOGLE_ADS_DEVELOPER_TOKEN=<google-ads-developer-token>
GOOGLE_ADS_LOGIN_CUSTOMER_ID=<optional-mcc-id-without-dashes>
GOOGLE_ADS_API_VERSION=v24
```

Client allowlist:

```text
CLIENT_ALLOWLIST_JSON='{
  "summon": {
    "label": "Summon",
    "ga4Properties": ["123456789"],
    "gscSites": ["sc-domain:summon.co"],
    "googleAdsCustomerIds": ["1234567890"],
    "brandTerms": ["summon", "summon agency"]
  }
}'
```

## Tools

- `list_clients`
- `ga4_channel_performance`
- `ga4_landing_pages`
- `ga4_conversions_by_landing_page`
- `gsc_search_analytics`
- `gsc_queries_by_page`
- `gsc_brand_vs_nonbrand`
- `google_ads_campaign_performance`
- `google_ads_search_terms`
- `google_ads_landing_pages`
- `ppc_to_seo_opportunities`

## Local Check

```bash
npm install
npm run check
```

## Notes

- Keep this service on one replica unless OAuth authorization codes are moved to
  shared storage such as Redis or Postgres.
- Store Google refresh tokens in hosting secrets, not in this repository.
- Add a persistent encrypted token store before onboarding many client Google
  accounts.
