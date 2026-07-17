import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 43999;
const baseUrl = `http://127.0.0.1:${port}`;
const bearer = "summon-google-performance-test-token";
const oauthClientId = "summon-claude-test";
const oauthClientSecret = "summon-claude-test-secret";
let server;

before(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MCP_AUTH_TOKEN: bearer,
      PUBLIC_BASE_URL: baseUrl,
      MCP_PUBLIC_URL: `${baseUrl}/mcp`,
      OAUTH_CLIENT_ID: oauthClientId,
      OAUTH_CLIENT_SECRET: oauthClientSecret,
      OAUTH_SIGNING_SECRET: "summon-test-signing-secret-with-32-bytes",
      CLIENT_ALLOWLIST_JSON: JSON.stringify({
        summon: {
          label: "Summon",
          ga4Properties: ["123456789"],
          gscSites: ["sc-domain:summon.co"],
          googleAdsCustomerIds: ["1234567890"],
          brandTerms: ["summon"],
        },
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The process may still be starting.
    }
    await delay(100);
  }

  throw new Error("MCP test server did not become healthy.");
});

after(() => {
  server?.kill("SIGTERM");
});

test("health reports a single-client read-only service", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.clients, 1);
  assert.equal(body.deploymentMode, "single-client");
});

test("MCP endpoint rejects unauthenticated requests", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") || "", /^Bearer/);
});

test("OAuth discovery and PKCE code flow issue a usable read-only token", async () => {
  const discovery = await fetch(
    `${baseUrl}/.well-known/oauth-authorization-server`,
  );
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json();
  assert.equal(metadata.authorization_endpoint, `${baseUrl}/authorize`);
  assert.equal(metadata.token_endpoint, `${baseUrl}/token`);
  assert.ok(metadata.code_challenge_methods_supported.includes("S256"));

  const verifier = "summon-google-performance-pkce-verifier-123456789";
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const authorize = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: oauthClientId,
      redirect_uri: redirectUri,
      scope: "summon-google-performance:read offline_access",
      state: "test-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  });
  assert.equal(authorize.status, 302);
  const callback = new URL(authorize.headers.get("location"));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get("state"), "test-state");

  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: oauthClientId,
      client_secret: oauthClientSecret,
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokenSet = await tokenResponse.json();
  assert.equal(tokenSet.token_type, "Bearer");
  assert.ok(tokenSet.access_token);
  assert.ok(tokenSet.refresh_token);

  const mcpResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenSet.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcpResponse.status, 200);
});

test("tools/list exposes reporting tools and no mutation surface", async () => {
  const body = await mcpRequest("tools/list");
  const names = body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("ga4_landing_pages"));
  assert.ok(names.includes("gsc_search_analytics"));
  assert.ok(names.includes("google_ads_search_terms"));
  assert.ok(names.includes("ppc_to_seo_opportunities"));
  assert.equal(names.some((name) => /mutate|update|create|delete/i.test(name)), false);
});

test("list_clients masks account and property identifiers", async () => {
  const body = await mcpRequest("tools/call", {
    name: "list_clients",
    arguments: {},
  });
  const result = JSON.parse(body.result.content[0].text);
  assert.equal(result.clients[0].key, "summon");
  assert.deepEqual(result.clients[0].ga4Properties, ["123...789"]);
  assert.deepEqual(result.clients[0].googleAdsCustomerIds, ["123...890"]);
});

async function mcpRequest(method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
