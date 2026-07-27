import AdmZip from "adm-zip";
import express from "express";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const PUBLIC_PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MICROSOFT_ADS_ENVIRONMENT =
  process.env.MICROSOFT_ADS_ENVIRONMENT || "production";
const MICROSOFT_ADS_TENANT = process.env.MICROSOFT_ADS_TENANT || "common";
const MICROSOFT_TOKEN_URL = `https://login.microsoftonline.com/${encodeURIComponent(
  MICROSOFT_ADS_TENANT,
)}/oauth2/v2.0/token`;
const MICROSOFT_ADS_SCOPE =
  process.env.MICROSOFT_ADS_SCOPE ||
  "https://ads.microsoft.com/msads.manage offline_access";
const MICROSOFT_REPORTING_BASE_URL =
  MICROSOFT_ADS_ENVIRONMENT === "sandbox"
    ? "https://reporting.api.sandbox.bingads.microsoft.com/Reporting/v13"
    : "https://reporting.api.bingads.microsoft.com/Reporting/v13";
const MICROSOFT_REPORT_TIME_ZONE =
  process.env.MICROSOFT_ADS_REPORT_TIME_ZONE ||
  "GreenwichMeanTimeDublinEdinburghLisbonLondon";
const REPORT_POLL_INTERVAL_MS = Number.parseInt(
  process.env.REPORT_POLL_INTERVAL_MS || "3000",
  10,
);
const REPORT_POLL_MAX_ATTEMPTS = Number.parseInt(
  process.env.REPORT_POLL_MAX_ATTEMPTS || "30",
  10,
);

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
  process.env.OAUTH_SCOPE || "summon-microsoft-ads:read";
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
let microsoftTokenCache = null;

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
  reportSubmitLimit: parsePositiveInt(
    process.env.SAFETY_REPORT_SUBMIT_LIMIT,
    10,
  ),
  reportSubmitWindowMs: parsePositiveInt(
    process.env.SAFETY_REPORT_SUBMIT_WINDOW_MS,
    3_600_000,
  ),
  cacheTtlMs: parsePositiveInt(process.env.SAFETY_CACHE_TTL_MS, 21_600_000),
  todayCacheTtlMs: parsePositiveInt(
    process.env.SAFETY_TODAY_CACHE_TTL_MS,
    900_000,
  ),
  reportDownloadTtlMs: parsePositiveInt(
    process.env.SAFETY_REPORT_DOWNLOAD_TTL_MS,
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

// readonly-safety-allow-risk-terms:start
const READONLY_DENYLIST = [
  "CampaignManagement",
  "CustomerManagement",
  "BulkService",
  "billing",
  "payment",
  "accountLink",
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
    service: "summon-microsoft-ads-mcp",
    environment: MICROSOFT_ADS_ENVIRONMENT,
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
        "https://github.com/serhiiSotskyi/claude-seo/blob/main/extensions/microsoft-ads/docs/MICROSOFT-ADS-SETUP.md",
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
  console.log(`Summon Microsoft Ads MCP listening on port ${PUBLIC_PORT}`);
  console.log(
    `Authentication enabled: staticBearer=${staticBearerEnabled} oauth=${oauthEnabled}`,
  );
});

const tools = [
  {
    name: "list_clients",
    description:
      "List configured client keys and allowlisted Microsoft Advertising accounts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "microsoft_ads_campaign_performance",
    description:
      "Read Microsoft Advertising campaign performance using a fixed reporting template.",
    inputSchema: clientDateSchema({
      account_id: {
        type: "string",
        description: "Allowed Microsoft Advertising account ID.",
      },
      aggregation: aggregationSchema(),
      limit: numberSchema(1, 10000, 1000),
    }),
  },
  {
    name: "microsoft_ads_search_queries",
    description:
      "Read Microsoft Advertising search query performance for PPC-to-SEO analysis.",
    inputSchema: clientDateSchema({
      account_id: {
        type: "string",
        description: "Allowed Microsoft Advertising account ID.",
      },
      min_clicks: numberSchema(0, 100000, 1),
      aggregation: aggregationSchema(),
      limit: numberSchema(1, 10000, 1000),
    }),
  },
  {
    name: "microsoft_ads_keyword_performance",
    description:
      "Read Microsoft Advertising keyword performance using a fixed reporting template.",
    inputSchema: clientDateSchema({
      account_id: {
        type: "string",
        description: "Allowed Microsoft Advertising account ID.",
      },
      min_clicks: numberSchema(0, 100000, 1),
      aggregation: aggregationSchema(),
      limit: numberSchema(1, 10000, 1000),
    }),
  },
  {
    name: "microsoft_ads_landing_pages",
    description:
      "Read Microsoft Advertising search term and landing page performance.",
    inputSchema: clientDateSchema({
      account_id: {
        type: "string",
        description: "Allowed Microsoft Advertising account ID.",
      },
      min_clicks: numberSchema(0, 100000, 1),
      aggregation: aggregationSchema(),
      limit: numberSchema(1, 10000, 1000),
    }),
  },
  {
    name: "microsoft_ads_ppc_to_seo_opportunities",
    description:
      "Group Microsoft Ads search-term/landing-page data into SEO opportunity candidates.",
    inputSchema: clientDateSchema({
      account_id: {
        type: "string",
        description: "Allowed Microsoft Advertising account ID.",
      },
      min_clicks: numberSchema(0, 100000, 5),
      min_conversions: numberSchema(0, 100000, 1),
      aggregation: aggregationSchema(),
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
          name: "summon-microsoft-ads-mcp",
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
    case "microsoft_ads_campaign_performance":
      return microsoftAdsCampaignPerformance(args, req);
    case "microsoft_ads_search_queries":
      return microsoftAdsSearchQueries(args, req);
    case "microsoft_ads_keyword_performance":
      return microsoftAdsKeywordPerformance(args, req);
    case "microsoft_ads_landing_pages":
      return microsoftAdsLandingPages(args, req);
    case "microsoft_ads_ppc_to_seo_opportunities":
      return microsoftAdsPpcToSeoOpportunities(args, req);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function listClients() {
  return {
    clients: Object.entries(clients).map(([key, client]) => ({
      key,
      label: client.label || key,
      microsoftAdsAccounts: client.microsoftAdsAccounts.map((account) => ({
        label: account.label,
        accountId: maskId(account.accountId),
        customerId: maskId(account.customerId),
      })),
      brandTerms: client.brandTerms || [],
    })),
  };
}

async function microsoftAdsCampaignPerformance(args, req) {
  const context = getMicrosoftAdsContext(args);
  const report = await runTemplateReport({
    context,
    args,
    reportType: "CampaignPerformanceReportRequest",
    reportName: "summon-campaign-performance",
    columns: [
      "TimePeriod",
      "AccountName",
      "AccountId",
      "CampaignName",
      "CampaignId",
      "CampaignStatus",
      "CampaignType",
      "CurrencyCode",
      "Impressions",
      "Clicks",
      "Ctr",
      "AverageCpc",
      "Spend",
      "Conversions",
      "ConversionRate",
      "CostPerConversion",
      "Revenue",
      "ReturnOnAdSpend",
    ],
  });

  audit(req, "microsoft_ads_campaign_performance", args, {
    rows: report.rows.length,
    accountId: context.account.accountId,
  });

  return report;
}

async function microsoftAdsSearchQueries(args, req) {
  const context = getMicrosoftAdsContext(args);
  const minClicks = clampNumber(args.min_clicks, 0, 100000, 1);
  const report = await runTemplateReport({
    context,
    args,
    reportType: "SearchQueryPerformanceReportRequest",
    reportName: "summon-search-query-performance",
    columns: [
      "TimePeriod",
      "AccountName",
      "AccountId",
      "CampaignName",
      "CampaignId",
      "AdGroupName",
      "AdGroupId",
      "SearchQuery",
      "Keyword",
      "BidMatchType",
      "DeliveredMatchType",
      "DeviceType",
      "Network",
      "Impressions",
      "Clicks",
      "Ctr",
      "AverageCpc",
      "Spend",
      "Conversions",
      "ConversionRate",
      "CostPerConversion",
      "Revenue",
      "ReturnOnAdSpend",
    ],
  });

  report.rows = filterRows(report.rows, { minClicks });

  audit(req, "microsoft_ads_search_queries", args, {
    rows: report.rows.length,
    accountId: context.account.accountId,
  });

  return { ...report, minClicks };
}

async function microsoftAdsKeywordPerformance(args, req) {
  const context = getMicrosoftAdsContext(args);
  const minClicks = clampNumber(args.min_clicks, 0, 100000, 1);
  const report = await runTemplateReport({
    context,
    args,
    reportType: "KeywordPerformanceReportRequest",
    reportName: "summon-keyword-performance",
    columns: [
      "TimePeriod",
      "AccountName",
      "AccountId",
      "CampaignName",
      "CampaignId",
      "AdGroupName",
      "AdGroupId",
      "Keyword",
      "BidMatchType",
      "DeliveredMatchType",
      "QualityScore",
      "Impressions",
      "Clicks",
      "Ctr",
      "AverageCpc",
      "Spend",
      "Conversions",
      "ConversionRate",
      "CostPerConversion",
      "Revenue",
      "ReturnOnAdSpend",
    ],
    extra: {
      MaxRows: clampNumber(args.limit, 1, 10000, 1000),
      Sort: [{ SortColumn: "Clicks", SortOrder: "Descending" }],
    },
  });

  report.rows = filterRows(report.rows, { minClicks });

  audit(req, "microsoft_ads_keyword_performance", args, {
    rows: report.rows.length,
    accountId: context.account.accountId,
  });

  return { ...report, minClicks };
}

async function microsoftAdsLandingPages(args, req) {
  const context = getMicrosoftAdsContext(args);
  const minClicks = clampNumber(args.min_clicks, 0, 100000, 1);
  const report = await runTemplateReport({
    context,
    args,
    reportType: "SearchTermLandingPageReportRequest",
    reportName: "summon-search-term-landing-page",
    columns: [
      "TimePeriod",
      "AccountName",
      "AccountId",
      "CampaignName",
      "CampaignId",
      "AdGroupName",
      "AdGroupId",
      "CampaignType",
      "SearchQuery",
      "Keyword",
      "BidMatchType",
      "DeliveredMatchType",
      "FinalUrl",
      "FinalUrlSource",
      "Impressions",
      "Clicks",
      "Ctr",
      "AverageCpc",
      "Spend",
      "Conversions",
      "ConversionRate",
      "CostPerConversion",
      "Revenue",
      "ReturnOnAdSpend",
    ],
  });

  report.rows = filterRows(report.rows, { minClicks });

  audit(req, "microsoft_ads_landing_pages", args, {
    rows: report.rows.length,
    accountId: context.account.accountId,
  });

  return { ...report, minClicks };
}

async function microsoftAdsPpcToSeoOpportunities(args, req) {
  const context = getMicrosoftAdsContext(args);
  const minClicks = clampNumber(args.min_clicks, 0, 100000, 5);
  const minConversions = clampNumber(args.min_conversions, 0, 100000, 1);
  const limit = clampNumber(args.limit, 1, 5000, 500);
  const report = await runTemplateReport({
    context,
    args: { ...args, limit },
    reportType: "SearchTermLandingPageReportRequest",
    reportName: "summon-msads-ppc-to-seo",
    columns: [
      "SearchQuery",
      "Keyword",
      "CampaignName",
      "CampaignType",
      "FinalUrl",
      "Impressions",
      "Clicks",
      "Spend",
      "Conversions",
      "ConversionRate",
      "Revenue",
      "ReturnOnAdSpend",
    ],
  });

  const opportunities = summarisePpcToSeo(report.rows, {
    minClicks,
    minConversions,
    brandTerms: context.client.brandTerms || [],
  });

  audit(req, "microsoft_ads_ppc_to_seo_opportunities", args, {
    rows: report.rows.length,
    opportunities: opportunities.length,
    accountId: context.account.accountId,
  });

  return {
    source: "Microsoft Advertising Reporting API",
    client: context.clientKey,
    accountId: context.account.accountId,
    customerId: context.account.customerId,
    dateRange: report.dateRange,
    method:
      "Search term landing page report grouped into SEO opportunity candidates. Validate with GSC, GA4, DataForSEO, and page crawl before implementation.",
    minClicks,
    minConversions,
    opportunities,
  };
}

async function runTemplateReport({ context, args, reportType, reportName, columns, extra }) {
  const dateRange = normaliseDateRange(args, 366);
  const aggregation = normaliseAggregation(args.aggregation);
  const limit = clampNumber(args.limit, 1, 10000, 1000);
  const reportRequest = createReportRequest({
    reportType,
    reportName,
    accountId: context.account.accountId,
    dateRange,
    aggregation,
    columns,
    extra,
  });
  const cacheKey = stableCacheKey(
    "microsoft:report",
    context.account.accountId,
    reportRequest,
  );
  const rows = await withCachedJson(cacheKey, cacheTtlForDateRange(dateRange), () =>
    runMicrosoftReport(context.account, reportRequest),
  );

  return {
    source: "Microsoft Advertising Reporting API",
    client: context.clientKey,
    accountId: context.account.accountId,
    customerId: context.account.customerId,
    reportType,
    aggregation,
    dateRange,
    rows: rows.slice(0, limit),
    rowCountBeforeLimit: rows.length,
  };
}

function createReportRequest({
  reportType,
  reportName,
  accountId,
  dateRange,
  aggregation,
  columns,
  extra,
}) {
  const reportColumns =
    aggregation === "Summary"
      ? columns.filter((column) => column !== "TimePeriod")
      : columns;

  return {
    ExcludeColumnHeaders: false,
    ExcludeReportFooter: true,
    ExcludeReportHeader: true,
    Format: "Csv",
    FormatVersion: "2.0",
    ReportName: reportName,
    ReturnOnlyCompleteData: false,
    Type: reportType,
    Aggregation: aggregation,
    Columns: reportColumns,
    Scope: {
      AccountIds: [asLongNumber(accountId, "accountId")],
    },
    Time: {
      CustomDateRangeStart: dateObject(dateRange.startDate),
      CustomDateRangeEnd: dateObject(dateRange.endDate),
      ReportTimeZone: MICROSOFT_REPORT_TIME_ZONE,
    },
    ...(extra || {}),
  };
}

async function runMicrosoftReport(account, reportRequest) {
  await enforceRateLimit(
    `microsoft:report-submit:${account.accountId}`,
    READONLY_SAFETY.reportSubmitLimit,
    READONLY_SAFETY.reportSubmitWindowMs,
  );
  const submitResponse = await callMicrosoftReporting(
    account,
    "/GenerateReport/Submit",
    {
      ReportRequest: reportRequest,
    },
  );
  const reportRequestId = submitResponse.ReportRequestId;
  if (!reportRequestId) {
    throw new Error("Microsoft Ads did not return a ReportRequestId.");
  }

  let lastStatus = null;
  for (let attempt = 0; attempt < REPORT_POLL_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(REPORT_POLL_INTERVAL_MS);
    }

    const pollResponse = await callMicrosoftReporting(
      account,
      "/GenerateReport/Poll",
      {
        ReportRequestId: reportRequestId,
      },
    );
    lastStatus = pollResponse.ReportRequestStatus || null;
    const status = lastStatus?.Status;

    if (status === "Success") {
      if (!lastStatus.ReportDownloadUrl) {
        return [];
      }
      allowReportDownloadUrl(lastStatus.ReportDownloadUrl);
      const csv = await downloadReportCsv(lastStatus.ReportDownloadUrl, account);
      return parseCsvObjects(csv);
    }

    if (status === "Error") {
      throw new Error("Microsoft Ads report generation failed.");
    }
  }

  throw new Error(
    `Microsoft Ads report was not ready after ${REPORT_POLL_MAX_ATTEMPTS} polls. Last status: ${
      lastStatus?.Status || "unknown"
    }`,
  );
}

async function callMicrosoftReporting(account, path, body) {
  const accessToken = await getMicrosoftAccessToken();
  const endpointKey =
    path === "/GenerateReport/Submit"
      ? "microsoft_report_submit"
      : "microsoft_report_poll";
  const contextKey = `microsoft:ads:${account.accountId}`;
  const response = await safeFetch(
    endpointKey,
    `${MICROSOFT_REPORTING_BASE_URL}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        developerToken: requireEnv("MICROSOFT_ADS_DEVELOPER_TOKEN"),
        customerId: account.customerId,
        customerAccountId: account.accountId,
      },
      body: JSON.stringify(body),
    },
    { contextKey },
  );

  return parseMicrosoftResponse(response, { circuitKey: contextKey });
}

async function getMicrosoftAccessToken() {
  const required = [
    "MICROSOFT_ADS_CLIENT_ID",
    "MICROSOFT_ADS_CLIENT_SECRET",
    "MICROSOFT_ADS_REFRESH_TOKEN",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing Microsoft Ads OAuth variables: ${missing.join(", ")}`);
  }

  if (microsoftTokenCache && microsoftTokenCache.expiresAt > Date.now() + 60_000) {
    return microsoftTokenCache.accessToken;
  }

  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_ADS_CLIENT_ID,
    client_secret: process.env.MICROSOFT_ADS_CLIENT_SECRET,
    refresh_token: process.env.MICROSOFT_ADS_REFRESH_TOKEN,
    grant_type: "refresh_token",
    scope: MICROSOFT_ADS_SCOPE,
  });

  const response = await safeFetch(
    "microsoft_oauth_token",
    MICROSOFT_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    },
    { contextKey: "microsoft:auth" },
  );
  const data = await parseMicrosoftResponse(response, {
    circuitKey: "microsoft:auth",
    providerAuth: true,
  });
  microsoftTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return microsoftTokenCache.accessToken;
}

async function parseMicrosoftResponse(response, meta = {}) {
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
      data?.Message ||
      data?.raw ||
      `${response.status} ${response.statusText}`;
    handleVendorStopState(response.status, message, data, meta);
    throw new Error(message);
  }

  return data || {};
}

async function downloadReportCsv(url, account) {
  const contextKey = `microsoft:ads:${account.accountId}`;
  const response = await safeFetch(
    "microsoft_report_download",
    url,
    { method: "GET" },
    { contextKey },
  );
  if (!response.ok) {
    handleVendorStopState(
      response.status,
      `${response.status} ${response.statusText}`,
      null,
      { circuitKey: contextKey },
    );
    throw new Error(
      `Could not download Microsoft Ads report: ${response.status} ${response.statusText}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = new AdmZip(buffer);
  const entry = zip
    .getEntries()
    .find((candidate) => !candidate.isDirectory && /\.csv$/i.test(candidate.entryName));

  if (!entry) {
    throw new Error("Microsoft Ads report ZIP did not contain a CSV file.");
  }

  return entry.getData().toString("utf8");
}

async function safeFetch(endpointKey, url, options = {}, meta = {}) {
  const requestUrl = new URL(url);
  const contextKey = meta.contextKey || endpointKey;
  assertCircuitClosed(contextKey);
  assertAllowedOutboundRequest(endpointKey, requestUrl, options);

  return withConcurrency(contextKey, async () => {
    await enforceRateLimit(
      "microsoft:global",
      READONLY_SAFETY.globalRateLimit,
      READONLY_SAFETY.rateWindowMs,
    );
    await enforceRateLimit(
      `microsoft:${contextKey}`,
      READONLY_SAFETY.perContextRateLimit,
      READONLY_SAFETY.rateWindowMs,
    );
    return fetchWithRetry(endpointKey, requestUrl, options, { contextKey });
  });
}

async function fetchWithRetry(endpointKey, requestUrl, options, meta) {
  let lastError = null;
  for (let attempt = 0; attempt < READONLY_SAFETY.maxAttempts; attempt += 1) {
    try {
      const response = await executeSafeFetchAttempt(requestUrl, options);
      if (!isRetryableStatus(response.status)) {
        return response;
      }

      if (attempt >= READONLY_SAFETY.maxAttempts - 1) {
        return response;
      }

      await drainResponse(response);
      await sleep(retryDelayMs(response, attempt));
    } catch (error) {
      lastError = error;
      if (attempt >= READONLY_SAFETY.maxAttempts - 1) {
        break;
      }
      await sleep(retryDelayMs(null, attempt));
    }
  }

  throw new Error(
    `Microsoft Ads request failed after retries: ${endpointKey} ${
      lastError?.message || "unknown error"
    }`,
  );
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
  const path = requestUrl.pathname;
  const host = requestUrl.hostname;

  assertNoDangerousOutboundIntent(endpointKey, requestUrl, options);

  const allowed =
    (endpointKey === "microsoft_oauth_token" &&
      method === "POST" &&
      requestUrl.toString() === MICROSOFT_TOKEN_URL) ||
    (endpointKey === "microsoft_report_submit" &&
      method === "POST" &&
      isMicrosoftReportingHost(host) &&
      path === "/Reporting/v13/GenerateReport/Submit") ||
    (endpointKey === "microsoft_report_poll" &&
      method === "POST" &&
      isMicrosoftReportingHost(host) &&
      path === "/Reporting/v13/GenerateReport/Poll") ||
    (endpointKey === "microsoft_report_download" &&
      method === "GET" &&
      isAllowedReportDownloadUrl(requestUrl.toString()));

  if (!allowed) {
    throw new Error(
      `Blocked non-reporting Microsoft Ads endpoint: ${endpointKey} ${redactUrlForLog(
        requestUrl,
      )}`,
    );
  }
}

function isMicrosoftReportingHost(host) {
  return [
    "reporting.api.bingads.microsoft.com",
    "reporting.api.sandbox.bingads.microsoft.com",
  ].includes(host);
}

function assertNoDangerousOutboundIntent(endpointKey, requestUrl, options) {
  const body =
    endpointKey.includes("oauth") || endpointKey === "microsoft_report_download"
      ? ""
      : bodyToString(options.body);
  const subject = `${requestUrl.toString()} ${body}`.toLowerCase();
  const blocked = READONLY_DENYLIST.find((term) =>
    subject.includes(term.toLowerCase()),
  );
  if (blocked) {
    throw new Error(`Blocked unsafe Microsoft Ads API intent: ${blocked}`);
  }
}

function allowReportDownloadUrl(url) {
  safetyState.allowedReportDownloads.set(new URL(String(url)).toString(), {
    expiresAt: Date.now() + READONLY_SAFETY.reportDownloadTtlMs,
  });
}

function isAllowedReportDownloadUrl(url) {
  pruneExpiredMaps();
  return safetyState.allowedReportDownloads.has(new URL(String(url)).toString());
}

async function withCachedJson(cacheKey, ttlMs, load) {
  pruneExpiredMaps();
  const cached = safetyState.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cloneJson(cached.value);
  }

  const inFlight = safetyState.inFlight.get(cacheKey);
  if (inFlight) {
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
      ? "microsoft:auth"
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
    return {
      providerAuth: true,
      reason: "Microsoft Ads OAuth access is invalid or revoked.",
    };
  }

  if (
    status === 403 ||
    text.includes("permission") ||
    text.includes("access_denied") ||
    text.includes("authorization") ||
    text.includes("suspended") ||
    text.includes("restricted") ||
    text.includes("disabled") ||
    text.includes("not enabled") ||
    text.includes("billing") ||
    text.includes("payment")
  ) {
    return {
      providerAuth: false,
      reason:
        "Microsoft Ads account access is denied, restricted, suspended, or billing-blocked.",
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
      `Microsoft Ads connector circuit open for ${key} until ${new Date(
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

function cacheTtlForDateRange(dateRange) {
  return isToday(dateRange?.endDate)
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
  for (const [key, entry] of safetyState.allowedReportDownloads.entries()) {
    if (entry.expiresAt <= now) {
      safetyState.allowedReportDownloads.delete(key);
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
    allowedReportDownloads: new Map(),
  };
}

function parseCsvObjects(csv) {
  const rows = parseCsv(csv).filter((row) =>
    row.some((cell) => String(cell).trim() !== ""),
  );
  if (!rows.length) {
    return [];
  }

  const headers = rows[0].map((header) => String(header).trim());
  return rows.slice(1).map((row) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = parseCellValue(row[index] ?? "");
    });
    return object;
  });
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function parseCellValue(value) {
  const text = String(value || "").trim();
  if (!text || text === "--") {
    return "";
  }

  const percent = text.endsWith("%");
  const numeric = Number(text.replace(/[%,$£€,\s]/g, ""));
  if (Number.isFinite(numeric) && /^-?[\d,.$£€\s]+%?$/.test(text)) {
    return percent ? numeric / 100 : numeric;
  }

  return text;
}

function summarisePpcToSeo(rows, options) {
  const grouped = new Map();
  for (const row of rows) {
    const query = String(row.SearchQuery || "").trim();
    if (!query) {
      continue;
    }

    const key = normaliseSearchTermCluster(query);
    const current = grouped.get(key) || {
      cluster: key,
      exampleQueries: [],
      exampleLandingPages: [],
      campaigns: [],
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      revenue: 0,
      containsBrand: containsAny(query, options.brandTerms),
    };

    if (current.exampleQueries.length < 5 && !current.exampleQueries.includes(query)) {
      current.exampleQueries.push(query);
    }
    if (
      row.FinalUrl &&
      current.exampleLandingPages.length < 5 &&
      !current.exampleLandingPages.includes(row.FinalUrl)
    ) {
      current.exampleLandingPages.push(row.FinalUrl);
    }
    if (
      row.CampaignName &&
      current.campaigns.length < 5 &&
      !current.campaigns.includes(row.CampaignName)
    ) {
      current.campaigns.push(row.CampaignName);
    }

    current.impressions += Number(row.Impressions || 0);
    current.clicks += Number(row.Clicks || 0);
    current.spend += Number(row.Spend || 0);
    current.conversions += Number(row.Conversions || 0);
    current.revenue += Number(row.Revenue || 0);
    current.containsBrand ||= containsAny(query, options.brandTerms);
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .filter(
      (item) =>
        item.clicks >= options.minClicks &&
        item.conversions >= options.minConversions,
    )
    .sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks)
    .map((item) => ({
      ...item,
      recommendation: item.containsBrand
        ? "Usually protect with brand SEO and sitelinks; only create new content if there is a clear non-brand intent variant."
        : "Validate with GSC, GA4, DataForSEO, and page crawl. If organic coverage is weak, consider an SEO landing page or content cluster.",
      nextEvidence:
        "Check Google Search Console query/page coverage, GA4 landing page conversions, DataForSEO volume/difficulty, and current page indexability.",
    }));
}

function filterRows(rows, options) {
  return rows.filter((row) => Number(row.Clicks || 0) >= options.minClicks);
}

function getMicrosoftAdsContext(args) {
  const { clientKey, client } = requireClient(args.client_key);
  const requestedAccountId = args.account_id
    ? stripId(args.account_id)
    : client.microsoftAdsAccounts[0]?.accountId;
  if (!requestedAccountId) {
    throw new Error(`No Microsoft Ads account is configured for client: ${clientKey}`);
  }

  const account = client.microsoftAdsAccounts.find(
    (candidate) => candidate.accountId === requestedAccountId,
  );
  if (!account) {
    throw new Error(
      `Microsoft Ads account ID is not allowlisted for client: ${clientKey}`,
    );
  }

  return {
    clientKey,
    client,
    account,
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
          microsoftAdsAccounts: asMicrosoftAdsAccounts(value),
          brandTerms: asStringArray(value.brandTerms),
        },
      ]),
    );
  } catch (error) {
    console.error(`Invalid CLIENT_ALLOWLIST_JSON: ${error.message}`);
    process.exit(1);
  }
}

function asMicrosoftAdsAccounts(value) {
  if (Array.isArray(value.microsoftAdsAccounts)) {
    return value.microsoftAdsAccounts.map(normaliseMicrosoftAdsAccount);
  }

  const accountIds = asStringArray(value.microsoftAdsAccountIds);
  const customerIds = asStringArray(value.microsoftAdsCustomerIds);
  return accountIds.map((accountId, index) =>
    normaliseMicrosoftAdsAccount({
      accountId,
      customerId: customerIds[index] || value.microsoftAdsCustomerId,
      label: value.label,
    }),
  );
}

function normaliseMicrosoftAdsAccount(account) {
  const accountId = stripId(account.accountId);
  const customerId = stripId(account.customerId);
  if (!accountId || !customerId) {
    throw new Error(
      "Each Microsoft Ads allowlist entry requires accountId and customerId.",
    );
  }

  return {
    label: account.label || accountId,
    accountId,
    customerId,
  };
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

function aggregationSchema() {
  return {
    type: "string",
    enum: ["Daily", "Weekly", "Monthly", "Summary"],
    default: "Daily",
  };
}

function normaliseAggregation(value) {
  return ["Daily", "Weekly", "Monthly", "Summary"].includes(value)
    ? value
    : "Daily";
}

function dateObject(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return { Day: day, Month: month, Year: year };
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

function containsAny(value, terms) {
  const normalised = String(value || "").toLowerCase();
  return (terms || []).some((term) =>
    normalised.includes(String(term).toLowerCase()),
  );
}

function stripId(value) {
  return String(value || "").replaceAll("-", "").trim();
}

function maskId(value) {
  const text = String(value || "");
  if (text.length <= 6) {
    return text;
  }
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
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
    loweredKey.endsWith("accountid") ||
    loweredKey.endsWith("customerid")
  ) {
    return maskId(value);
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

function asLongNumber(value, label) {
  const numeric = Number(stripId(value));
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return numeric;
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

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audit(req, tool, args, result) {
  console.log(
    JSON.stringify({
      event: "mcp_tool_call",
      service: "summon-microsoft-ads-mcp",
      tool,
      clientKey: args.client_key || null,
      result: sanitizeForAudit(result),
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
  <title>Connect Summon Microsoft Ads to Claude</title>
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
    <h1>Connect Summon Microsoft Ads to Claude</h1>
    <p>This lets Claude use Summon's read-only Microsoft Advertising reporting connector for SEO, GEO, and PPC-to-SEO workflows.</p>
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
