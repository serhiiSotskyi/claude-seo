import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serviceFiles = [
  "services/summon-google-performance-mcp/server.mjs",
  "services/summon-microsoft-ads-mcp/server.mjs",
];

const allowedRawFetchFunctions = new Set(["executeSafeFetchAttempt"]);
const allowedApiHosts = new Set([
  "oauth2.googleapis.com",
  "analyticsdata.googleapis.com",
  "searchconsole.googleapis.com",
  "googleads.googleapis.com",
  "ads.microsoft.com",
  "login.microsoftonline.com",
  "reporting.api.bingads.microsoft.com",
  "reporting.api.sandbox.bingads.microsoft.com",
]);

const allowedRiskFunctions = new Set([
  "assertNoDangerousOutboundIntent",
  "classifyVendorStopState",
  "handleVendorStopState",
]);

const riskyTerms = [
  ":mutate",
  "googleAds:mutate",
  "billing",
  "payment",
  "CustomerManagement",
  "CampaignManagement",
  "BulkService",
  "CustomerUserAccess",
  "CustomerManagerLink",
  "AccountBudget",
  "CampaignBudget",
  "CampaignCriterion",
  "operations",
];

const failures = [];
runSelfTests();

for (const relativePath of serviceFiles) {
  const absolutePath = resolve(repoRoot, relativePath);
  const content = readFileSync(absolutePath, "utf8");
  failures.push(...checkDirectFetch(content, relativePath));
  failures.push(...checkApiHosts(content, relativePath));
  failures.push(...checkRiskyTerms(content, relativePath));
}

if (failures.length) {
  console.error("Read-only connector safety check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Read-only connector safety check passed.");

function checkDirectFetch(content, relativePath) {
  const localFailures = [];
  for (const match of content.matchAll(/\bfetch\s*\(/g)) {
    const functionName = enclosingFunctionName(content, match.index);
    if (!allowedRawFetchFunctions.has(functionName)) {
      localFailures.push(
        `${relativePath}: raw fetch is only allowed inside executeSafeFetchAttempt; found inside ${functionName || "top-level"}.`,
      );
    }
  }
  return localFailures;
}

function checkApiHosts(content, relativePath) {
  const localFailures = [];
  for (const match of content.matchAll(/https:\/\/[A-Za-z0-9._:-]+/g)) {
    const host = new URL(match[0]).hostname;
    const looksLikeAdsApi =
      host.includes("google") ||
      host.includes("microsoft") ||
      host.includes("bingads");
    if (looksLikeAdsApi && !allowedApiHosts.has(host)) {
      localFailures.push(`${relativePath}: non-allowlisted API host ${host}.`);
    }
  }
  return localFailures;
}

function checkRiskyTerms(content, relativePath) {
  const localFailures = [];
  const allowedRanges = [
    ...markerRanges(content),
    ...functionRanges(content, allowedRiskFunctions),
  ];

  for (const term of riskyTerms) {
    const pattern = new RegExp(escapeRegExp(term), "gi");
    for (const match of content.matchAll(pattern)) {
      if (!isInRanges(match.index, allowedRanges)) {
        const line = lineNumber(content, match.index);
        localFailures.push(
          `${relativePath}:${line}: risky Ads API term "${term}" outside the read-only guard code.`,
        );
      }
    }
  }

  return localFailures;
}

function markerRanges(content) {
  const ranges = [];
  const startMarker = "// readonly-safety-allow-risk-terms:start";
  const endMarker = "// readonly-safety-allow-risk-terms:end";
  let offset = 0;

  while (offset < content.length) {
    const start = content.indexOf(startMarker, offset);
    if (start === -1) {
      break;
    }
    const end = content.indexOf(endMarker, start);
    if (end === -1) {
      ranges.push([start, content.length]);
      break;
    }
    ranges.push([start, end + endMarker.length]);
    offset = end + endMarker.length;
  }

  return ranges;
}

function functionRanges(content, names) {
  const ranges = [];
  for (const match of content.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g)) {
    if (!names.has(match[1])) {
      continue;
    }
    const start = match.index;
    const bodyStart = content.indexOf("{", start);
    const end = matchingBraceIndex(content, bodyStart);
    ranges.push([start, end === -1 ? content.length : end + 1]);
  }
  return ranges;
}

function enclosingFunctionName(content, index) {
  let winner = null;
  for (const match of content.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g)) {
    if (match.index > index) {
      break;
    }
    const bodyStart = content.indexOf("{", match.index);
    const bodyEnd = matchingBraceIndex(content, bodyStart);
    if (bodyStart !== -1 && bodyStart < index && (bodyEnd === -1 || bodyEnd > index)) {
      winner = match[1];
    }
  }
  return winner;
}

function matchingBraceIndex(content, startIndex) {
  if (startIndex < 0) {
    return -1;
  }

  let depth = 0;
  let quoted = null;
  let escaped = false;
  for (let index = startIndex; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quoted) {
        quoted = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quoted = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isInRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runSelfTests() {
  const directFetchFailure = checkDirectFetch(
    'async function bad() { return fetch("https://googleads.googleapis.com/v24/customers/123/googleAds:mutate"); }',
    "self-test",
  );
  assert(directFetchFailure.length === 1, "direct fetch self-test did not fail");

  const mutateFailure = checkRiskyTerms(
    'const bad = "https://googleads.googleapis.com/v24/customers/123/googleAds:mutate";',
    "self-test",
  );
  assert(mutateFailure.length >= 1, "mutate endpoint self-test did not fail");

  const microsoftManagementFailure = checkRiskyTerms(
    'const bad = "https://campaignmanagement.api.bingads.microsoft.com/CampaignManagement/v13";',
    "self-test",
  );
  assert(
    microsoftManagementFailure.length >= 1,
    "Microsoft Campaign Management self-test did not fail",
  );

  const billingFailure = checkRiskyTerms(
    'const bad = "billing payment";',
    "self-test",
  );
  assert(billingFailure.length >= 2, "billing/payment self-test did not fail");

  const guardedTerms = checkRiskyTerms(
    [
      "// readonly-safety-allow-risk-terms:start",
      'const READONLY_DENYLIST = ["billing", "payment", "googleAds:mutate"];',
      "// readonly-safety-allow-risk-terms:end",
    ].join("\n"),
    "self-test",
  );
  assert(guardedTerms.length === 0, "guarded risky terms self-test failed");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
