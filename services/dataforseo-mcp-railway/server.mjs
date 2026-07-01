import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PUBLIC_PORT = Number.parseInt(process.env.PORT || "3000", 10);
const INTERNAL_PORT = Number.parseInt(process.env.INTERNAL_MCP_PORT || "3010", 10);
const INTERNAL_TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;

const requiredEnv = [
  "DATAFORSEO_USERNAME",
  "DATAFORSEO_PASSWORD",
  "MCP_AUTH_TOKEN",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const expectedTokenHash = hashToken(process.env.MCP_AUTH_TOKEN);
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

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "dataforseo-mcp-railway" });
});

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  const authHeader = req.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!token || !constantTimeTokenEquals(token, expectedTokenHash)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }

  next();
});

app.use(
  createProxyMiddleware({
    target: INTERNAL_TARGET,
    changeOrigin: false,
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

const publicServer = app.listen(PUBLIC_PORT, () => {
  console.log(
    `Authenticated DataForSEO MCP proxy listening on port ${PUBLIC_PORT}`,
  );
  console.log(`Proxying authorized requests to ${INTERNAL_TARGET}`);
});

function hashToken(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeTokenEquals(token, expectedHash) {
  const actualHash = hashToken(token);
  return (
    actualHash.length === expectedHash.length &&
    timingSafeEqual(actualHash, expectedHash)
  );
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
