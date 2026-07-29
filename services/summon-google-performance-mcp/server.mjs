import express from "express";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SERVICE_NAME = "summon-google-performance-mcp";
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

const safetyState = createSafetyState();
const READONLY_SAFETY = {
  globalConcurrency: parsePositiveInt(process.env.SAFETY_GLOBAL_CONCURRENCY, 3),
  perContextConcurrency: parsePositiveInt(
    process.env.SAFETY_PER_CONTEXT_CONCURRENCY,
    1,
  ),
  globalRateLimit: parsePositiveInt(process.env.SAFETY_GLOBAL_RATE_LIMIT, 30),
  perContextRateLimit: parsePositiveInt(
    process.env.SAFETY_PER_CONTEXT_RATE_LIMIT,
    10,
  ),
  rateWindowMs: parsePositiveInt(process.env.SAFETY_RATE_WINDOW_MS, 60_000),
  cacheTtlMs: parsePositiveInt(process.env.SAFETY_CACHE_TTL_MS, 21_600_000),
  todayCacheTtlMs: parsePositiveInt(
    process.env.SAFETY_TODAY_CACHE_TTL_MS,
    900_000,
  ),
  circuitCooldownMs: parsePositiveInt(
    process.env.SAFETY_CIRCUIT_COOLDOWN_MS,
    3_600_000,
  ),
  requestTimeoutMs: parsePositiveInt(
    process.env.SAFETY_REQUEST_TIMEOUT_MS,
    30_000,
  ),
  maxAttempts: parsePositiveInt(process.env.SAFETY_MAX_ATTEMPTS, 3),
};

const MONITORING_WEBHOOK_URL =
  process.env.N8N_MONITOR_WEBHOOK_URL || process.env.MONITORING_WEBHOOK_URL || "";
const MONITORING_WEBHOOK_SECRET = process.env.MONITORING_WEBHOOK_SECRET || "";
const MONITORING_TIMEOUT_MS = parsePositiveInt(
  process.env.MONITORING_TIMEOUT_MS,
  1_500,
);
const MONITORING_ENVIRONMENT =
  process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "production";

// readonly-safety-allow-risk-terms:start
const READONLY_DENYLIST = [
  ":mutate",
  "googleAds:mutate",
  "billing",
  "payment",
  "customerUserAccess",
  "customerManagerLink",
  "accountBudget",
  "campaignBudget",
  "campaignCriterion",
  "operations",
];
// readonly-safety-allow-risk-terms:end

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
    service: SERVICE_NAME,
    googleAdsApiVersion: GOOGLE_ADS_API_VERSION,
    clients: Object.keys(clients).length,
    monitoring: {
      enabled: Boolean(MONITORING_WEBHOOK_URL),
    },
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
        "none",
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

  const validation = validateAuthorizationRequest(req.query, req);
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

  const validation = validateAuthorizationRequest(req.body, req);
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
  if (!isKnownOAuthClient(credentials.clientId, credentials.clientSecret, req)) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (req.body.grant_type === "authorization_code") {
    handleAuthorizationCodeGrant(req, res, credentials);
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
          name: SERVICE_NAME,
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
    emitMonitoringEvent({
      event: "mcp_tool_error",
      tool: request?.params?.name || request?.method || "unknown",
      clientKey: request?.params?.arguments?.client_key || null,
      errorMessage: safeErrorMessage(error),
    });
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
  const contextKey = `google:ga4:${propertyId}`;
  const cacheKey = stableCacheKey("google:ga4", propertyId, body);
  return withCachedJson(cacheKey, cacheTtlForReportBody(body), async () => {
    const token = await getGoogleAccessToken();
    const response = await safeFetch(
      "ga4_run_report",
      `${GA4_BASE_URL}/properties/${encodeURIComponent(propertyId)}:runReport`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { contextKey },
    );

    return parseGoogleResponse(response, { circuitKey: contextKey });
  });
}

async function querySearchConsole(siteUrl, body) {
  const contextKey = `google:gsc:${siteUrl}`;
  const cacheKey = stableCacheKey("google:gsc", siteUrl, body);
  return withCachedJson(cacheKey, cacheTtlForReportBody(body), async () => {
    const token = await getGoogleAccessToken();
    const response = await safeFetch(
      "gsc_search_analytics",
      `${GSC_BASE_URL}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { contextKey },
    );

    return parseGoogleResponse(response, { circuitKey: contextKey });
  });
}

async function searchGoogleAds(customerId, query) {
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is required for Google Ads tools.");
  }

  const normalisedCustomerId = stripCustomerId(customerId);
  const normalisedQuery = normaliseGaql(query);
  const contextKey = `google:ads:${normalisedCustomerId}`;
  const cacheKey = stableCacheKey(
    "google:ads:searchStream",
    normalisedCustomerId,
    normalisedQuery,
  );

  return withCachedJson(cacheKey, cacheTtlForGaql(normalisedQuery), async () => {
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

    const response = await safeFetch(
      "google_ads_search_stream",
      `${GOOGLE_ADS_BASE_URL}/customers/${normalisedCustomerId}/googleAds:searchStream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query: normalisedQuery }),
      },
      { contextKey },
    );
    const data = await parseGoogleResponse(response, { circuitKey: contextKey });

    if (!Array.isArray(data)) {
      return data.results || [];
    }

    return data.flatMap((chunk) => chunk.results || []);
  });
}

async function getGoogleAccessToken() {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_REFRESH_TOKEN"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing Google OAuth variables: ${missing.join(", ")}`);
  }

  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) {
    return googleTokenCache.accessToken;
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  if (process.env.GOOGLE_CLIENT_SECRET) {
    params.set("client_secret", process.env.GOOGLE_CLIENT_SECRET);
  }

  const response = await safeFetch(
    "google_oauth_token",
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    },
    { contextKey: "google:auth" },
  );
  const data = await parseGoogleResponse(response, {
    circuitKey: "google:auth",
    providerAuth: true,
  });
  googleTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return googleTokenCache.accessToken;
}

async function parseGoogleResponse(response, meta = {}) {
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
    handleVendorStopState(response.status, message, data, meta);
    throw new Error(message);
  }

  return data || {};
}

async function safeFetch(endpointKey, url, options = {}, meta = {}) {
  const requestUrl = new URL(url);
  const contextKey = meta.contextKey || endpointKey;
  try {
    assertCircuitClosed(contextKey);
    assertAllowedOutboundRequest(endpointKey, requestUrl, options);
  } catch (error) {
    emitMonitoringEvent(
      outboundMonitoringEvent(
        "outbound_api_blocked",
        endpointKey,
        requestUrl,
        options,
        { contextKey },
        {
          outcome: "blocked",
          errorMessage: safeErrorMessage(error),
        },
      ),
    );
    throw error;
  }

  return withConcurrency(contextKey, async () => {
    await enforceRateLimit(
      "google:global",
      READONLY_SAFETY.globalRateLimit,
      READONLY_SAFETY.rateWindowMs,
    );
    await enforceRateLimit(
      `google:${contextKey}`,
      READONLY_SAFETY.perContextRateLimit,
      READONLY_SAFETY.rateWindowMs,
    );
    return fetchWithRetry(endpointKey, requestUrl, options, { contextKey });
  });
}

async function fetchWithRetry(endpointKey, requestUrl, options, meta) {
  const startedAt = Date.now();
  let lastError = null;
  const transientStatuses = [];
  for (let attempt = 0; attempt < READONLY_SAFETY.maxAttempts; attempt += 1) {
    try {
      const response = await executeSafeFetchAttempt(requestUrl, options);
      if (!isRetryableStatus(response.status)) {
        emitMonitoringEvent(
          outboundMonitoringEvent(
            "outbound_api_call",
            endpointKey,
            requestUrl,
            options,
            meta,
            {
              outcome: response.ok ? "ok" : "error",
              status: response.status,
              attempts: attempt + 1,
              retryCount: attempt,
              durationMs: Date.now() - startedAt,
              transientStatuses,
              vendorRequestId: responseTrackingId(response),
            },
          ),
        );
        return response;
      }

      if (attempt >= READONLY_SAFETY.maxAttempts - 1) {
        emitMonitoringEvent(
          outboundMonitoringEvent(
            "outbound_api_call",
            endpointKey,
            requestUrl,
            options,
            meta,
            {
              outcome: "retry_exhausted",
              status: response.status,
              attempts: attempt + 1,
              retryCount: attempt,
              durationMs: Date.now() - startedAt,
              transientStatuses,
              vendorRequestId: responseTrackingId(response),
            },
          ),
        );
        return response;
      }

      transientStatuses.push(response.status);
      await drainResponse(response);
      await sleep(retryDelayMs(response, attempt));
    } catch (error) {
      lastError = error;
      transientStatuses.push("network_error");
      if (attempt >= READONLY_SAFETY.maxAttempts - 1) {
        break;
      }
      await sleep(retryDelayMs(null, attempt));
    }
  }

  const finalError = new Error(
    `Google request failed after retries: ${endpointKey} ${
      lastError?.message || "unknown error"
    }`,
  );
  emitMonitoringEvent(
    outboundMonitoringEvent(
      "outbound_api_call",
      endpointKey,
      requestUrl,
      options,
      meta,
      {
        outcome: "network_error",
        attempts: READONLY_SAFETY.maxAttempts,
        retryCount: READONLY_SAFETY.maxAttempts - 1,
        durationMs: Date.now() - startedAt,
        transientStatuses,
        errorMessage: safeErrorMessage(finalError),
      },
    ),
  );
  throw finalError;
}

async function executeSafeFetchAttempt(requestUrl, options) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    READONLY_SAFETY.requestTimeoutMs,
  );
  try {
    return await fetch(requestUrl, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function assertAllowedOutboundRequest(endpointKey, requestUrl, options) {
  const method = String(options.method || "GET").toUpperCase();
  if (method !== "POST") {
    throw new Error(`Blocked non-POST outbound request: ${endpointKey}`);
  }

  assertNoDangerousOutboundIntent(endpointKey, requestUrl, options);

  const path = requestUrl.pathname;
  const host = requestUrl.hostname;
  const allowed =
    (endpointKey === "google_oauth_token" &&
      requestUrl.toString() === GOOGLE_TOKEN_URL) ||
    (endpointKey === "ga4_run_report" &&
      host === "analyticsdata.googleapis.com" &&
      /^\/v1beta\/properties\/[^/]+:runReport$/.test(path)) ||
    (endpointKey === "gsc_search_analytics" &&
      host === "searchconsole.googleapis.com" &&
      /^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/.test(path)) ||
    (endpointKey === "google_ads_search_stream" &&
      host === "googleads.googleapis.com" &&
      /^\/v\d+\/customers\/\d+\/googleAds:searchStream$/.test(path));

  if (!allowed) {
    throw new Error(
      `Blocked non-reporting Google endpoint: ${endpointKey} ${redactUrlForLog(
        requestUrl,
      )}`,
    );
  }
}

function assertNoDangerousOutboundIntent(endpointKey, requestUrl, options) {
  const body = endpointKey.includes("oauth") ? "" : bodyToString(options.body);
  const subject = `${requestUrl.toString()} ${body}`.toLowerCase();
  const blocked = READONLY_DENYLIST.find((term) =>
    subject.includes(term.toLowerCase()),
  );
  if (blocked) {
    throw new Error(`Blocked unsafe Google Ads API intent: ${blocked}`);
  }
}

async function withCachedJson(cacheKey, ttlMs, load) {
  pruneExpiredMaps();
  const cached = safetyState.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    emitMonitoringEvent({
      event: "cache_hit",
      provider: "google",
      cacheKeyHash: hashForAudit(cacheKey),
      ttlRemainingMs: cached.expiresAt - Date.now(),
    });
    return cloneJson(cached.value);
  }

  const inFlight = safetyState.inFlight.get(cacheKey);
  if (inFlight) {
    emitMonitoringEvent({
      event: "cache_inflight_dedupe",
      provider: "google",
      cacheKeyHash: hashForAudit(cacheKey),
    });
    return cloneJson(await inFlight);
  }

  const promise = (async () => cloneJson(await load()))();
  safetyState.inFlight.set(cacheKey, promise);
  try {
    const value = await promise;
    safetyState.cache.set(cacheKey, {
      value: cloneJson(value),
      expiresAt: Date.now() + ttlMs,
    });
    emitMonitoringEvent({
      event: "cache_store",
      provider: "google",
      cacheKeyHash: hashForAudit(cacheKey),
      ttlMs,
    });
    return cloneJson(value);
  } finally {
    safetyState.inFlight.delete(cacheKey);
  }
}

async function withConcurrency(contextKey, run) {
  await acquireSlot("global", READONLY_SAFETY.globalConcurrency);
  try {
    await acquireSlot(contextKey, READONLY_SAFETY.perContextConcurrency);
    try {
      return await run();
    } finally {
      releaseSlot(contextKey);
    }
  } finally {
    releaseSlot("global");
  }
}

async function acquireSlot(key, limit) {
  const semaphore = getSemaphore(key);
  if (semaphore.active < limit) {
    semaphore.active += 1;
    return;
  }

  await new Promise((resolve) => semaphore.queue.push(resolve));
  semaphore.active += 1;
}

function releaseSlot(key) {
  const semaphore = getSemaphore(key);
  semaphore.active = Math.max(0, semaphore.active - 1);
  const next = semaphore.queue.shift();
  if (next) {
    next();
  }
}

function getSemaphore(key) {
  if (!safetyState.semaphores.has(key)) {
    safetyState.semaphores.set(key, { active: 0, queue: [] });
  }
  return safetyState.semaphores.get(key);
}

async function enforceRateLimit(key, limit, windowMs) {
  const bucket = safetyState.rateBuckets.get(key) || [];
  safetyState.rateBuckets.set(key, bucket);

  while (true) {
    const now = Date.now();
    while (bucket.length && bucket[0] <= now - windowMs) {
      bucket.shift();
    }

    if (bucket.length < limit) {
      bucket.push(now);
      return;
    }

    await sleep(bucket[0] + windowMs - now + randomJitter(100));
  }
}

function handleVendorStopState(status, message, data, meta) {
  const classification = classifyVendorStopState(status, message, data);
  if (!classification) {
    return;
  }

  const circuitKey =
    classification.providerAuth || meta.providerAuth
      ? "google:auth"
      : meta.circuitKey;
  if (circuitKey) {
    openCircuit(circuitKey, classification.reason);
  }
}

function classifyVendorStopState(status, message, data) {
  const text = `${message || ""} ${JSON.stringify(data || {})}`.toLowerCase();
  if (
    status === 401 ||
    text.includes("invalid_grant") ||
    text.includes("invalid_token") ||
    text.includes("revoked") ||
    text.includes("unauthorized")
  ) {
    return { providerAuth: true, reason: "Google OAuth access is invalid or revoked." };
  }

  if (
    status === 403 ||
    text.includes("permission_denied") ||
    text.includes("access_denied") ||
    text.includes("authorization") ||
    text.includes("customer_not_enabled") ||
    text.includes("suspended") ||
    text.includes("restricted") ||
    text.includes("disabled") ||
    text.includes("not enabled") ||
    text.includes("billing") ||
    text.includes("payment")
  ) {
    return {
      providerAuth: false,
      reason: "Google account access is denied, restricted, suspended, or billing-blocked.",
    };
  }

  return null;
}

function assertCircuitClosed(key) {
  const circuit = safetyState.circuitBreakers.get(key);
  if (!circuit) {
    return;
  }

  if (circuit.until > Date.now()) {
    throw new Error(
      `Google connector circuit open for ${key} until ${new Date(
        circuit.until,
      ).toISOString()}: ${circuit.reason}`,
    );
  }

  safetyState.circuitBreakers.delete(key);
}

function openCircuit(key, reason) {
  safetyState.circuitBreakers.set(key, {
    reason,
    until: Date.now() + READONLY_SAFETY.circuitCooldownMs,
  });
  emitMonitoringEvent({
    event: "circuit_opened",
    provider: "google",
    contextKey: key,
    reason,
    cooldownMs: READONLY_SAFETY.circuitCooldownMs,
  });
}

function isRetryableStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }

  return Math.min(15_000, 1000 * 2 ** attempt) + randomJitter(250);
}

async function drainResponse(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // Ignore retry-drain failures; the next attempt is the useful signal.
  }
}

function cacheTtlForReportBody(body) {
  const endDate =
    body?.endDate ||
    body?.dateRanges?.[0]?.endDate ||
    body?.dateRanges?.[0]?.end_date;
  return isToday(endDate)
    ? READONLY_SAFETY.todayCacheTtlMs
    : READONLY_SAFETY.cacheTtlMs;
}

function cacheTtlForGaql(query) {
  const match = String(query).match(/between\s+'(\d{4}-\d{2}-\d{2})'\s+and\s+'(\d{4}-\d{2}-\d{2})'/i);
  return isToday(match?.[2])
    ? READONLY_SAFETY.todayCacheTtlMs
    : READONLY_SAFETY.cacheTtlMs;
}

function stableCacheKey(...parts) {
  return createHash("sha256")
    .update(parts.map(stableStringify).join("\n"), "utf8")
    .digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function cloneJson(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function pruneExpiredMaps() {
  const now = Date.now();
  for (const [key, entry] of safetyState.cache.entries()) {
    if (entry.expiresAt <= now) {
      safetyState.cache.delete(key);
    }
  }
  for (const [key, circuit] of safetyState.circuitBreakers.entries()) {
    if (circuit.until <= now) {
      safetyState.circuitBreakers.delete(key);
    }
  }
}

function createSafetyState() {
  return {
    semaphores: new Map(),
    rateBuckets: new Map(),
    cache: new Map(),
    inFlight: new Map(),
    circuitBreakers: new Map(),
  };
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

function parsePositiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
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

function maskIdentifier(value) {
  const text = String(value || "");
  if (text.length <= 6) {
    return text;
  }
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

function sanitizeContextKey(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s]+/g, (url) => redactUrlForLog(url))
    .replace(/\d{7,}/g, (id) => maskIdentifier(id));
}

function sanitizeForAudit(value, key = "") {
  const loweredKey = key.toLowerCase();
  if (
    loweredKey.includes("token") ||
    loweredKey.includes("secret") ||
    loweredKey.includes("authorization") ||
    loweredKey.includes("developer")
  ) {
    return "[redacted]";
  }

  if (
    loweredKey === "accountid" ||
    loweredKey === "customerid" ||
    loweredKey === "contextkey" ||
    loweredKey === "circuitkey" ||
    loweredKey.endsWith("accountid") ||
    loweredKey.endsWith("customerid")
  ) {
    return loweredKey === "contextkey" || loweredKey === "circuitkey"
      ? sanitizeContextKey(value)
      : maskIdentifier(value);
  }

  if (loweredKey.includes("url")) {
    return redactUrlForLog(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForAudit(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeForAudit(childValue, childKey),
      ]),
    );
  }

  return value;
}

function redactUrlForLog(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || "").split("?")[0];
  }
}

function bodyToString(body) {
  if (!body) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return JSON.stringify(body);
}

function isToday(value) {
  return Boolean(value) && String(value) === formatDate(new Date());
}

function randomJitter(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function audit(req, tool, args, result) {
  const event = {
    event: "mcp_tool_call",
    service: SERVICE_NAME,
    tool,
    clientKey: args.client_key || null,
    result: sanitizeForAudit(result),
    userAgent: req.get("user-agent") || null,
    ts: new Date().toISOString(),
  };
  console.log(JSON.stringify(event));
  emitMonitoringEvent(event);
}

function outboundMonitoringEvent(event, endpointKey, requestUrl, options, meta, extra) {
  return {
    event,
    provider: "google",
    endpointKey,
    contextKey: meta.contextKey || endpointKey,
    method: String(options.method || "GET").toUpperCase(),
    host: requestUrl.hostname,
    path: requestUrl.pathname,
    ...extra,
  };
}

function responseTrackingId(response) {
  return (
    response.headers.get("request-id") ||
    response.headers.get("x-request-id") ||
    response.headers.get("x-guploader-uploadid") ||
    response.headers.get("x-google-request-id") ||
    null
  );
}

function emitMonitoringEvent(event) {
  if (!MONITORING_WEBHOOK_URL) {
    return;
  }

  const payload = sanitizeForAudit({
    service: SERVICE_NAME,
    environment: MONITORING_ENVIRONMENT,
    ts: new Date().toISOString(),
    ...event,
  });

  queueMicrotask(() => {
    postMonitoringEventAttempt(payload).catch((error) => {
      console.warn(`Monitoring webhook failed: ${safeErrorMessage(error)}`);
    });
  });
}

async function postMonitoringEventAttempt(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MONITORING_TIMEOUT_MS);
  const headers = { "content-type": "application/json" };
  if (MONITORING_WEBHOOK_SECRET) {
    headers["x-summon-monitoring-secret"] = MONITORING_WEBHOOK_SECRET;
  }

  try {
    await fetch(MONITORING_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function hashForAudit(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function safeErrorMessage(error) {
  return String(error?.message || error || "unknown error")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .slice(0, 500);
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

function validateAuthorizationRequest(input, req) {
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

  if (!isAllowedAuthorizationClient(params.clientId, req)) {
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

function handleAuthorizationCodeGrant(req, res, credentials) {
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

  if (codeRecord.clientId !== credentials.clientId) {
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

function isAllowedAuthorizationClient(clientId, req) {
  return getAllowedPublicOAuthClientIds(req).includes(clientId);
}

function isKnownOAuthClient(clientId, clientSecret, req) {
  if (!clientId) {
    return false;
  }

  if (
    clientId === process.env.OAUTH_CLIENT_ID &&
    constantTimeTokenEquals(clientSecret, expectedOAuthClientSecretHash)
  ) {
    return true;
  }

  if (!getAllowedPublicOAuthClientIds(req).includes(clientId)) {
    return false;
  }

  return (
    !clientSecret ||
    constantTimeTokenEquals(clientSecret, expectedOAuthClientSecretHash)
  );
}

function getAllowedPublicOAuthClientIds(req) {
  return [...new Set([process.env.OAUTH_CLIENT_ID, getMcpPublicUrl(req)])].filter(
    Boolean,
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
