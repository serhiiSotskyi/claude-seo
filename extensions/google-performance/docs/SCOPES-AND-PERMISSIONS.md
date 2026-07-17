# Google Performance Scopes and Permissions

## GA4

Use:

```text
https://www.googleapis.com/auth/analytics.readonly
```

This supports read-only reporting through the Google Analytics Data API.

## Google Search Console

Use:

```text
https://www.googleapis.com/auth/webmasters.readonly
```

This supports read-only Search Console reporting.

## Google Ads

Use:

```text
https://www.googleapis.com/auth/adwords
```

Google Ads API does not provide a separate read-only OAuth scope. Read-only
safety must be enforced through:

- Google Ads user/account access level
- connector code that only exposes reporting tools
- no mutation services
- templated GAQL queries
- customer ID allowlists
- audit logs

Claude-to-MCP OAuth is separate from Google OAuth. Never reuse the Google OAuth
client secret as the Claude connector secret.

## Minimum Connector Policy

- No arbitrary mutate endpoints.
- No admin/account management endpoints.
- No free-form GAQL in the MVP.
- Date ranges must be capped.
- Row limits must be enforced.
- Client allowlist must be required for every report request.
- Every request should be logged.
