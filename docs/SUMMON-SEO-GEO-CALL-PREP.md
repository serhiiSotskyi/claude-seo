# Summon SEO/GEO Call Prep

Date: 2026-07-14

## The Core Pitch

We should not jump straight to hiring a senior SEO person.

The better move is to build a repeatable SEO/GEO delivery system around assets
we already have:

- Summon's paid-search expertise.
- Existing client data access and reporting habits.
- DataForSEO for live market, keyword, competitor, SERP, backlink, and AI
  visibility data.
- Claude workflows, skills, agents, and templates.
- Summon Memory for client context, decisions, source registry, and repeatable
  operating history.
- A new read-only Google Performance connector for GA4, Search Console, and
  Google Ads evidence.

The point is not "AI replaces SEO expertise." The point is that we encode the
right workflow so a capable Summon team member can deliver strong SEO/GEO work
with evidence, guardrails, templates, and QA, instead of depending on one hire's
personal process.

## 30-Second Version

SEO is not currently one of Summon's strongest services, but we already have
most of the ingredients to make it strong. Instead of hiring first, I propose we
build an internal SEO/GEO operating system: Claude plugin workflows, DataForSEO,
first-party GA4/GSC/Google Ads data, and standard templates. It turns SEO into a
repeatable process: intake, audit, PPC-to-SEO opportunity mining, AI visibility,
implementation briefs, QA, and monthly reporting. We can pilot it on Summon and
one client, then decide whether we need a full-time SEO hire, a fractional expert
for QA, or no hire at all.

## 2-Minute Version

The problem is not that we cannot do any SEO. We already do the basics. The gap
is consistency, depth, and confidence.

If we hire one SEO person now, we get one person's judgement, one person's
availability, and one person's process. That may help, but it does not
automatically make the whole team capable.

What I want to build is a delivery system. The team follows workflows inside our
Claude SEO plugin. The system pulls client context from Summon Memory, market
data from DataForSEO, first-party data from GA4/Search Console/Google Ads, and
website evidence from crawl/render checks. It then produces a prioritised
backlog, implementation briefs, and monthly reporting.

The differentiator is that we use our paid-search data to make SEO better. We
can see what people actually search before converting in Google Ads, then find
where organic coverage is weak. That is a stronger angle than generic SEO
audits, especially for travel brands.

The first version is low-cost and low-risk: use the existing plugin, add the
read-only Google connector, run a pilot on Summon, then one client, then package
it as a client-facing service.

## How It Actually Works

### 1. Intake

The workflow starts with:

- Client profile from Summon Memory.
- Business goals.
- Target markets and seasonality.
- Access check for GA4, Search Console, Google Ads, CMS, DataForSEO, and prior
  reports.

Output: a standard intake brief.

### 2. Baseline Audit

The system checks:

- Technical SEO: indexation, rendering, canonicals, robots, sitemap, internal
  links, page speed, Core Web Vitals risk.
- Content quality: intent fit, thin pages, E-E-A-T, commercial usefulness,
  landing page gaps.
- Schema: accuracy, missing service/product/local schema, broken `@id`
  structure.
- GEO/AI visibility: entity clarity, `llms.txt`, AI crawler access, answer-ready
  content, citation potential.
- DataForSEO: ranked keywords, competitors, SERPs, backlinks, market demand.
- First-party data: GA4 organic landing pages, Search Console queries/pages,
  Google Ads search terms and landing pages.

Output: evidence-backed audit and prioritised backlog.

### 3. PPC-To-SEO Opportunity Mining

This is the strongest Summon angle.

The workflow takes Google Ads search terms and asks:

- Which paid queries drive clicks, conversions, or spend?
- Do we already rank organically for them?
- Is there an SEO page that matches the intent?
- Does GA4 show the landing page converts?
- Does DataForSEO show enough demand and realistic competition?

Output: a list of SEO pages, content updates, comparison pages, destination
pages, guides, or internal-linking work that are grounded in paid-search demand.

### 4. Implementation Briefs

Each approved opportunity becomes a brief:

- URL or proposed URL.
- Why it matters commercially.
- Evidence.
- Required content sections.
- Schema requirements.
- Internal links.
- Acceptance criteria.
- Measurement plan.

This makes the work actionable for content, dev, and account teams.

### 5. QA

Before anything goes to a client or live site:

- Evidence is checked.
- Claims are checked.
- Indexability and rendering are checked.
- Schema is validated.
- The recommendation is tied to business impact.

This is where we can optionally use a fractional SEO expert for review at first,
instead of hiring full-time.

### 6. Monthly Reporting

The monthly report is not just rankings.

It covers:

- What changed.
- Organic sessions/conversions from GA4.
- GSC clicks, impressions, CTR, and non-brand movement.
- DataForSEO ranking and visibility movement.
- AI visibility movement where measurable.
- Completed work.
- Next priorities.

## What The Team Needs To Do

The team does not need to become elite SEO specialists on day one.

They need to follow the operating system:

- Run intake.
- Pull the right data.
- Use the workflow to identify issues and opportunities.
- Sense-check the output.
- Turn recommendations into briefs.
- Use the QA checklist before delivery.

This makes SEO delivery more like a managed process than a purely expert-led
craft.

## What We Already Built

Already added in the repo:

- `skills/summon-seo-service/`
- `extensions/google-performance/`
- `services/summon-google-performance-mcp/`
- `templates/summon-seo/`
- packaged Claude Team plugin support

The next step is deployment and real data testing.

## Cost Model

### Internal Build Cost

The first version is mostly internal time.

Expected build effort:

- 1 week to make the workflow usable and connect Summon data.
- 1 additional week to pilot on one client and refine templates.
- No full-time hire required for the pilot.

Optional QA support:

- Fractional SEO expert for 2-4 hours per month during the pilot.
- Use them to review output quality, not to own delivery.

### Tooling Cost

Approximate monthly incremental cost for the pilot:

| Item | Expected cost | Notes |
| --- | ---: | --- |
| Google Search Console API | $0 | Google says Search Console API use is free, subject to limits. |
| GA4 Data API | $0 direct API fee | Quota/token constrained. Most requests use quota tokens rather than paid calls. |
| Google Ads API | $0 direct API fee | Google says the API is free at Explorer, Basic, and Standard Access levels, with policy/compliance caveats. |
| Railway connector hosting | $5-$20/month | Hobby is $5 minimum usage; Pro is $20 minimum usage. |
| DataForSEO | Usually $50+ account funding | Pay-as-you-go; minimum payment amount is $50. Actual usage depends on volume. |

Practical pilot estimate:

- Light pilot: $50-$100/month incremental spend.
- Active pilot with multiple audits: $100-$300/month.
- Larger scale depends on crawl depth, SERP checks, backlink volume, and AI
  visibility checks.

### DataForSEO Unit Cost Examples

Current public examples:

- Google Organic SERP API: from $0.60 per 1,000 standard SERPs, or $2 per 1,000
  live SERPs.
- OnPage API basic crawl: $0.15 per 1,000 crawled pages.
- OnPage API with browser rendering: about $5.10 per 1,000 pages.
- DataForSEO Google Ads keyword data: $60 per 1M keywords in standard queue.

So the data cost for normal audits is manageable if we control limits and do not
run huge backlink/crawl jobs by default.

## How We Can Launch

### Week 1: Internal MVP

- Deploy the Google Performance MCP service.
- Add real Summon allowlist for GA4, GSC, and Google Ads.
- Connect it to Claude Team as an organisation connector.
- Run `/summon seo baseline` on Summon.
- Produce one internal baseline audit and opportunity backlog.

Success criteria:

- The workflow produces useful recommendations.
- Data sources are labelled clearly.
- The team can follow the templates.
- We identify 5-10 actions for Summon's own site.

### Week 2: First Client Pilot

- Choose one client with GA4, GSC, Google Ads, and clear commercial goals.
- Run intake, baseline audit, PPC-to-SEO workflow, and AI visibility baseline.
- Produce:
  - audit summary
  - opportunity backlog
  - 3-5 implementation briefs
  - reporting baseline

Success criteria:

- At least 3 recommendations are clearly better because we used paid-search and
  first-party data.
- Account team understands the output.
- Client-facing recommendations are evidence-backed.

### Weeks 3-4: Productise

- Refine templates.
- Add SOPs.
- Create pricing/package options.
- Train 2-3 team members.
- Decide whether we need fractional SEO QA.

### Month 2: Beta Offer

Offer it to 2-3 clients as:

- SEO/GEO baseline sprint.
- PPC-to-SEO opportunity audit.
- AI visibility audit.
- Monthly SEO/GEO improvement retainer.

## Client-Facing Packaging

Recommended initial packages:

### 1. SEO/GEO Baseline Sprint

One-off audit and opportunity backlog.

Good for:

- Existing PPC clients.
- Clients asking about SEO.
- Clients worried about AI search.

Possible price range:

- GBP 2,000-5,000 depending site size and data access.

### 2. PPC-To-SEO Opportunity Sprint

Uses paid-search data to find organic growth opportunities.

Good for:

- Clients with mature Google Ads accounts.
- Travel brands with high paid-search spend.

Possible price range:

- GBP 1,500-4,000.

### 3. Monthly SEO/GEO Ops

Ongoing implementation backlog, reporting, and iteration.

Possible price range:

- GBP 1,500-5,000/month depending scope.

Positioning:

> We use paid-search intelligence and first-party performance data to prioritise
> SEO and AI visibility work that is more commercially grounded than a generic
> SEO audit.

## Why This Is Better Than Hiring First

Hiring first gives us capacity, but not necessarily repeatability.

Building the system first gives us:

- A consistent method.
- Better QA.
- Less dependence on one person.
- Faster onboarding for the team.
- A clearer idea of what kind of SEO hire, if any, we actually need.

The likely best end state is not "no SEO expert ever." It is:

- Build the system.
- Use the team to execute.
- Use a senior SEO person fractionally for QA and edge cases.
- Hire full-time only if demand proves it.

## Likely Objections And Answers

### "Can we really deliver great SEO without hiring an SEO person?"

We can deliver a very strong first version because the workflow is evidence-led.
The system does not rely on guessing. It pulls from DataForSEO, GA4, GSC, Google
Ads, website checks, and Summon Memory. For high-risk recommendations, we can add
fractional expert QA before hiring full-time.

### "Will this just create generic AI SEO recommendations?"

No. The workflow is built around data and templates. Every recommendation needs
evidence, priority, impact, effort, confidence, owner, and measurement plan. If
there is no evidence, it gets marked as an assumption or blocker.

### "Why would clients buy this from Summon?"

Because our angle is different. We are not selling generic SEO. We are using PPC
intelligence to make SEO commercially useful. For travel brands, that is highly
relevant because search demand, seasonality, destination intent, and conversion
data matter.

### "Is GEO/AI visibility too speculative?"

We should not sell guaranteed AI rankings. We should sell practical AI
visibility readiness: entity clarity, accurate schema, citeable content, crawler
access, source consistency, and content that can be used in AI answers.

### "Is the Google connector safe?"

Yes, if we keep it read-only. GA4 and Search Console have read-only scopes.
Google Ads does not have a separate read-only OAuth scope, so we enforce safety
through read-only account permissions, allowlisted customer IDs, templated
reporting tools, no mutation endpoints, and audit logs.

### "What if the output is wrong?"

That is why the system has QA. It separates evidence, interpretation, and
recommendation. It does not publish directly. Human review remains in the loop.

## The Ask On The Call

Ask for approval to run a controlled pilot:

1. Launch this internally using Summon's own site.
2. Connect the read-only Google Performance connector.
3. Run one client pilot.
4. Use fractional SEO QA only if needed.
5. Decide after 30 days whether to package it as a client-facing service.

Suggested ask:

> I am not asking us to avoid SEO expertise. I am asking us to build the system
> first, prove the workflow on Summon and one client, and then decide whether we
> need a hire, fractional QA, or just a trained internal delivery process.

## What Success Looks Like After 30 Days

- One Summon audit completed.
- One client pilot completed.
- Working Google Performance connector.
- Standard templates used by the team.
- 10-20 backlog opportunities generated with evidence.
- 3-5 implementation briefs ready for action.
- Clear decision on whether to sell this service more widely.

## One-Line Close

This gives Summon a way to build an SEO/GEO service from our existing strengths,
without betting everything on one hire before we know the delivery model works.
