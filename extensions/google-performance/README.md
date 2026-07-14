# Google Performance Extension

This extension adds Summon's read-only first-party performance data workflow to
the Claude SEO plugin.

It is designed to work with the `summon-google-performance-mcp` service in:

```text
services/summon-google-performance-mcp
```

## What It Adds

- GA4 reporting guidance.
- Google Search Console reporting guidance.
- Google Ads reporting guidance.
- PPC-to-SEO opportunity workflows.
- Guardrails for read-only connector usage.

## Connector Model

The connector should be added to Claude Team as a custom web connector, the same
way the DataForSEO connector is added separately from the plugin ZIP.

The plugin contains instructions, agents, templates, and workflows. Credentials
and OAuth tokens stay in the deployed connector service.

## Read-Only Position

GA4 and Search Console support read-only OAuth scopes.

Google Ads API uses the broader `https://www.googleapis.com/auth/adwords` scope,
so read-only behaviour must be enforced through:

- read-only Google Ads account permissions where possible
- connector tools that only expose reporting
- no mutation endpoints
- templated GAQL reports
- client/account allowlists
- audit logs

## Setup Docs

- `docs/GOOGLE-PERFORMANCE-SETUP.md`
- `docs/SCOPES-AND-PERMISSIONS.md`
