# Google Performance Connector Setup

The Google Performance connector is intended for Claude Team as a custom web
connector.

The connector service lives at:

```text
services/summon-google-performance-mcp
```

The Claude plugin ZIP should include the extension skills and agents, but not
Google credentials.

## Required Google Cloud Setup

1. Create or choose a Google Cloud project.
2. Enable:
   - Google Analytics Data API
   - Google Search Console API
   - Google Ads API
3. Create an OAuth client for the deployed connector.
4. Add the deployed connector callback URL to the OAuth client.
5. Store OAuth client credentials in the connector hosting environment.
6. For Google Ads, configure a developer token and connect an MCC or permitted
   customer accounts.

## Required Hosting Variables

```text
PUBLIC_BASE_URL=https://<deployed-service>
MCP_PUBLIC_URL=https://<deployed-service>/mcp
MCP_AUTH_TOKEN=<optional-admin-smoke-test-token>
OAUTH_CLIENT_ID=summon-google-performance-claude-team
OAUTH_CLIENT_SECRET=<random-secret>
OAUTH_SIGNING_SECRET=<random-secret>
OAUTH_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
OAUTH_SCOPE=summon-google-performance:read

GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_REFRESH_TOKEN=<google-refresh-token-with-required-scopes>
GOOGLE_ADS_DEVELOPER_TOKEN=<google-ads-developer-token>
GOOGLE_ADS_LOGIN_CUSTOMER_ID=<optional-mcc-id-without-dashes>

CLIENT_ALLOWLIST_JSON=<json-client-config>
```

`CLIENT_ALLOWLIST_JSON` should map client keys to allowed GA4 properties, GSC
sites, and Google Ads customer IDs.

## Example Client Allowlist

```json
{
  "summon": {
    "label": "Summon",
    "ga4Properties": ["123456789"],
    "gscSites": ["sc-domain:summon.co"],
    "googleAdsCustomerIds": ["1234567890"],
    "brandTerms": ["summon", "summon agency"]
  }
}
```

## Claude Team Connector

Add a custom web connector:

- Name: `Summon Google Performance`
- URL: `https://<deployed-service>/mcp`
- Auth: OAuth
- Client ID: value of `OAUTH_CLIENT_ID`
- Client secret: value of `OAUTH_CLIENT_SECRET`

Keep the service on one replica unless short-lived OAuth authorization codes are
moved to shared storage.
