---
name: summon-seo-service
description: >
  Run Summon's evidence-led SEO, GEO, and PPC-to-SEO client delivery workflow.
  Use for Summon client intake, baseline audits, opportunity backlogs, travel SEO,
  AI visibility analysis, implementation briefs, QA, and monthly reporting.
  Triggers on "Summon SEO", "Summon GEO", "PPC to SEO", "travel SEO service",
  "client SEO workflow", "implementation brief", and "AI visibility service".
user-invocable: true
argument-hint: "[workflow] [client-or-domain]"
license: MIT
metadata:
  author: Summon
  version: "2.3.0"
  category: seo
---

# Summon SEO Service Workflow

**Invocation:** `/summon-seo-service <workflow> [client-or-domain]`

Turn the general SEO toolkit into a controlled Summon agency service. Use this
skill for Summon, a Summon client, or service operations. Use `seo` for generic
SEO requests that do not require Summon's delivery process.

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

Never invent SEO facts. Every recommendation must point to evidence, a date
range where relevant, and a falsifiable measurement plan.

## Delivery Gates

Run each engagement through these gates:

1. **Intake:** confirm commercial goals, markets, implementation ownership, and access.
2. **Preflight:** record each source as available, unavailable, stale, or unverified.
3. **Evidence collection:** gather first-party, market, crawl, and client-context evidence.
4. **Synthesis:** separate facts, interpretation, recommendation, dependency, and confidence.
5. **Review:** require QA against `assets/templates/qa-checklist.md` before client delivery.
6. **Implementation:** create an acceptance-tested brief for every approved action.
7. **Measurement:** compare the agreed leading and outcome indicators after release.

Save engagement artifacts under `output/summon-seo/<client>/<YYYY-MM-DD>/` when
filesystem access is available. Save approved decisions and final deliverables to
the shared Summon system of record rather than relying on chat history.

## Standard Workflows

### `intake`

Output an intake brief using `assets/templates/intake.md`.

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

### `baseline`

Build a baseline audit using:
- Summon Memory
- DataForSEO ranked keywords, competitors, SERPs, backlinks, and AI visibility
- Google Performance connector data where available
- Technical crawl and rendered checks

Output:
- SEO/GEO health summary
- Source availability and evidence ledger
- Evidence table
- Prioritised opportunity backlog
- Recommended 30/60/90 day plan

### `technical-audit`

Use the standard `seo-technical`, `seo-schema`, `seo-sitemap`, `seo-images`,
`seo-performance`, and `seo-geo` workflows.

Add Summon-specific checks:
- Can Google and AI crawlers access the important body content?
- Are commercial landing pages indexed and internally linked?
- Is schema accurate for the actual business entity and locations?
- Are paid-search landing pages indexable where they should be?
- Are Core Web Vitals issues blocking conversion as well as SEO?

### `content-audit`

Map content against:
- Commercial intent
- Travel buying journey stage
- Paid-search query language
- First-party conversion data
- DataForSEO demand and SERP competitiveness
- AI citability and entity clarity

For travel clients, read `references/travel-seo-playbook.md` and apply only the
sections relevant to the detected travel business model.

Classify opportunities:
- Service page
- Destination/location page
- Comparison page
- Guide
- FAQ/support content
- Case study
- Data-led or authority asset

### `ppc-to-seo`

Use Google Ads search terms, GA4 landing page/conversion data, GSC query/page
data, and DataForSEO keyword metrics.

Find:
- High-spend paid terms with weak organic coverage
- High-converting paid queries with no dedicated SEO page
- Organic pages receiving paid traffic but not ranking
- Query clusters where SEO can lower blended acquisition cost
- Search terms that reveal customer language for headings and copy

Output an opportunity backlog using `assets/templates/opportunity-backlog.md`.

### `ai-visibility-baseline`

Use DataForSEO AI visibility tools, SERPs, citation-source checks, schema,
entity consistency, YouTube/content mentions, and first-party performance data.

Check:
- Brand/entity consistency
- Sourceable factual pages
- Author/reviewer signals
- Structured data and `@id` consistency
- AI crawler accessibility; report `llms.txt` only as an experimental convention,
  never as a ranking factor or required control
- Content formats likely to be cited in AI answers
- Mention gaps against competitors

### `implementation-brief`

Turn approved backlog items into developer/content briefs using
`assets/templates/implementation-brief.md`.

Every brief needs:
- The business case
- Evidence
- Exact URL or proposed URL
- Acceptance criteria
- Measurement plan
- Owner

### `monthly-report`

Use `assets/templates/monthly-report.md`.

Report:
- What changed
- Organic and AI visibility movement
- GA4/GSC/Ads contribution where available
- Completed implementation
- Next priorities
- Blockers and decisions needed

### `implementation-qa`

Verify an implemented change against the approved brief and
`assets/templates/qa-checklist.md`. Record pass, conditional pass, or fail with
screenshots, URLs, source data, and unresolved defects.

## Scoring

Keep the base SEO Health Score unchanged. Report a separate service opportunity
score so market size or implementation readiness cannot inflate site health:

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
- Do not deliver a client-facing artifact until the QA checklist passes.
- Use `references/delivery-standards.md` for evidence, confidence, and review rules.

## Related Skills

- `seo` for the universal SEO orchestrator.
- `seo-dataforseo` for live market, SERP, backlink, and AI visibility data.
- `seo-google-performance` for GA4, GSC, and Google Ads read-only data.
