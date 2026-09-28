import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDiscoveryQueries,
  canonicalizeUrl,
  deduplicateSearchResults
} from "../discovery-queries.mjs";
import { mergeOpportunities, validateOpportunity } from "../lib/opportunity-store.mjs";
import { runDiscovery } from "../discover.mjs";
import { GeminiApiError } from "../providers/gemini.mjs";

const profile = {
  research_areas: ["Computer Vision", "Medical Imaging", "Remote Sensing", "Foundation Models"],
  current_projects: ["UAV multimodal sensing"],
  keywords: ["LiDAR", "uncertainty"]
};

test("profile-derived queries are open-ended and respect the budget", () => {
  const queries = buildDiscoveryQueries(profile, 6, new Date("2026-09-27T00:00:00Z"));
  assert.equal(queries.length, 6);
  assert.match(queries.join(" "), /Medical Imaging|Remote Sensing|Foundation Models|Computer Vision/i);
  assert.ok(queries.every(query => query.includes("2026 2027")));
});

test("URL canonicalization and Tavily-result deduplication remove tracking duplicates", () => {
  assert.equal(
    canonicalizeUrl("https://www.example.org/cfp/?utm_source=test#dates"),
    "example.org/cfp"
  );
  const results = deduplicateSearchResults([
    { title: "CFP", url: "https://example.org/cfp?utm_source=a", content: "short", score: 0.5, discovery_query: "one" },
    { title: "CFP", url: "https://www.example.org/cfp/", raw_content: "a much longer official source", score: 0.8, discovery_query: "two" }
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].content, "a much longer official source");
  assert.deepEqual(results[0].discovery_queries, ["one", "two"]);
});

function opportunity(overrides = {}) {
  return {
    id: "model-id",
    title: "Example Vision Workshop 2027",
    type: "workshop",
    type_label: "Independent workshop",
    year: 2027,
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: "2026-11-08T23:59:00-12:00",
      timezone: "UTC-12",
      timezone_label: "Anywhere on Earth",
      original_text: "November 8, 2026, 11:59 PM AoE",
      evidence: "The official page states the submission deadline."
    }],
    source: { url: "https://example.org/official-cfp", type: "Official CFP", evidence: "The page states the paper deadline." },
    relevance: { level: "high", label: "Strong match", matched_topics: ["computer vision"], reason: "Matches the profile." },
    ...overrides
  };
}

test("merge matches deterministic identity, detects paper changes, and skips duplicate outputs", () => {
  const existing = [opportunity({
    id: "existing-workshop",
    source: { url: "https://old.example.org/event", evidence: "Old evidence" },
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: "2026-11-01T23:59:00-12:00",
      timezone: "UTC-12",
      original_text: "November 1, 2026, 11:59 PM AoE",
      evidence: "The old official page stated the submission deadline."
    }]
  })];
  const duplicate = opportunity({ source: { url: "https://example.net/other-page", evidence: "Duplicate page" } });
  const allowed = new Set([canonicalizeUrl("https://example.org/official-cfp"), canonicalizeUrl("https://example.net/other-page")]);
  const result = mergeOpportunities(existing, [opportunity(), duplicate], "2026-09-27T12:00:00Z", allowed);

  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].id, "existing-workshop");
  assert.equal(result.opportunities[0].updated, true);
  assert.equal(result.stats.updatedRecords, 1);
  assert.equal(result.stats.duplicates, 1);
});

test("validation rejects invented sources, invalid timezones, and datetimes without offsets", () => {
  const invalid = opportunity({
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: "2026-11-08T23:59:00",
      timezone: "Moon/Base",
      original_text: "November 8",
      evidence: "The page says November 8."
    }]
  });
  const errors = validateOpportunity(invalid, new Set([canonicalizeUrl("https://different.example/cfp")]));
  assert.ok(errors.includes("milestone datetime lacks explicit offset"));
  assert.ok(errors.includes("invalid milestone timezone"));
  assert.ok(errors.includes("source was not supplied by Tavily"));
});

test("validation requires evidence for each milestone", () => {
  const missingEvidence = opportunity();
  delete missingEvidence.milestones[0].evidence;
  const errors = validateOpportunity(
    missingEvidence,
    new Set([canonicalizeUrl("https://example.org/official-cfp")])
  );
  assert.ok(errors.includes("missing milestone evidence"));
});

const quietLogger = { log() {}, warn() {}, error() {} };

async function temporaryWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "radar-discovery-test-"));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data/profile.json"), `${JSON.stringify(profile)}\n`);
  await writeFile(join(root, "data/opportunities.json"), `${JSON.stringify({
    generated_at: "2026-09-01T00:00:00Z",
    data_mode: "test",
    opportunities: []
  })}\n`);
  return root;
}

function tavilyResponse(count = 1) {
  return {
    credits: 1,
    requestId: "test-request",
    results: Array.from({ length: count }, (_, index) => ({
      title: `Official Test Workshop ${index + 1}`,
      url: `https://events.example.org/workshop-${index + 1}`,
      raw_content: `Official call for papers ${index + 1}: submission is November ${index + 1}, 2026 at 11:59 PM AoE.`,
      score: 1 - index / 100,
      discovery_query: "mocked profile query"
    }))
  };
}

function extractedOpportunity(candidate, index = 0) {
  return {
    id: `model-workshop-${index + 1}`,
    title: `Official Test Workshop ${index + 1}`,
    type: "workshop",
    type_label: "Independent workshop",
    year: 2027,
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: `2026-11-${String(index + 1).padStart(2, "0")}T23:59:00-12:00`,
      timezone: "UTC-12",
      timezone_label: "Anywhere on Earth",
      original_text: `November ${index + 1}, 2026 at 11:59 PM AoE`,
      evidence: "The official call states this submission deadline."
    }],
    source: { url: candidate.url, type: "Official CFP", evidence: "Official call for papers and deadline." },
    relevance: { level: "high", label: "Strong match", matched_topics: ["computer vision"], reason: "Matches the research profile." }
  };
}

async function cacheAt(root) {
  return JSON.parse(await readFile(join(root, "data/discovery-cache.json"), "utf8"));
}

test("normal run caches Tavily results before Gemini, writes opportunities, then deletes cache", async () => {
  const root = await temporaryWorkspace();
  let tavilyCalls = 0;
  let sawCacheDuringGemini = false;
  const result = await runDiscovery({
    root,
    env: { TAVILY_API_KEY: "test", GEMINI_API_KEY: "test", TAVILY_MAX_QUERIES: "1" },
    now: () => new Date("2026-09-27T12:00:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async ({ candidates }) => {
      await access(join(root, "data/discovery-cache.json"));
      sawCacheDuringGemini = true;
      return { opportunities: [extractedOpportunity(candidates[0], 0)] };
    },
    logger: quietLogger
  });

  assert.equal(result.outcome, "completed");
  assert.equal(tavilyCalls, 1);
  assert.equal(sawCacheDuringGemini, true);
  await assert.rejects(access(join(root, "data/discovery-cache.json")), { code: "ENOENT" });
  const output = JSON.parse(await readFile(join(root, "data/opportunities.json"), "utf8"));
  assert.equal(output.opportunities.length, 1);
});

test("Gemini 503 keeps the cache and recovery skips Tavily", async () => {
  const root = await temporaryWorkspace();
  let currentTime = new Date("2026-09-27T12:00:00Z");
  let tavilyCalls = 0;
  const search = async () => { tavilyCalls++; return tavilyResponse(1); };
  await assert.rejects(runDiscovery({
    root,
    env: { TAVILY_API_KEY: "test", GEMINI_API_KEY: "test", TAVILY_MAX_QUERIES: "1" },
    now: () => currentTime,
    search,
    extract: async () => { throw new GeminiApiError(503, "temporarily unavailable"); },
    logger: quietLogger
  }), /503/);

  const failedCache = await cacheAt(root);
  assert.equal(failedCache.state.status, "retry_pending");
  assert.equal(tavilyCalls, 1);
  const unchanged = JSON.parse(await readFile(join(root, "data/opportunities.json"), "utf8"));
  assert.equal(unchanged.opportunities.length, 0);

  currentTime = new Date("2026-09-27T12:10:00Z");
  let earlyGeminiCalls = 0;
  const waiting = await runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test" },
    now: () => currentTime,
    search,
    extract: async () => { earlyGeminiCalls++; return { opportunities: [] }; },
    logger: quietLogger
  });
  assert.equal(waiting.outcome, "retry_wait");
  assert.equal(earlyGeminiCalls, 0);
  assert.equal(tavilyCalls, 1);

  currentTime = new Date("2026-09-27T12:16:00Z");
  const recovered = await runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test" },
    now: () => currentTime,
    search,
    extract: async ({ candidates }) => ({ opportunities: [extractedOpportunity(candidates[0], 0)] }),
    logger: quietLogger
  });
  assert.equal(recovered.outcome, "completed");
  assert.equal(recovered.tavilyRequests, 0);
  assert.equal(tavilyCalls, 1);
  await assert.rejects(access(join(root, "data/discovery-cache.json")), { code: "ENOENT" });
});

test("batch checkpoints skip completed Gemini batches during recovery", async () => {
  const root = await temporaryWorkspace();
  let currentTime = new Date("2026-09-27T12:00:00Z");
  let tavilyCalls = 0;
  const firstAttemptUrls = [];
  let geminiCall = 0;
  await assert.rejects(runDiscovery({
    root,
    env: {
      TAVILY_API_KEY: "test",
      GEMINI_API_KEY: "test",
      TAVILY_MAX_QUERIES: "1",
      GEMINI_BATCH_SIZE: "1"
    },
    now: () => currentTime,
    search: async () => { tavilyCalls++; return tavilyResponse(3); },
    extract: async ({ candidates }) => {
      firstAttemptUrls.push(candidates[0].url);
      geminiCall++;
      if (geminiCall === 3) throw new GeminiApiError(503, "third batch unavailable");
      return { opportunities: [extractedOpportunity(candidates[0], geminiCall - 1)] };
    },
    logger: quietLogger
  }), /503/);

  const checkpoint = await cacheAt(root);
  assert.deepEqual(checkpoint.batches.map(batch => batch.status), ["completed", "completed", "pending"]);
  assert.equal(checkpoint.batches[0].opportunities.length, 1);
  assert.equal(checkpoint.batches[1].opportunities.length, 1);

  currentTime = new Date("2026-09-27T12:16:00Z");
  const recoveryUrls = [];
  const recovered = await runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test" },
    now: () => currentTime,
    search: async () => { tavilyCalls++; return tavilyResponse(3); },
    extract: async ({ candidates }) => {
      recoveryUrls.push(candidates[0].url);
      return { opportunities: [extractedOpportunity(candidates[0], 2)] };
    },
    logger: quietLogger
  });

  assert.equal(recovered.outcome, "completed");
  assert.equal(tavilyCalls, 1);
  assert.deepEqual(recoveryUrls, ["https://events.example.org/workshop-3"]);
  assert.equal(firstAttemptUrls.length, 3);
  const output = JSON.parse(await readFile(join(root, "data/opportunities.json"), "utf8"));
  assert.equal(output.opportunities.length, 3);
});

test("persistent transient Gemini failures never rerun Tavily or corrupt opportunities", async () => {
  const root = await temporaryWorkspace();
  let currentTime = new Date("2026-09-27T12:00:00Z");
  let tavilyCalls = 0;
  const search = async () => { tavilyCalls++; return tavilyResponse(1); };
  const failingGemini = async () => { throw new GeminiApiError(429, "quota exhausted"); };

  await assert.rejects(runDiscovery({
    root,
    env: { TAVILY_API_KEY: "test", GEMINI_API_KEY: "test", TAVILY_MAX_QUERIES: "1" },
    now: () => currentTime,
    search,
    extract: failingGemini,
    logger: quietLogger
  }), /429/);
  const originalFile = await readFile(join(root, "data/opportunities.json"), "utf8");

  currentTime = new Date("2026-09-27T12:16:00Z");
  await assert.rejects(runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test" },
    now: () => currentTime,
    search,
    extract: failingGemini,
    logger: quietLogger
  }), /429/);

  assert.equal(tavilyCalls, 1);
  assert.equal(await readFile(join(root, "data/opportunities.json"), "utf8"), originalFile);
  const cache = await cacheAt(root);
  assert.equal(cache.state.status, "retry_pending");
  assert.equal(cache.state.attempts, 2);
});

test("permanent Gemini errors block automatic retries but allow an explicit cached retry", async () => {
  const root = await temporaryWorkspace();
  let tavilyCalls = 0;
  await assert.rejects(runDiscovery({
    root,
    env: { TAVILY_API_KEY: "test", GEMINI_API_KEY: "test", TAVILY_MAX_QUERIES: "1" },
    now: () => new Date("2026-09-27T12:00:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async () => { throw new GeminiApiError(404, "model not found"); },
    logger: quietLogger
  }), /404/);

  assert.equal((await cacheAt(root)).state.status, "blocked");
  let automaticGeminiCalls = 0;
  const blocked = await runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test" },
    now: () => new Date("2026-09-27T12:30:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async () => { automaticGeminiCalls++; return { opportunities: [] }; },
    logger: quietLogger
  });
  assert.equal(blocked.outcome, "blocked");
  assert.equal(automaticGeminiCalls, 0);

  const forced = await runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test", FORCE_GEMINI_RETRY: "true" },
    now: () => new Date("2026-09-27T12:31:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async ({ candidates }) => ({ opportunities: [extractedOpportunity(candidates[0], 0)] }),
    logger: quietLogger
  });
  assert.equal(forced.outcome, "completed");
  assert.equal(tavilyCalls, 1);
});
