import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PUBLIC_PORT = Number.parseInt(process.env.PORT || "3000", 10);
const INTERNAL_PORT = Number.parseInt(process.env.INTERNAL_MCP_PORT || "3010", 10);
const INTERNAL_TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;

const requiredEnv = ["DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

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
const oauthPrimaryScope = process.env.OAUTH_SCOPE || "dataforseo:read";
const oauthSupportedScopes = new Set([oauthPrimaryScope, "offline_access"]);
const oauthAllowedRedirectUris = (
  process.env.OAUTH_REDIRECT_URIS || "https://claude.ai/api/mcp/auth_callback"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const oauthAutoApprove = process.env.OAUTH_AUTO_APPROVE === "true";
const authorizationCodes = new Map();

let shuttingDown = false;

const childEnv = {
  ...process.env,
  PORT: String(INTERNAL_PORT),
  ENABLED_MODULES:
    process.env.ENABLED_MODULES ||
    "SERP,KEYWORDS_DATA,ONPAGE,DATAFORSEO_LABS,BACKLINKS,DOMAIN_ANALYTICS,BUSINESS_DATA,CONTENT_ANALYSIS,AI_OPTIMIZATION",
};

if (process.env.FIELD_CONFIG_PATH) {
  childEnv.FIELD_CONFIG_PATH = process.env.FIELD_CONFIG_PATH;
}

const dataforseoServer = spawn(
  process.execPath,
  [join(__dirname, "node_modules/dataforseo-mcp-server/build/main/main/index-http.js")],
  {
    cwd: __dirname,
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
  },
);

dataforseoServer.on("exit", (code, signal) => {
  if (shuttingDown) {
    process.exit(0);
  }

  console.error(
    `DataForSEO MCP child exited unexpectedly: code=${code} signal=${signal}`,
  );
  process.exit(code || 1);
});

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
    service: "dataforseo-mcp-railway",
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
        "https://github.com/serhiiSotskyi/claude-seo/blob/main/docs/CLAUDE-TEAM-DATAFORSEO.md",
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

app.post(
  "/authorize",
  express.urlencoded({ extended: false }),
  (req, res) => {
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
  },
);

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

app.use("/mcp", requireMcpAuth);

app.use(
  "/mcp",
  createProxyMiddleware({
    target: INTERNAL_TARGET,
    changeOrigin: false,
    pathRewrite: (_path, req) => req.originalUrl,
    proxyTimeout: 600_000,
    timeout: 600_000,
    on: {
      proxyReq(proxyReq) {
        proxyReq.removeHeader("authorization");
      },
      error(err, _req, res) {
        console.error("Proxy error:", err);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "MCP upstream unavailable" },
            id: null,
          }),
        );
      },
    },
  }),
);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

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

const publicServer = app.listen(PUBLIC_PORT, () => {
  console.log(
    `DataForSEO MCP proxy listening on port ${PUBLIC_PORT}`,
  );
  console.log(
    `Authentication enabled: staticBearer=${staticBearerEnabled} oauth=${oauthEnabled}`,
  );
  console.log(`Proxying authorized requests to ${INTERNAL_TARGET}`);
});

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
  <title>Connect DataForSEO to Claude</title>
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
      max-width: 520px;
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
    <h1>Connect DataForSEO to Claude</h1>
    <p>This lets Claude use your company's Railway-hosted DataForSEO MCP service. DataForSEO credentials stay on Railway and are not shared with Claude users.</p>
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
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  publicServer.close(() => {
    dataforseoServer.kill(signal);
  });

  setTimeout(() => {
    dataforseoServer.kill("SIGKILL");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
