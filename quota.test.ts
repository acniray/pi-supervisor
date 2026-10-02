/**
 * Tests for classifyStopError().
 *
 * Every fixture below is a REAL errorMessage string collected from this machine's
 * pi session logs (~/.pi/agent/sessions + session-archive), with the observed
 * occurrence count noted. The counts matter: they say which mistakes are expensive.
 *
 * Run: node --test quota.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyStopError } from "./quota.ts";

// ------------------------------------------------------------------ quota
// Errors that self-heal with time -> supervisor should wait and re-probe.

const QUOTA_FIXTURES: Array<[label: string, message: string]> = [
  ["codex-usage-limit ×20", "Codex error: The usage limit has been reached"],
  ["chatgpt-team ×5", "You have hit your ChatGPT usage limit (team plan). Try again in ~132 min."],
  ["chatgpt-plus ×1", "You have hit your ChatGPT usage limit (plus plan). Try again in ~37 min."],
  ["opencode-go ×5", '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}'],
  [
    "opencode-go-5hour ×5",
    '429: {"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 3hr 21min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01EXAMPLEWORKSPACEID0000000/go"}',
  ],
  [
    "qoder-weekly ×4",
    '429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-09-03 16:50:07 重置。"}',
  ],
  ["opencode-go-free (pi list)", '429: {"type":"FreeUsageLimitError","message":"Free usage limit exceeded"}'],
  [
    "openai-insufficient_quota (pi list)",
    'OpenAI API error (429): {"error":{"message":"You exceeded your current quota. Please check your plan and billing details.","type":"insufficient_quota"}}',
  ],
  ["opencode-monthly (pi list)", "Monthly usage limit reached"],
  [
    "chatgpt-sharing (pi list)",
    '429: {"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Your plan usage limit has been reached."}}',
  ],
  ["generic-quota-exceeded (pi list)", "Upstream status 429: quota exceeded, retry later"],
  ["openrouter-out-of-budget (pi list)", "OpenRouter error: out of budget"],
];

test("classifies time-recoverable usage-limit errors as quota", () => {
  for (const [label, message] of QUOTA_FIXTURES) {
    assert.equal(classifyStopError(message).kind, "quota", `${label} should be quota: ${message}`);
  }
});

test("quota classification is case-insensitive", () => {
  assert.equal(classifyStopError("CODEX ERROR: THE USAGE LIMIT HAS BEEN REACHED").kind, "quota");
});

test("quota classification reports which rule matched", () => {
  const result = classifyStopError("Codex error: The usage limit has been reached");
  assert.equal(result.kind, "quota");
  assert.ok(result.rule, "expected a rule label for logging");
});

// -------------------------------------------------------------- permanent
// Errors that need a human (money / credentials / config) -> stop immediately,
// do NOT burn hours waiting for something that will never self-heal.

const PERMANENT_FIXTURES: Array<[label: string, message: string]> = [
  ["insufficient-funds ×3", '402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}'],
  ["login-expired ×2", 'Upstream status 403: {"code":"105","message":"Login expired"}'],
  [
    "region-blocked ×2",
    'opencode-go API error (403): {"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported","param":null,"type":"request_forbidden"}',
  ],
  [
    "model-not-supported ×2",
    "Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
  ],
  ["no-provider ×2", "No API provider registered for api: openai-chat"],
  [
    "workspace-privacy ×8",
    'opencode-go API error (400): {"type":"server_error","message":"Upstream request failed: This Go model trains on request data. Allow paid endpoints that train on request data in your workspace\'s Privacy settings to use it."}',
  ],
  ["credit-balance", '402: {"error":{"message":"Your credit balance is too low to access the API."}}'],
  ["bad-api-key", 'OpenAI API error (401): {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}'],
];

test("classifies human-required errors as permanent", () => {
  for (const [label, message] of PERMANENT_FIXTURES) {
    assert.equal(classifyStopError(message).kind, "permanent", `${label} should be permanent: ${message}`);
  }
});

// ------------------------------------------------------------------ other
// Everything else keeps today's behavior: supervisor returns and never fights it.

const OTHER_FIXTURES: Array<[label: string, message: string]> = [
  ["bare-429 ×104", "429 status code (no body)"],
  ["fetch-failed ×49", "fetch failed"],
  [
    "qoder-504 ×32",
    'Qoder API request failed: 504 Gateway Time-out. Response: <html> <head><title>504 Gateway Time-out</title></head> <body bgcolor="white"> <center><h1>504 Gateway Time-out</h1></center> <hr><center>alb</center> </body> </html> ',
  ],
  ["aborted ×32", "This operation was aborted"],
  ["aborted ×15", "Operation aborted"],
  ["aborted ×10", "Request was aborted"],
  ["aborted ×10b", "Request aborted"],
  ["codex-overloaded ×14", "Codex error: Our servers are currently overloaded. Please try again later."],
  // TRAP: contains both "429" and "limit". It is a per-minute throttle that pi's
  // built-in auto-retry already owns. Waiting hours here would be wrong.
  [
    "tpm-rate-limit ×11",
    '429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"ModelAccountTpmRateLimitExceeded"}',
  ],
  [
    "rpm-rate-limit ×3",
    '429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"ModelAccountRpmRateLimitExceeded"}',
  ],
  ["websocket ×11", "WebSocket error"],
  ["terminated ×8", "terminated"],
  ["timeout ×7", "Request timed out."],
  ["stream-ended ×7", "Stream ended without finish_reason"],
  ["connection ×5", "Connection error."],
  ["endpoint-unavailable-403 ×8", 'opencode-go API error (403): {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}'],
  ["endpoint-unavailable-529 ×2", '529: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}'],
  ["invalid-request ×5", '400: {"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] invalid request"}'],
  [
    "upstream-queue ×3",
    'Upstream status 403: {"code":"403","message":"{\\"code\\":\\"10605\\",\\"message\\":\\"{\\\\\\"isQueued\\\\\\":false,\\\\\\"modelKey\\\\\\":\\\\\\"qfmodel\\\\\\",\\\\\\"queueCount\\\\\\":0,\\\\\\"queueType\\\\\\":\\\\\\"p2\\\\\\",\\\\\\"retryAfterSeconds\\\\\\":2,\\\\\\"serviceAvailable\\\\\\":true,\\\\\\"waitTime\\\\\\":0}\\"}"}',
  ],
  ["upstream-connect ×1", "upstream connect error or disconnect/reset before headers. retried and the latest reset reason: connection timeout"],
  ["api-error ×1", "Streaming response failed: [api_error] internal server error"],
  ["finish-reason ×1", "Provider finish_reason: error"],
];

test("leaves transient and unrelated errors alone", () => {
  for (const [label, message] of OTHER_FIXTURES) {
    assert.equal(classifyStopError(message).kind, "other", `${label} should be other: ${message}`);
  }
});

test("treats a missing error message as other", () => {
  assert.equal(classifyStopError(undefined).kind, "other");
  assert.equal(classifyStopError("").kind, "other");
  assert.equal(classifyStopError("   ").kind, "other");
});

// ----------------------------------------------------------------- config
// A new provider's wording must be fixable from config.json, not from code.

test("extraPatterns promotes an unknown message to quota", () => {
  const message = "MyGateway: daily token cap exhausted for this workspace";
  assert.equal(classifyStopError(message).kind, "other");
  assert.equal(classifyStopError(message, { extraPatterns: ["daily token cap"] }).kind, "quota");
});

test("ignorePatterns demotes a built-in quota match", () => {
  const message = "Codex error: The usage limit has been reached";
  assert.equal(classifyStopError(message).kind, "quota");
  assert.equal(classifyStopError(message, { ignorePatterns: ["usage limit"] }).kind, "other");
});

test("ignorePatterns wins over extraPatterns", () => {
  const message = "MyGateway: daily token cap exhausted";
  const result = classifyStopError(message, {
    extraPatterns: ["daily token cap"],
    ignorePatterns: ["daily token cap"],
  });
  assert.equal(result.kind, "other");
});

test("user patterns are matched case-insensitively", () => {
  assert.equal(classifyStopError("MYGATEWAY: DAILY TOKEN CAP", { extraPatterns: ["daily token cap"] }).kind, "quota");
});

test("an invalid user pattern is ignored instead of throwing", () => {
  const message = "Codex error: The usage limit has been reached";
  assert.equal(classifyStopError(message, { extraPatterns: ["([unclosed"], ignorePatterns: ["*bad*"] }).kind, "quota");
});

test("non-string input is ignored instead of throwing", () => {
  assert.equal(classifyStopError(null).kind, "other");
  assert.equal(classifyStopError(42 as unknown as string).kind, "other");
  assert.equal(classifyStopError({} as unknown as string).kind, "other");
});
