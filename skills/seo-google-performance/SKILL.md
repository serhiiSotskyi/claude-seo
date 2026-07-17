---
name: seo-google-performance
description: >
  Read-only first-party performance data for SEO and GEO workflows using GA4,
  Google Search Console, and Google Ads. Use when the user asks for GA4 landing
  pages, Search Console queries/pages, Google Ads search terms, PPC-to-SEO
  opportunities, organic conversion performance, non-brand SEO performance, or
  first-party evidence for Summon SEO recommendations. Requires the Summon
  Google Performance connector to be enabled.
user-invocable: true
argument-hint: "[report] [client-key]"
license: MIT
compatibility: "Requires the Summon Google Performance organization connector"
metadata:
  author: Summon
  version: "2.3.0"
  category: seo
---

# Google Performance Data for SEO

**Invocation:** `/seo-google-performance <report> <client-key>`

Use this skill when SEO/GEO recommendations need first-party performance data.

The connector is read-only by design. Do not request or perform account changes,
campaign edits, conversion changes, tag changes, or admin changes.

## Availability Check

Before using connector tools, check whether Google Performance MCP tools are
available. Expected tool families:

- `ga4_*`
- `gsc_*`
- `google_ads_*`
- `ppc_to_seo_*`

If tools are unavailable, ask the user to enable the Summon Google Performance
connector or use existing proxy exports/Sheets as fallback evidence.

Call `list_clients` first when the client key is unknown. Never substitute one
client's property, site, or Ads account for another.

## Quick Reference

| Workflow | Tools |
| --- | --- |
| GA4 organic landing pages | `ga4_landing_pages` |
| GA4 channel performance | `ga4_channel_performance` |
| GA4 conversions by landing page | `ga4_conversions_by_landing_page` |
| GSC queries/pages | `gsc_search_analytics`, `gsc_queries_by_page` |
| Brand vs non-brand SEO | `gsc_brand_vs_nonbrand` |
| Google Ads search terms | `google_ads_search_terms` |
| Paid landing page performance | `google_ads_landing_pages` |
| PPC-to-SEO opportunities | `ppc_to_seo_opportunities` |

## Default Date Ranges

- Baseline audit: last 90 days, compared with previous 90 days.
- Monthly report: reporting month, compared with previous month and same month
  last year when data is available.
- PPC-to-SEO: last 90 days minimum, last 12 months preferred for seasonal travel
  clients.
- Search Console query work: last 16 months if looking for long-term organic
  opportunity, otherwise last 90 days.

## GA4 Usage

Use GA4 to understand actual landing-page and conversion performance.

Prioritise:
- Organic sessions and engaged sessions by landing page.
- Organic conversions by landing page.
- Channel mix by landing page.
- Device and geography differences.
- Organic landing pages that convert but have weak GSC/DataForSEO visibility.

Avoid over-interpreting GA4 when tracking quality is unknown. Record tracking
concerns as blockers.

## Search Console Usage

Use GSC to understand Google organic demand and page/query fit.

Prioritise:
- Queries with impressions but weak CTR.
- Pages with declining clicks or impressions.
- Non-brand query growth or decline.
- Pages ranking for the wrong intent.
- Queries that align with high-value paid search terms.

Always separate brand and non-brand where possible.

## Google Ads Usage

Use Google Ads for paid-search demand and commercial language.

Prioritise:
- Search terms with conversions, high spend, or strong CTR.
- Paid landing pages with no organic equivalent.
- Query clusters that repeat across campaigns/ad groups.
- High-cost terms where SEO coverage could reduce blended acquisition cost.

Google Ads API does not have a separate read-only OAuth scope. The connector
must only expose reporting tools and should use read-only account permissions
where possible.

## PPC-To-SEO Workflow

For each candidate opportunity:

1. Pull Google Ads search terms.
2. Group by intent and topic.
3. Check GA4 conversion behaviour for matching landing pages.
4. Check GSC query/page coverage.
5. Check DataForSEO keyword volume, difficulty, SERP type, and competitors.
6. Recommend one of:
   - optimise an existing page
   - create a new service/location/destination page
   - create a guide or comparison page
   - improve internal links
   - ignore because paid-only intent is better

Output fields:
- Opportunity
- Paid evidence
- Organic gap
- Recommended URL
- Expected impact
- Effort
- Confidence
- Measurement plan

## Output Rules

- Include source, date range, account/property/site, and row limits.
- Say when access is missing.
- Do not imply causation from correlation.
- Do not mix GA4 sessions, GSC clicks, and Google Ads clicks without labelling
  each metric clearly.
- Treat Google Ads search terms as commercial evidence, not organic search
  volume.
- Do not expose account IDs, OAuth tokens, or connector configuration in outputs.
- Refuse any request to mutate analytics, Search Console, or Ads configuration.
