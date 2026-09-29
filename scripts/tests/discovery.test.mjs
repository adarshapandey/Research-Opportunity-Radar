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

  const repeated = mergeOpportunities(result.opportunities, [opportunity()], "2026-09-27T12:05:00Z", allowed);
  assert.equal(repeated.opportunities.length, 1);
  assert.equal(repeated.opportunities[0].id, "existing-workshop");
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

test("validation accepts bare numeric timezone offsets on every supported Node version", () => {
  const withBareOffset = opportunity({
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: "2026-11-08T23:59:00-12:00",
      timezone: "-12:00",
      timezone_label: "Anywhere on Earth",
      original_text: "November 8, 2026, 11:59 PM AoE",
      evidence: "The official page states the submission deadline."
    }]
  });
  const errors = validateOpportunity(
    withBareOffset,
    new Set([canonicalizeUrl("https://example.org/official-cfp")])
  );
  assert.deepEqual(errors, []);
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
  let geminiCalls = 0;
  let sawCacheDuringGemini = false;
  const result = await runDiscovery({
    root,
    env: { TAVILY_API_KEY: "test", GEMINI_API_KEY: "test", TAVILY_MAX_QUERIES: "1" },
    now: () => new Date("2026-09-27T12:00:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async ({ candidates }) => {
      geminiCalls++;
      await access(join(root, "data/discovery-cache.json"));
      sawCacheDuringGemini = true;
      return { opportunities: [extractedOpportunity(candidates[0], 0)] };
    },
    logger: quietLogger
  });

  assert.equal(result.outcome, "completed");
  assert.equal(tavilyCalls, 1);
  assert.equal(geminiCalls, 1);
  assert.equal(result.geminiRequests, 1);
  assert.equal(sawCacheDuringGemini, true);
  await assert.rejects(access(join(root, "data/discovery-cache.json")), { code: "ENOENT" });
  const output = JSON.parse(await readFile(join(root, "data/opportunities.json"), "utf8"));
  assert.equal(output.opportunities.length, 1);
});

test("completed outputs from an older all-or-nothing cache are merged without API calls", async () => {
  const root = await temporaryWorkspace();
  const candidate = tavilyResponse(1).results[0];
  await writeFile(join(root, "data/discovery-cache.json"), `${JSON.stringify({
    version: 1,
    created_at: "2026-09-27T11:00:00Z",
    updated_at: "2026-09-27T11:05:00Z",
    discovery: { current_date: "2026-09-27", query_log: [], tavily_summary: {}, configuration: { geminiBatchSize: 1 } },
    gemini_context: { profile, existing_opportunities: [] },
    candidates: [candidate],
    batches: [{
      index: 0,
      candidate_indexes: [0],
      status: "completed",
      completed_at: "2026-09-27T11:04:00Z",
      opportunities: [extractedOpportunity(candidate, 0)]
    }],
    state: {
      status: "retry_pending",
      attempts: 1,
      last_error: { http_status: 503, message: "later batch failed" },
      next_retry_at: "2026-09-27T13:00:00Z"
    }
  }, null, 2)}\n`);

  let tavilyCalls = 0;
  let geminiCalls = 0;
  const result = await runDiscovery({
    root,
    env: {},
    now: () => new Date("2026-09-27T12:00:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async () => { geminiCalls++; return { opportunities: [] }; },
    logger: quietLogger
  });

  assert.equal(result.outcome, "completed");
  assert.equal(tavilyCalls, 0);
  assert.equal(geminiCalls, 0);
  const output = JSON.parse(await readFile(join(root, "data/opportunities.json"), "utf8"));
  assert.deepEqual(output.opportunities.map(item => item.title), ["Official Test Workshop 1"]);
  await assert.rejects(access(join(root, "data/discovery-cache.json")), { code: "ENOENT" });
});

test("completed output rejected by older timezone validation is revalidated without API calls", async () => {
  const root = await temporaryWorkspace();
  const candidate = tavilyResponse(1).results[0];
  const cachedOpportunity = extractedOpportunity(candidate, 0);
  cachedOpportunity.milestones[0].timezone = "-12:00";
  await writeFile(join(root, "data/discovery-cache.json"), `${JSON.stringify({
    version: 1,
    created_at: "2026-09-27T11:00:00Z",
    updated_at: "2026-09-27T11:05:00Z",
    discovery: { current_date: "2026-09-27", query_log: [], tavily_summary: {}, configuration: { geminiBatchSize: 1 } },
    gemini_context: { profile, existing_opportunities: [] },
    candidates: [candidate],
    batches: [{
      index: 0,
      candidate_indexes: [0],
      status: "completed",
      completed_at: "2026-09-27T11:04:00Z",
      merged_at: "2026-09-27T11:04:00Z",
      merge_stats: { received: 1, accepted: 0, rejected: 1, duplicates: 0, newRecords: 0, updatedRecords: 0 },
      opportunities: [cachedOpportunity]
    }],
    state: { status: "pending", attempts: 0, last_error: null, next_retry_at: null }
  }, null, 2)}\n`);

  let tavilyCalls = 0;
  let geminiCalls = 0;
  const result = await runDiscovery({
    root,
    env: {},
    now: () => new Date("2026-09-27T12:00:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async () => { geminiCalls++; return { opportunities: [] }; },
    logger: quietLogger
  });

  assert.equal(result.outcome, "completed");
  assert.equal(tavilyCalls, 0);
  assert.equal(geminiCalls, 0);
  const output = JSON.parse(await readFile(join(root, "data/opportunities.json"), "utf8"));
  assert.equal(output.data_mode, "live");
  assert.deepEqual(output.opportunities.map(item => item.title), ["Official Test Workshop 1"]);
  await assert.rejects(access(join(root, "data/discovery-cache.json")), { code: "ENOENT" });
});

test("transient Gemini failures retry immediately and succeed on attempt three", async () => {
  const root = await temporaryWorkspace();
  let tavilyCalls = 0;
  let geminiCalls = 0;
  const messages = [];
  const logger = {
    log(message) { messages.push(message); },
    warn(message) { messages.push(message); },
    error(message) { messages.push(message); }
  };
  const result = await runDiscovery({
    root,
    env: { TAVILY_API_KEY: "test", GEMINI_API_KEY: "test", TAVILY_MAX_QUERIES: "1" },
    now: () => new Date("2026-09-27T12:00:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async ({ candidates }) => {
      geminiCalls++;
      if (geminiCalls < 3) throw new GeminiApiError(503, "temporarily unavailable");
      return { opportunities: [extractedOpportunity(candidates[0], 0)] };
    },
    logger
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.geminiRequests, 3);
  assert.equal(geminiCalls, 3);
  assert.equal(tavilyCalls, 1);
  assert.ok(messages.some(message => message.includes("attempt 1/5")));
  assert.ok(messages.some(message => message.includes("failed with HTTP 503")));
  assert.ok(messages.some(message => message.includes("Retrying Gemini immediately")));
  assert.ok(messages.some(message => message.includes("attempt 3/5 succeeded")));
  await assert.rejects(access(join(root, "data/discovery-cache.json")), { code: "ENOENT" });
});

test("five transient failures stop the run and preserve completed checkpoints without rerunning Tavily", async () => {
  const root = await temporaryWorkspace();
  const candidates = tavilyResponse(2).results;
  await writeFile(join(root, "data/discovery-cache.json"), `${JSON.stringify({
    version: 1,
    created_at: "2026-09-27T11:00:00Z",
    updated_at: "2026-09-27T11:05:00Z",
    discovery: { current_date: "2026-09-27", query_log: [], tavily_summary: {}, configuration: { geminiBatchSize: 1 } },
    gemini_context: { profile, existing_opportunities: [] },
    candidates,
    batches: [
      {
        index: 0,
        candidate_indexes: [0],
        status: "completed",
        attempts: 1,
        completed_at: "2026-09-27T11:04:00Z",
        merged_at: "2026-09-27T11:04:00Z",
        merge_stats: { received: 0, accepted: 0, rejected: 0, duplicates: 0, newRecords: 0, updatedRecords: 0 },
        merge_validation_version: 2,
        opportunities: []
      },
      {
        index: 1,
        candidate_indexes: [1],
        status: "pending",
        attempts: 0,
        extracted_at: null,
        completed_at: null,
        merged_at: null,
        opportunities: []
      }
    ],
    state: { status: "pending", attempts: 0, last_error: null }
  }, null, 2)}\n`);

  let tavilyCalls = 0;
  let geminiCalls = 0;
  const messages = [];
  await assert.rejects(runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test" },
    now: () => new Date("2026-09-27T12:00:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async () => {
      geminiCalls++;
      throw new GeminiApiError(503, "temporarily unavailable");
    },
    logger: {
      log(message) { messages.push(message); },
      warn(message) { messages.push(message); },
      error(message) { messages.push(message); }
    }
  }), /503/);

  assert.equal(geminiCalls, 5);
  assert.equal(tavilyCalls, 0);
  const checkpoint = await cacheAt(root);
  assert.deepEqual(checkpoint.batches.map(batch => batch.status), ["completed", "retry_pending"]);
  assert.equal(checkpoint.batches[0].attempts, 1);
  assert.equal(checkpoint.batches[1].attempts, 5);
  assert.equal(checkpoint.state.attempts, 5);
  assert.equal(checkpoint.state.status, "retry_pending");
  assert.equal("next_retry_at" in checkpoint.state, false);
  assert.ok(messages.some(message => message.includes("attempt 5/5 failed with HTTP 503")));
  assert.ok(messages.includes("Maximum immediate Gemini attempts reached."));
  assert.ok(messages.some(message => message.includes("next weekly discovery run")));
});

test("permanent Gemini errors make one request and preserve blocked-cache behavior", async () => {
  const root = await temporaryWorkspace();
  let tavilyCalls = 0;
  let geminiCalls = 0;
  await assert.rejects(runDiscovery({
    root,
    env: { TAVILY_API_KEY: "test", GEMINI_API_KEY: "test", TAVILY_MAX_QUERIES: "1" },
    now: () => new Date("2026-09-27T12:00:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async () => {
      geminiCalls++;
      throw new GeminiApiError(401, "invalid API key");
    },
    logger: quietLogger
  }), /401/);

  assert.equal(geminiCalls, 1);
  assert.equal(tavilyCalls, 1);
  assert.equal((await cacheAt(root)).state.status, "blocked");

  const blocked = await runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test" },
    now: () => new Date("2026-09-27T12:30:00Z"),
    search: async () => { tavilyCalls++; return tavilyResponse(1); },
    extract: async () => { geminiCalls++; return { opportunities: [] }; },
    logger: quietLogger
  });
  assert.equal(blocked.outcome, "blocked");
  assert.equal(geminiCalls, 1);
  assert.equal(tavilyCalls, 1);
});

test("completed cached batches are skipped while an unfinished batch gets immediate retry behavior", async () => {
  const root = await temporaryWorkspace();
  const candidates = tavilyResponse(2).results;
  await writeFile(join(root, "data/discovery-cache.json"), `${JSON.stringify({
    version: 1,
    created_at: "2026-09-27T11:00:00Z",
    updated_at: "2026-09-27T11:05:00Z",
    discovery: { current_date: "2026-09-27", query_log: [], tavily_summary: {}, configuration: { geminiBatchSize: 1 } },
    gemini_context: { profile, existing_opportunities: [] },
    candidates,
    batches: [
      {
        index: 0,
        candidate_indexes: [0],
        status: "completed",
        attempts: 1,
        completed_at: "2026-09-27T11:04:00Z",
        merged_at: "2026-09-27T11:04:00Z",
        merge_stats: { received: 0, accepted: 0, rejected: 0, duplicates: 0, newRecords: 0, updatedRecords: 0 },
        merge_validation_version: 2,
        opportunities: []
      },
      {
        index: 1,
        candidate_indexes: [1],
        status: "retry_pending",
        attempts: 5,
        extracted_at: null,
        completed_at: null,
        merged_at: null,
        opportunities: []
      }
    ],
    state: { status: "retry_pending", attempts: 5, last_error: { http_status: 503 } }
  }, null, 2)}\n`);

  let geminiCalls = 0;
  const requestedUrls = [];
  const result = await runDiscovery({
    root,
    env: { GEMINI_API_KEY: "test" },
    now: () => new Date("2026-10-04T12:00:00Z"),
    search: async () => { throw new Error("Tavily must not run during cached recovery"); },
    extract: async ({ candidates: batchCandidates }) => {
      geminiCalls++;
      requestedUrls.push(batchCandidates[0].url);
      return { opportunities: [extractedOpportunity(batchCandidates[0], 1)] };
    },
    logger: quietLogger
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.tavilyRequests, 0);
  assert.equal(geminiCalls, 1);
  assert.deepEqual(requestedUrls, ["https://events.example.org/workshop-2"]);
  await assert.rejects(access(join(root, "data/discovery-cache.json")), { code: "ENOENT" });
});
