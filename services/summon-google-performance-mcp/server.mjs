import express from "express";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const PUBLIC_PORT = Number.parseInt(process.env.PORT || "3000", 10);
const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v24";
const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GA4_BASE_URL = "https://analyticsdata.googleapis.com/v1beta";
const GSC_BASE_URL = "https://searchconsole.googleapis.com/webmasters/v3";

const staticBearerEnabled = Boolean(process.env.MCP_AUTH_TOKEN);
const oauthEnabled = Boolean(
  process.env.OAUTH_CLIENT_ID &&
    process.env.OAUTH_CLIENT_SECRET &&
    process.env.OAUTH_SIGNING_SECRET,
);

if (!staticBearerEnabled && !oauthEnabled) {
  console.error(
    "Configure either MCP_AUTH_TOKEN or OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET/OAUTH_SIGNING_SECRET.",
  );
  process.exit(1);
}

const expectedStaticTokenHash = staticBearerEnabled
  ? hashToken(process.env.MCP_AUTH_TOKEN)
  : null;
const expectedOAuthClientSecretHash = oauthEnabled
  ? hashToken(process.env.OAUTH_CLIENT_SECRET)
  : null;
const oauthSigningSecret = process.env.OAUTH_SIGNING_SECRET || "";
const oauthAccessTtlSeconds = Number.parseInt(
  process.env.OAUTH_ACCESS_TTL_SECONDS || "3600",
  10,
);
const oauthRefreshTtlSeconds = Number.parseInt(
  process.env.OAUTH_REFRESH_TTL_SECONDS || "2592000",
  10,
);
const oauthPrimaryScope =
  process.env.OAUTH_SCOPE || "summon-google-performance:read";
const oauthSupportedScopes = new Set([oauthPrimaryScope, "offline_access"]);
const oauthAllowedRedirectUris = (
  process.env.OAUTH_REDIRECT_URIS || "https://claude.ai/api/mcp/auth_callback"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const oauthAutoApprove = process.env.OAUTH_AUTO_APPROVE === "true";
const authorizationCodes = new Map();

const clients = parseClientAllowlist(process.env.CLIENT_ALLOWLIST_JSON || "{}");
let googleTokenCache = null;

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "authorization, content-type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

app.options("*", (_req, res) => {
  res.sendStatus(204);
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "summon-google-performance-mcp",
    googleAdsApiVersion: GOOGLE_ADS_API_VERSION,
    clients: Object.keys(clients).length,
    auth: {
      staticBearer: staticBearerEnabled,
      oauth: oauthEnabled,
    },
  });
});

app.get(
  [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ],
  (req, res) => {
    res.status(200).json({
      resource: getMcpPublicUrl(req),
      authorization_servers: [getPublicBaseUrl(req)],
      scopes_supported: [...oauthSupportedScopes],
      bearer_methods_supported: ["header"],
      resource_documentation:
        "https://github.com/serhiiSotskyi/claude-seo/blob/main/extensions/google-performance/docs/GOOGLE-PERFORMANCE-SETUP.md",
    });
  },
);

app.get(
  ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"],
  (req, res) => {
    const issuer = getPublicBaseUrl(req);
    res.status(200).json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
      ],
      scopes_supported: [...oauthSupportedScopes],
    });
  },
);

app.get("/authorize", (req, res) => {
  if (!oauthEnabled) {
    res.status(404).send("OAuth is not enabled for this service.");
    return;
  }

  const validation = validateAuthorizationRequest(req.query);
  if (!validation.ok) {
    res.status(400).send(validation.error);
    return;
  }

  if (oauthAutoApprove) {
    redirectWithAuthorizationCode(req, res, validation.params);
    return;
  }

  res.status(200).type("html").send(renderConsentPage(validation.params));
});

app.post("/authorize", express.urlencoded({ extended: false }), (req, res) => {
  if (!oauthEnabled) {
    res.status(404).send("OAuth is not enabled for this service.");
    return;
  }

  const validation = validateAuthorizationRequest(req.body);
  if (!validation.ok) {
    res.status(400).send(validation.error);
    return;
  }

  redirectWithAuthorizationCode(req, res, validation.params);
});

app.post("/token", express.urlencoded({ extended: false }), (req, res) => {
  if (!oauthEnabled) {
    res.status(404).json({ error: "oauth_not_enabled" });
    return;
  }

  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");

  const credentials = readOAuthClientCredentials(req);
  if (!isValidOAuthClient(credentials.clientId, credentials.clientSecret)) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (req.body.grant_type === "authorization_code") {
    handleAuthorizationCodeGrant(req, res);
    return;
  }

  if (req.body.grant_type === "refresh_token") {
    handleRefreshTokenGrant(req, res);
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

app.post("/mcp", requireMcpAuth, express.json({ limit: "2mb" }), async (req, res) => {
  const requests = Array.isArray(req.body) ? req.body : [req.body];
  const responses = [];

  for (const request of requests) {
    const response = await handleRpcRequest(request, req);
    if (response) {
      responses.push(response);
    }
  }

  if (Array.isArray(req.body)) {
    res.status(200).json(responses);
    return;
  }

  if (!responses.length) {
    res.sendStatus(204);
    return;
  }

  res.status(200).json(responses[0]);
});

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

const publicServer = app.listen(PUBLIC_PORT, () => {
  console.log(`Summon Google Performance MCP listening on port ${PUBLIC_PORT}`);
  console.log(
    `Authentication enabled: staticBearer=${staticBearerEnabled} oauth=${oauthEnabled}`,
  );
});

const tools = [
  {
    name: "list_clients",
    description:
      "List configured client keys and allowed first-party data sources.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ga4_channel_performance",
    description:
      "Read GA4 sessions, engaged sessions, conversions, and revenue by channel.",
    inputSchema: clientDateSchema({
      property_id: { type: "string", description: "Allowed GA4 property ID." },
      limit: numberSchema(1, 1000, 100),
    }),
  },
  {
    name: "ga4_landing_pages",
    description:
      "Read GA4 organic landing page performance for SEO opportunity analysis.",
    inputSchema: clientDateSchema({
      property_id: { type: "string", description: "Allowed GA4 property ID." },
      limit: numberSchema(1, 1000, 100),
    }),
  },
  {
    name: "ga4_conversions_by_landing_page",
    description:
      "Read GA4 conversions and revenue by organic landing page.",
    inputSchema: clientDateSchema({
      property_id: { type: "string", description: "Allowed GA4 property ID." },
      limit: numberSchema(1, 1000, 100),
    }),
  },
  {
    name: "gsc_search_analytics",
    description:
      "Read Google Search Console query or page performance for an allowed site.",
    inputSchema: clientDateSchema({
      site_url: { type: "string", description: "Allowed GSC site URL." },
      dimensions: {
        type: "array",
        items: {
          type: "string",
          enum: ["query", "page", "country", "device", "date"],
        },
        default: ["query", "page"],
      },
      limit: numberSchema(1, 25000, 1000),
    }),
  },
  {
    name: "gsc_queries_by_page",
    description:
      "Read Google Search Console queries for one allowed page URL.",
    inputSchema: clientDateSchema(
      {
        site_url: { type: "string", description: "Allowed GSC site URL." },
        page: { type: "string", description: "Page URL to filter." },
        limit: numberSchema(1, 25000, 1000),
      },
      ["page"],
    ),
  },
  {
    name: "gsc_brand_vs_nonbrand",
    description:
      "Split Google Search Console query performance into brand and non-brand groups.",
    inputSchema: clientDateSchema({
      site_url: { type: "string", description: "Allowed GSC site URL." },
      brand_terms: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional brand terms. Defaults to the client allowlist brandTerms.",
      },
      limit: numberSchema(1, 25000, 25000),
    }),
  },
  {
    name: "google_ads_campaign_performance",
    description:
      "Read Google Ads campaign performance using a templated reporting query.",
    inputSchema: clientDateSchema({
      customer_id: {
        type: "string",
        description: "Allowed Google Ads customer ID.",
      },
      limit: numberSchema(1, 10000, 1000),
    }),
  },
  {
    name: "google_ads_search_terms",
    description:
      "Read Google Ads search term performance using a templated reporting query.",
    inputSchema: clientDateSchema({
      customer_id: {
        type: "string",
        description: "Allowed Google Ads customer ID.",
      },
      min_clicks: numberSchema(0, 100000, 1),
      limit: numberSchema(1, 10000, 1000),
    }),
  },
  {
    name: "google_ads_landing_pages",
    description:
      "Read Google Ads landing page performance using a templated reporting query.",
    inputSchema: clientDateSchema({
      customer_id: {
        type: "string",
        description: "Allowed Google Ads customer ID.",
      },
      limit: numberSchema(1, 10000, 1000),
    }),
  },
  {
    name: "ppc_to_seo_opportunities",
    description:
      "Find paid search terms that may deserve SEO pages or optimisation.",
    inputSchema: clientDateSchema({
      customer_id: {
        type: "string",
        description: "Allowed Google Ads customer ID.",
      },
      min_clicks: numberSchema(0, 100000, 5),
      min_conversions: numberSchema(0, 100000, 1),
      limit: numberSchema(1, 5000, 500),
    }),
  },
];

async function handleRpcRequest(request, req) {
  if (!request || request.jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid JSON-RPC request.");
  }

  const id = request.id;
  try {
    if (request.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: {
          name: "summon-google-performance-mcp",
          version: "0.1.0",
        },
      });
    }

    if (request.method === "notifications/initialized") {
      return null;
    }

    if (request.method === "ping") {
      return rpcResult(id, {});
    }

    if (request.method === "tools/list") {
      return rpcResult(id, { tools });
    }

    if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      const result = await callTool(name, args, req);
      return rpcResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    }

    return rpcError(id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    console.error("MCP request failed:", error);
    return rpcError(id, -32000, error.message || "Request failed.");
  }
}

async function callTool(name, args, req) {
  switch (name) {
    case "list_clients":
      return listClients();
    case "ga4_channel_performance":
      return ga4ChannelPerformance(args, req);
    case "ga4_landing_pages":
      return ga4LandingPages(args, req);
    case "ga4_conversions_by_landing_page":
      return ga4ConversionsByLandingPage(args, req);
    case "gsc_search_analytics":
      return gscSearchAnalytics(args, req);
    case "gsc_queries_by_page":
      return gscQueriesByPage(args, req);
    case "gsc_brand_vs_nonbrand":
      return gscBrandVsNonbrand(args, req);
    case "google_ads_campaign_performance":
      return googleAdsCampaignPerformance(args, req);
    case "google_ads_search_terms":
      return googleAdsSearchTerms(args, req);
    case "google_ads_landing_pages":
      return googleAdsLandingPages(args, req);
    case "ppc_to_seo_opportunities":
      return ppcToSeoOpportunities(args, req);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function listClients() {
  return {
    clients: Object.entries(clients).map(([key, client]) => ({
      key,
      label: client.label || key,
      ga4Properties: maskArray(client.ga4Properties),
      gscSites: client.gscSites || [],
      googleAdsCustomerIds: maskArray(client.googleAdsCustomerIds),
      brandTerms: client.brandTerms || [],
    })),
  };
}

async function ga4ChannelPerformance(args, req) {
  const context = getGa4Context(args);
  const dateRange = normaliseDateRange(args, 366);
  const limit = clampNumber(args.limit, 1, 1000, 100);
  const report = await runGa4Report(context.propertyId, {
    dateRanges: [dateRange],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "conversions" },
      { name: "totalRevenue" },
    ],
    limit,
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
  });

  audit(req, "ga4_channel_performance", args, {
    rows: report.rows?.length || 0,
    propertyId: context.propertyId,
  });

  return {
    source: "GA4 Data API",
    client: context.clientKey,
    propertyId: context.propertyId,
    dateRange,
    rows: report.rows || [],
    metadata: report.metadata || null,
  };
}

async function ga4LandingPages(args, req) {
  const context = getGa4Context(args);
  const dateRange = normaliseDateRange(args, 366);
  const limit = clampNumber(args.limit, 1, 1000, 100);
  const report = await runGa4Report(context.propertyId, {
    dateRanges: [dateRange],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "conversions" },
      { name: "totalRevenue" },
    ],
    dimensionFilter: exactStringFilter(
      "sessionDefaultChannelGroup",
      "Organic Search",
    ),
    limit,
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
  });

  audit(req, "ga4_landing_pages", args, {
    rows: report.rows?.length || 0,
    propertyId: context.propertyId,
  });

  return {
    source: "GA4 Data API",
    client: context.clientKey,
    propertyId: context.propertyId,
    channel: "Organic Search",
    dateRange,
    rows: report.rows || [],
  };
}

async function ga4ConversionsByLandingPage(args, req) {
  const context = getGa4Context(args);
  const dateRange = normaliseDateRange(args, 366);
  const limit = clampNumber(args.limit, 1, 1000, 100);
  const report = await runGa4Report(context.propertyId, {
    dateRanges: [dateRange],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [
      { name: "conversions" },
      { name: "sessions" },
      { name: "totalRevenue" },
    ],
    dimensionFilter: exactStringFilter(
      "sessionDefaultChannelGroup",
      "Organic Search",
    ),
    limit,
    orderBys: [{ metric: { metricName: "conversions" }, desc: true }],
  });

  audit(req, "ga4_conversions_by_landing_page", args, {
    rows: report.rows?.length || 0,
    propertyId: context.propertyId,
  });

  return {
    source: "GA4 Data API",
    client: context.clientKey,
    propertyId: context.propertyId,
    channel: "Organic Search",
    dateRange,
    rows: report.rows || [],
  };
}

async function gscSearchAnalytics(args, req) {
  const context = getGscContext(args);
  const dateRange = normaliseDateRange(args, 486);
  const dimensions = Array.isArray(args.dimensions) && args.dimensions.length
    ? args.dimensions
    : ["query", "page"];
  const limit = clampNumber(args.limit, 1, 25000, 1000);
  const report = await querySearchConsole(context.siteUrl, {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    dimensions,
    rowLimit: limit,
  });

  audit(req, "gsc_search_analytics", args, {
    rows: report.rows?.length || 0,
    siteUrl: context.siteUrl,
  });

  return {
    source: "Google Search Console API",
    client: context.clientKey,
    siteUrl: context.siteUrl,
    dateRange,
    dimensions,
    rows: report.rows || [],
  };
}

async function gscQueriesByPage(args, req) {
  const context = getGscContext(args);
  const page = requireString(args.page, "page");
  const dateRange = normaliseDateRange(args, 486);
  const limit = clampNumber(args.limit, 1, 25000, 1000);
  const report = await querySearchConsole(context.siteUrl, {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    dimensions: ["query"],
    rowLimit: limit,
    dimensionFilterGroups: [
      {
        filters: [
          {
            dimension: "page",
            operator: "equals",
            expression: page,
          },
        ],
      },
    ],
  });

  audit(req, "gsc_queries_by_page", args, {
    rows: report.rows?.length || 0,
    siteUrl: context.siteUrl,
  });

  return {
    source: "Google Search Console API",
    client: context.clientKey,
    siteUrl: context.siteUrl,
    page,
    dateRange,
    rows: report.rows || [],
  };
}

async function gscBrandVsNonbrand(args, req) {
  const context = getGscContext(args);
  const dateRange = normaliseDateRange(args, 486);
  const limit = clampNumber(args.limit, 1, 25000, 25000);
  const brandTerms =
    Array.isArray(args.brand_terms) && args.brand_terms.length
      ? args.brand_terms
      : context.client.brandTerms || [];

  if (!brandTerms.length) {
    throw new Error(
      "No brand terms configured. Add brandTerms to CLIENT_ALLOWLIST_JSON or pass brand_terms.",
    );
  }

  const report = await querySearchConsole(context.siteUrl, {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    dimensions: ["query"],
    rowLimit: limit,
  });
  const summary = splitBrandQueries(report.rows || [], brandTerms);

  audit(req, "gsc_brand_vs_nonbrand", args, {
    rows: report.rows?.length || 0,
    siteUrl: context.siteUrl,
  });

  return {
    source: "Google Search Console API",
    client: context.clientKey,
    siteUrl: context.siteUrl,
    dateRange,
    brandTerms,
    summary,
  };
}

async function googleAdsCampaignPerformance(args, req) {
  const context = getGoogleAdsContext(args);
  const dateRange = normaliseDateRange(args, 366);
  const limit = clampNumber(args.limit, 1, 10000, 1000);
  const query = `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'
    ORDER BY metrics.clicks DESC
    LIMIT ${limit}
  `;
  const rows = await searchGoogleAds(context.customerId, query);

  audit(req, "google_ads_campaign_performance", args, {
    rows: rows.length,
    customerId: context.customerId,
  });

  return {
    source: "Google Ads API",
    client: context.clientKey,
    customerId: context.customerId,
    dateRange,
    rows,
  };
}

async function googleAdsSearchTerms(args, req) {
  const context = getGoogleAdsContext(args);
  const dateRange = normaliseDateRange(args, 366);
  const minClicks = clampNumber(args.min_clicks, 0, 100000, 1);
  const limit = clampNumber(args.limit, 1, 10000, 1000);
  const rows = await fetchGoogleAdsSearchTerms(context.customerId, dateRange, {
    minClicks,
    limit,
  });

  audit(req, "google_ads_search_terms", args, {
    rows: rows.length,
    customerId: context.customerId,
  });

  return {
    source: "Google Ads API",
    client: context.clientKey,
    customerId: context.customerId,
    dateRange,
    minClicks,
    rows,
  };
}

async function googleAdsLandingPages(args, req) {
  const context = getGoogleAdsContext(args);
  const dateRange = normaliseDateRange(args, 366);
  const limit = clampNumber(args.limit, 1, 10000, 1000);
  const query = `
    SELECT
      landing_page_view.unexpanded_final_url,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM landing_page_view
    WHERE segments.date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'
    ORDER BY metrics.clicks DESC
    LIMIT ${limit}
  `;
  const rows = await searchGoogleAds(context.customerId, query);

  audit(req, "google_ads_landing_pages", args, {
    rows: rows.length,
    customerId: context.customerId,
  });

  return {
    source: "Google Ads API",
    client: context.clientKey,
    customerId: context.customerId,
    dateRange,
    rows,
  };
}

async function ppcToSeoOpportunities(args, req) {
  const context = getGoogleAdsContext(args);
  const dateRange = normaliseDateRange(args, 366);
  const minClicks = clampNumber(args.min_clicks, 0, 100000, 5);
  const minConversions = clampNumber(args.min_conversions, 0, 100000, 1);
  const limit = clampNumber(args.limit, 1, 5000, 500);
  const rows = await fetchGoogleAdsSearchTerms(context.customerId, dateRange, {
    minClicks,
    limit,
  });
  const opportunities = summarisePpcToSeo(rows, {
    minConversions,
    brandTerms: context.client.brandTerms || [],
  });

  audit(req, "ppc_to_seo_opportunities", args, {
    rows: rows.length,
    opportunities: opportunities.length,
    customerId: context.customerId,
  });

  return {
    source: "Google Ads API",
    client: context.clientKey,
    customerId: context.customerId,
    dateRange,
    method:
      "Grouped templated Google Ads search term report. Validate with GSC, GA4, and DataForSEO before implementation.",
    opportunities,
  };
}

async function fetchGoogleAdsSearchTerms(customerId, dateRange, options) {
  const query = `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      search_term_view.search_term,
      segments.device,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc
    FROM search_term_view
    WHERE segments.date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'
      AND metrics.clicks >= ${options.minClicks}
    ORDER BY metrics.clicks DESC
    LIMIT ${options.limit}
  `;

  return searchGoogleAds(customerId, query);
}

function summarisePpcToSeo(rows, options) {
  const grouped = new Map();
  for (const row of rows) {
    const term = String(row.searchTermView?.searchTerm || "").trim();
    if (!term) {
      continue;
    }

    const key = normaliseSearchTermCluster(term);
    const current = grouped.get(key) || {
      cluster: key,
      exampleTerms: [],
      impressions: 0,
      clicks: 0,
      costMicros: 0,
      conversions: 0,
      conversionValue: 0,
      containsBrand: containsAny(term, options.brandTerms),
    };

    if (current.exampleTerms.length < 5 && !current.exampleTerms.includes(term)) {
      current.exampleTerms.push(term);
    }

    current.impressions += Number(row.metrics?.impressions || 0);
    current.clicks += Number(row.metrics?.clicks || 0);
    current.costMicros += Number(row.metrics?.costMicros || 0);
    current.conversions += Number(row.metrics?.conversions || 0);
    current.conversionValue += Number(row.metrics?.conversionsValue || 0);
    current.containsBrand ||= containsAny(term, options.brandTerms);
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .filter((item) => item.conversions >= options.minConversions)
    .sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks)
    .map((item) => ({
      ...item,
      cost: item.costMicros / 1_000_000,
      recommendation: item.containsBrand
        ? "Usually protect with brand SEO and sitelinks; only create new content if there is a clear non-brand intent variant."
        : "Validate with GSC and DataForSEO. If organic coverage is weak, consider an SEO landing page or content cluster.",
      nextEvidence:
        "Check GSC query/page coverage, GA4 landing page conversions, and DataForSEO volume/difficulty before briefing implementation.",
    }));
}

async function runGa4Report(propertyId, body) {
  const token = await getGoogleAccessToken();
  const response = await fetch(
    `${GA4_BASE_URL}/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  return parseGoogleResponse(response);
}

async function querySearchConsole(siteUrl, body) {
  const token = await getGoogleAccessToken();
  const response = await fetch(
    `${GSC_BASE_URL}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  return parseGoogleResponse(response);
}

async function searchGoogleAds(customerId, query) {
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is required for Google Ads tools.");
  }

  const token = await getGoogleAccessToken();
  const headers = {
    authorization: `Bearer ${token}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "content-type": "application/json",
  };

  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = stripCustomerId(
      process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    );
  }

  const response = await fetch(
    `${GOOGLE_ADS_BASE_URL}/customers/${stripCustomerId(customerId)}/googleAds:searchStream`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ query: normaliseGaql(query) }),
    },
  );
  const data = await parseGoogleResponse(response);

  if (!Array.isArray(data)) {
    return data.results || [];
  }

  return data.flatMap((chunk) => chunk.results || []);
}

async function getGoogleAccessToken() {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing Google OAuth variables: ${missing.join(", ")}`);
  }

  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) {
    return googleTokenCache.accessToken;
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await parseGoogleResponse(response);
  googleTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return googleTokenCache.accessToken;
}

async function parseGoogleResponse(response) {
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.error_description ||
      `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return data || {};
}

function getGa4Context(args) {
  const { clientKey, client } = requireClient(args.client_key);
  const propertyId = args.property_id || firstAllowed(client.ga4Properties, "GA4");
  if (!client.ga4Properties?.includes(String(propertyId))) {
    throw new Error(`GA4 property is not allowlisted for client: ${clientKey}`);
  }
  return { clientKey, client, propertyId: String(propertyId) };
}

function getGscContext(args) {
  const { clientKey, client } = requireClient(args.client_key);
  const siteUrl = args.site_url || firstAllowed(client.gscSites, "GSC");
  if (!client.gscSites?.includes(String(siteUrl))) {
    throw new Error(`GSC site is not allowlisted for client: ${clientKey}`);
  }
  return { clientKey, client, siteUrl: String(siteUrl) };
}

function getGoogleAdsContext(args) {
  const { clientKey, client } = requireClient(args.client_key);
  const customerId =
    args.customer_id || firstAllowed(client.googleAdsCustomerIds, "Google Ads");
  const normalisedAllowed = (client.googleAdsCustomerIds || []).map(stripCustomerId);
  if (!normalisedAllowed.includes(stripCustomerId(customerId))) {
    throw new Error(
      `Google Ads customer ID is not allowlisted for client: ${clientKey}`,
    );
  }
  return {
    clientKey,
    client,
    customerId: stripCustomerId(customerId),
  };
}

function requireClient(clientKey) {
  const key = requireString(clientKey, "client_key");
  const client = clients[key];
  if (!client) {
    throw new Error(`Unknown or unconfigured client_key: ${key}`);
  }
  return { clientKey: key, client };
}

function firstAllowed(values, label) {
  if (!Array.isArray(values) || !values.length) {
    throw new Error(`No ${label} source is configured for this client.`);
  }
  return values[0];
}

function parseClientAllowlist(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("CLIENT_ALLOWLIST_JSON must be an object.");
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        {
          label: value.label || key,
          ga4Properties: asStringArray(value.ga4Properties),
          gscSites: asStringArray(value.gscSites),
          googleAdsCustomerIds: asStringArray(value.googleAdsCustomerIds).map(
            stripCustomerId,
          ),
          brandTerms: asStringArray(value.brandTerms),
        },
      ]),
    );
  } catch (error) {
    console.error(`Invalid CLIENT_ALLOWLIST_JSON: ${error.message}`);
    process.exit(1);
  }
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function normaliseDateRange(args, maxDays) {
  const endDate = args.end_date || formatDate(new Date());
  const startDate = args.start_date || shiftDate(endDate, -90);
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("start_date and end_date must be YYYY-MM-DD.");
  }

  const days = dateDiffDays(startDate, endDate);
  if (days < 0) {
    throw new Error("start_date must be before or equal to end_date.");
  }
  if (days > maxDays) {
    throw new Error(`Date range exceeds max of ${maxDays} days.`);
  }

  return { startDate, endDate };
}

function clientDateSchema(extraProperties, extraRequired = []) {
  return {
    type: "object",
    required: ["client_key", ...extraRequired],
    properties: {
      client_key: {
        type: "string",
        description: "Client key from CLIENT_ALLOWLIST_JSON.",
      },
      start_date: {
        type: "string",
        description: "Start date in YYYY-MM-DD format. Defaults to 90 days ago.",
      },
      end_date: {
        type: "string",
        description: "End date in YYYY-MM-DD format. Defaults to today.",
      },
      ...extraProperties,
    },
    additionalProperties: false,
  };
}

function numberSchema(minimum, maximum, defaultValue) {
  return {
    type: "number",
    minimum,
    maximum,
    default: defaultValue,
  };
}

function exactStringFilter(fieldName, value) {
  return {
    filter: {
      fieldName,
      stringFilter: {
        matchType: "EXACT",
        value,
      },
    },
  };
}

function splitBrandQueries(rows, brandTerms) {
  const summary = {
    brand: emptyGscSummary(),
    nonBrand: emptyGscSummary(),
    totalRows: rows.length,
  };

  for (const row of rows) {
    const query = String(row.keys?.[0] || "");
    const bucket = containsAny(query, brandTerms) ? summary.brand : summary.nonBrand;
    bucket.rows += 1;
    bucket.clicks += Number(row.clicks || 0);
    bucket.impressions += Number(row.impressions || 0);
    bucket.positionWeighted += Number(row.position || 0) * Number(row.impressions || 0);
  }

  for (const bucket of [summary.brand, summary.nonBrand]) {
    bucket.ctr = bucket.impressions ? bucket.clicks / bucket.impressions : 0;
    bucket.averagePosition = bucket.impressions
      ? bucket.positionWeighted / bucket.impressions
      : 0;
    delete bucket.positionWeighted;
  }

  return summary;
}

function emptyGscSummary() {
  return {
    rows: 0,
    clicks: 0,
    impressions: 0,
    ctr: 0,
    averagePosition: 0,
    positionWeighted: 0,
  };
}

function containsAny(value, terms) {
  const normalised = String(value || "").toLowerCase();
  return (terms || []).some((term) =>
    normalised.includes(String(term).toLowerCase()),
  );
}

function normaliseSearchTermCluster(term) {
  return String(term)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => !["the", "a", "an", "and", "or", "to", "for"].includes(word))
    .slice(0, 6)
    .join(" ");
}

function normaliseGaql(query) {
  return String(query)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function stripCustomerId(value) {
  return String(value || "").replaceAll("-", "").trim();
}

function clampNumber(value, minimum, maximum, defaultValue) {
  const number = Number(value ?? defaultValue);
  if (!Number.isFinite(number)) {
    return defaultValue;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function requireString(value, name) {
  const string = String(value || "").trim();
  if (!string) {
    throw new Error(`${name} is required.`);
  }
  return string;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateDiffDays(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function maskArray(values) {
  return (values || []).map((value) => {
    const text = String(value);
    if (text.length <= 6) {
      return text;
    }
    return `${text.slice(0, 3)}...${text.slice(-3)}`;
  });
}

function audit(req, tool, args, result) {
  console.log(
    JSON.stringify({
      event: "mcp_tool_call",
      service: "summon-google-performance-mcp",
      tool,
      clientKey: args.client_key || null,
      result,
      userAgent: req.get("user-agent") || null,
      ts: new Date().toISOString(),
    }),
  );
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function requireMcpAuth(req, res, next) {
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  const authHeader = req.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (staticBearerEnabled && constantTimeTokenEquals(token, expectedStaticTokenHash)) {
    next();
    return;
  }

  if (oauthEnabled && verifySignedToken(token, req, "access")) {
    next();
    return;
  }

  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${getProtectedResourceMetadataUrl(
      req,
    )}", scope="${getDefaultScopeString()}"`,
  );
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
}

function hashToken(value) {
  return createHash("sha256").update(value || "", "utf8").digest();
}

function constantTimeTokenEquals(token, expectedHash) {
  if (!token || !expectedHash) {
    return false;
  }

  const actualHash = hashToken(token);
  return (
    actualHash.length === expectedHash.length &&
    timingSafeEqual(actualHash, expectedHash)
  );
}

function validateAuthorizationRequest(input) {
  const params = {
    responseType: String(input.response_type || ""),
    clientId: String(input.client_id || ""),
    redirectUri: String(input.redirect_uri || ""),
    scope: normalizeScope(input.scope),
    state: String(input.state || ""),
    codeChallenge: String(input.code_challenge || ""),
    codeChallengeMethod: String(input.code_challenge_method || ""),
  };

  if (params.responseType !== "code") {
    return { ok: false, error: "Unsupported response_type." };
  }

  if (params.clientId !== process.env.OAUTH_CLIENT_ID) {
    return { ok: false, error: "Unknown OAuth client." };
  }

  if (!oauthAllowedRedirectUris.includes(params.redirectUri)) {
    return { ok: false, error: "Invalid redirect_uri." };
  }

  if (!params.codeChallenge || params.codeChallengeMethod !== "S256") {
    return { ok: false, error: "PKCE S256 is required." };
  }

  return { ok: true, params };
}

function redirectWithAuthorizationCode(req, res, params) {
  const code = randomToken();
  authorizationCodes.set(code, {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scope: params.scope,
    codeChallenge: params.codeChallenge,
    expiresAt: Date.now() + 5 * 60 * 1000,
    issuer: getPublicBaseUrl(req),
    audience: getMcpPublicUrl(req),
  });

  const redirectUrl = new URL(params.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (params.state) {
    redirectUrl.searchParams.set("state", params.state);
  }

  res.redirect(302, redirectUrl.toString());
}

function handleAuthorizationCodeGrant(req, res) {
  const code = String(req.body.code || "");
  const verifier = String(req.body.code_verifier || "");
  const redirectUri = String(req.body.redirect_uri || "");
  const codeRecord = authorizationCodes.get(code);
  authorizationCodes.delete(code);

  if (!codeRecord || codeRecord.expiresAt < Date.now()) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  if (codeRecord.redirectUri !== redirectUri) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  if (!verifier || pkceS256(verifier) !== codeRecord.codeChallenge) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  res.status(200).json(issueTokenSet(req, codeRecord.scope));
}

function handleRefreshTokenGrant(req, res) {
  const refreshToken = String(req.body.refresh_token || "");
  const payload = verifySignedToken(refreshToken, req, "refresh");

  if (!payload) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  res.status(200).json(issueTokenSet(req, payload.scope || getDefaultScopeString()));
}

function issueTokenSet(req, scope) {
  const issuer = getPublicBaseUrl(req);
  const audience = getMcpPublicUrl(req);

  return {
    access_token: createSignedToken(
      {
        typ: "access",
        iss: issuer,
        aud: audience,
        sub: "claude-team",
        scope,
      },
      oauthAccessTtlSeconds,
    ),
    token_type: "Bearer",
    expires_in: oauthAccessTtlSeconds,
    refresh_token: createSignedToken(
      {
        typ: "refresh",
        iss: issuer,
        aud: audience,
        sub: "claude-team",
        scope,
      },
      oauthRefreshTtlSeconds,
    ),
    scope,
  };
}

function createSignedToken(claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      ...claims,
      iat: now,
      exp: now + ttlSeconds,
      jti: randomToken(),
    }),
  );
  const signature = signTokenPayload(payload);
  return `${payload}.${signature}`;
}

function verifySignedToken(token, req, expectedType) {
  if (!token || !token.includes(".")) {
    return null;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }

  if (!constantTimeStringEquals(signature, signTokenPayload(payload))) {
    return null;
  }

  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(payload));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    claims.typ !== expectedType ||
    claims.exp < now ||
    claims.iss !== getPublicBaseUrl(req) ||
    claims.aud !== getMcpPublicUrl(req)
  ) {
    return null;
  }

  return claims;
}

function signTokenPayload(payload) {
  return createHmac("sha256", oauthSigningSecret)
    .update(payload, "utf8")
    .digest("base64url");
}

function readOAuthClientCredentials(req) {
  const basic = req.get("authorization") || "";
  if (basic.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(basic.slice("Basic ".length), "base64")
        .toString("utf8")
        .split(":");
      return {
        clientId: decoded.shift() || "",
        clientSecret: decoded.join(":"),
      };
    } catch {
      return { clientId: "", clientSecret: "" };
    }
  }

  return {
    clientId: String(req.body.client_id || ""),
    clientSecret: String(req.body.client_secret || ""),
  };
}

function isValidOAuthClient(clientId, clientSecret) {
  return (
    clientId === process.env.OAUTH_CLIENT_ID &&
    constantTimeTokenEquals(clientSecret, expectedOAuthClientSecretHash)
  );
}

function normalizeScope(scope) {
  const requested = String(scope || "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const filtered = requested.filter((value) => oauthSupportedScopes.has(value));
  if (!filtered.length) {
    return getDefaultScopeString();
  }

  if (!filtered.includes(oauthPrimaryScope)) {
    filtered.unshift(oauthPrimaryScope);
  }

  return [...new Set(filtered)].join(" ");
}

function getDefaultScopeString() {
  return `${oauthPrimaryScope} offline_access`;
}

function pkceS256(verifier) {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function getProtectedResourceMetadataUrl(req) {
  return `${getPublicBaseUrl(req)}/.well-known/oauth-protected-resource`;
}

function getMcpPublicUrl(req) {
  if (process.env.MCP_PUBLIC_URL) {
    return process.env.MCP_PUBLIC_URL.replace(/\/$/, "");
  }

  return `${getPublicBaseUrl(req)}/mcp`;
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function renderConsentPage(params) {
  const hiddenFields = Object.entries({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  })
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(
          value,
        )}">`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Summon Google Performance to Claude</title>
  <style>
    body {
      color: #1f2933;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f6f7f9;
    }
    main {
      background: #fff;
      border: 1px solid #dde1e6;
      border-radius: 8px;
      box-shadow: 0 16px 40px rgba(18, 32, 53, 0.08);
      max-width: 560px;
      padding: 32px;
    }
    h1 {
      font-size: 24px;
      line-height: 1.25;
      margin: 0 0 12px;
    }
    p {
      font-size: 15px;
      line-height: 1.55;
      margin: 0 0 18px;
    }
    button {
      appearance: none;
      background: #1f2933;
      border: 0;
      border-radius: 6px;
      color: #fff;
      cursor: pointer;
      font-size: 15px;
      font-weight: 600;
      padding: 12px 16px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Connect Summon Google Performance to Claude</h1>
    <p>This lets Claude use Summon's read-only GA4, Search Console, and Google Ads reporting connector for SEO and GEO workflows.</p>
    <form method="post" action="/authorize">
      ${hiddenFields}
      <button type="submit">Connect</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function constantTimeStringEquals(actual, expected) {
  return constantTimeTokenEquals(actual, hashToken(expected));
}

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  publicServer.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
