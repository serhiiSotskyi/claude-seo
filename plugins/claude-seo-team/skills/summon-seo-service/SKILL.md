---
name: summon-seo-service
description: >
  Summon-specific SEO, GEO, and PPC-to-SEO delivery workflow. Use for Summon
  client work, internal service design, intake, baseline audits, opportunity
  backlogs, AI visibility audits, implementation briefs, and monthly SEO/GEO
  reporting. Triggers on: "Summon SEO", "Summon GEO", "PPC to SEO",
  "SEO service", "client SEO workflow", "AI visibility service".
---

# Summon SEO Service Workflow

This skill turns the general Claude SEO toolkit into a repeatable Summon agency
service. It should be used when work is for Summon, a Summon client, or a
Summon sales/service workflow.

## Operating Principle

Summon should not deliver generic SEO. The differentiated service is:

> SEO and AI visibility for travel brands, powered by paid-search intelligence,
> first-party performance data, DataForSEO, and implementation-focused workflows.

## Required Source Order

For client-facing work, collect evidence in this order:

1. Summon Memory / Notion context, especially client profile, data sources,
   decisions, plans, and prior reports.
2. First-party performance data through the Google Performance connector when
   available: GA4, Google Search Console, and Google Ads.
3. DataForSEO for market, SERP, keyword, competitor, backlink, local, and AI
   visibility data.
4. Website crawl, rendered page checks, screenshots, schema validation, and
   manual review.
5. Existing client documents, Sheets, Looker Studio reports, or proxy exports.

Never invent SEO facts. Every recommendation should point to at least one
evidence source.

## Standard Workflows

### `/summon seo intake`

Output an intake brief using `templates/summon-seo/intake.md`.

Capture:
- Client name and domain
- Markets and languages
- Commercial goals
- Main services/products
- CMS/platform
- Known tracking setup
- GA4, GSC, Google Ads, DataForSEO, and crawl access status
- Main competitors
- Current SEO/GEO concerns
- Implementation owner and development constraints

### `/summon seo baseline`

Build a baseline audit using:
- Summon Memory
- DataForSEO ranked keywords, competitors, SERPs, backlinks, and AI visibility
- Google Performance connector data where available
- Technical crawl and rendered checks

Output:
- SEO/GEO health summary
- Evidence table
- Prioritised opportunity backlog
- Recommended 30/60/90 day plan

### `/summon seo technical audit`

Use the standard `seo-technical`, `seo-schema`, `seo-sitemap`, `seo-images`,
`seo-performance`, and `seo-geo` workflows.

Add Summon-specific checks:
- Can Google and AI crawlers access the important body content?
- Are commercial landing pages indexed and internally linked?
- Is schema accurate for the actual business entity and locations?
- Are paid-search landing pages indexable where they should be?
- Are Core Web Vitals issues blocking conversion as well as SEO?

### `/summon seo content audit`

Map content against:
- Commercial intent
- Travel buying journey stage
- Paid-search query language
- First-party conversion data
- DataForSEO demand and SERP competitiveness
- AI citability and entity clarity

Classify opportunities:
- Service page
- Destination/location page
- Comparison page
- Guide
- FAQ/support content
- Case study
- Data-led or authority asset

### `/summon seo ppc-to-seo`

Use Google Ads search terms, GA4 landing page/conversion data, GSC query/page
data, and DataForSEO keyword metrics.

Find:
- High-spend paid terms with weak organic coverage
- High-converting paid queries with no dedicated SEO page
- Organic pages receiving paid traffic but not ranking
- Query clusters where SEO can lower blended acquisition cost
- Search terms that reveal customer language for headings and copy

Output an opportunity backlog using
`templates/summon-seo/opportunity-backlog.md`.

### `/summon ai-visibility baseline`

Use DataForSEO AI visibility tools, SERPs, citation-source checks, schema,
entity consistency, YouTube/content mentions, and first-party performance data.

Check:
- Brand/entity consistency
- Sourceable factual pages
- Author/reviewer signals
- Structured data and `@id` consistency
- `llms.txt` and AI crawler accessibility
- Content formats likely to be cited in AI answers
- Mention gaps against competitors

### `/summon seo implementation brief`

Turn approved backlog items into developer/content briefs using
`templates/summon-seo/implementation-brief.md`.

Every brief needs:
- The business case
- Evidence
- Exact URL or proposed URL
- Acceptance criteria
- Measurement plan
- Owner

### `/summon seo monthly report`

Use `templates/summon-seo/monthly-report.md`.

Report:
- What changed
- Organic and AI visibility movement
- GA4/GSC/Ads contribution where available
- Completed implementation
- Next priorities
- Blockers and decisions needed

## Scoring

Use the base SEO Health Score from the main SEO skill, then add Summon service
scores:

| Score | Weight |
| --- | ---: |
| Technical SEO | 20% |
| Content and intent coverage | 20% |
| First-party performance opportunity | 20% |
| DataForSEO market opportunity | 15% |
| AI visibility / GEO readiness | 15% |
| Implementation readiness | 10% |

## Output Rules

- Lead with findings and actions, not methodology.
- Separate facts, interpretation, and recommendations.
- Use priority levels: Critical, High, Medium, Low.
- Include source names and dates for volatile data.
- Flag missing access as a blocker, not as a guessed result.
- Convert findings into implementation-ready backlog items.

## Related Skills

- `seo` for the universal SEO orchestrator.
- `seo-dataforseo` for live market, SERP, backlink, and AI visibility data.
- `seo-google-performance` for GA4, GSC, and Google Ads read-only data.
