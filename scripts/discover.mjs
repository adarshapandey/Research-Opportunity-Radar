import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { extractOpportunitiesWithGemini, GeminiApiError } from "./providers/gemini.mjs";
import { searchTavily, TavilyApiError } from "./providers/tavily.mjs";
import {
  buildDiscoveryQueries,
  buildOfficialSourceQueries,
  canonicalizeUrl,
  deduplicateSearchResults
} from "./discovery-queries.mjs";
import { mergeOpportunities } from "./lib/opportunity-store.mjs";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_VERSION = 1;
const TRANSIENT_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);
const PERMANENT_GEMINI_STATUSES = new Set([400, 401, 403, 404]);

function integerSetting(env, logger, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    logger.warn(`Ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}.`);
    return fallback;
  }
  if (parsed > maximum) {
    logger.warn(`Capping ${name} at ${maximum} to protect free-tier usage.`);
    return maximum;
  }
  return parsed;
}

function enabled(value) {
  return /^(1|true|yes)$/i.test(String(value || ""));
}

function batches(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readCache(path) {
  try {
    const cache = await readJson(path);
    if (cache.version !== CACHE_VERSION || !Array.isArray(cache.candidates) || !Array.isArray(cache.batches)) {
      throw new Error("unsupported or malformed discovery cache");
    }
    return cache;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot load ${path}: ${error.message}`);
  }
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
}

async function deleteCache(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function batchCandidates(cache, batch) {
  return batch.candidate_indexes.map(index => cache.candidates[index]).filter(Boolean);
}

function cacheIsDue(cache, currentTime) {
  if (!cache.state?.next_retry_at) return true;
  const retryAt = Date.parse(cache.state.next_retry_at);
  return Number.isNaN(retryAt) || currentTime.getTime() >= retryAt;
}

function failureState(error, currentTime, retryMinutes) {
  const status = error instanceof GeminiApiError ? error.status : null;
  const permanent = status !== null && PERMANENT_GEMINI_STATUSES.has(status);
  const transient = status === null || TRANSIENT_GEMINI_STATUSES.has(status);
  return {
    status: permanent ? "blocked" : "retry_pending",
    http_status: status,
    classification: permanent ? "permanent" : transient ? "transient" : "unclassified",
    message: error.message,
    failed_at: currentTime.toISOString(),
    next_retry_at: permanent ? null : new Date(currentTime.getTime() + retryMinutes * 60000).toISOString()
  };
}

export async function runDiscovery({
  root = defaultRoot,
  env = process.env,
  now = () => new Date(),
  search = searchTavily,
  extract = extractOpportunitiesWithGemini,
  logger = console
} = {}) {
  const profilePath = join(root, "data/profile.json");
  const opportunitiesPath = join(root, "data/opportunities.json");
  const cachePath = join(root, "data/discovery-cache.json");
  const profile = await readJson(profilePath);
  const current = await readJson(opportunitiesPath);
  if (!Array.isArray(current.opportunities)) throw new Error("data/opportunities.json does not contain an opportunities array.");

  const retryMinutes = integerSetting(env, logger, "GEMINI_RETRY_INTERVAL_MINUTES", 15, 1, 1440);
  const forceBlockedRetry = enabled(env.FORCE_GEMINI_RETRY);
  const recoveryOnly = enabled(env.RECOVERY_ONLY);
  let cache = await readCache(cachePath);
  let tavilyRequestsThisRun = 0;
  let geminiRequestsThisRun = 0;

  if (cache) {
    logger.log("Pending discovery cache found. Skipping Tavily discovery.");
    if (cache.state?.status === "blocked" && !forceBlockedRetry) {
      logger.error(`Cached Gemini work is blocked by a permanent/configuration error: ${cache.state.last_error?.message || "unknown error"}`);
      logger.error("Fix the configuration, then retry explicitly with FORCE_GEMINI_RETRY=true. The cache was preserved.");
      return { outcome: "blocked", tavilyRequests: 0, geminiRequests: 0 };
    }
    if (!cacheIsDue(cache, now()) && !forceBlockedRetry) {
      logger.log(`Gemini retry is not due until ${cache.state.next_retry_at}. Cache preserved; no API requests made.`);
      return { outcome: "retry_wait", tavilyRequests: 0, geminiRequests: 0 };
    }
  } else {
    logger.log("No pending discovery cache found.");
    if (recoveryOnly) {
      logger.log("Recovery-only invocation has no pending work. Skipping Tavily and Gemini.");
      return { outcome: "no_pending_cache", tavilyRequests: 0, geminiRequests: 0 };
    }

    const missingKeys = ["TAVILY_API_KEY", "GEMINI_API_KEY"].filter(name => !env[name]);
    if (missingKeys.length) {
      logger.log(`Dry run: ${current.opportunities.length} existing records loaded. Set ${missingKeys.join(" and ")} for live Tavily discovery and Gemini extraction.`);
      return { outcome: "dry_run", tavilyRequests: 0, geminiRequests: 0 };
    }

    const startedAt = now();
    const currentDate = startedAt.toISOString().slice(0, 10);
    const maxQueries = integerSetting(env, logger, "TAVILY_MAX_QUERIES", 10, 1, 20);
    const resultsPerQuery = integerSetting(env, logger, "TAVILY_RESULTS_PER_QUERY", 5, 1, 10);
    const maxCandidates = integerSetting(env, logger, "TAVILY_MAX_CANDIDATES", 30, 1, 50);
    const maxContentChars = integerSetting(env, logger, "TAVILY_MAX_CONTENT_CHARS", 6000, 1000, 12000);
    const geminiBatchSize = integerSetting(env, logger, "GEMINI_BATCH_SIZE", 10, 1, 15);
    const verificationBudget = maxQueries >= 4 ? 2 : 0;
    const discoveryBudget = maxQueries - verificationBudget;
    const discoveryQueries = buildDiscoveryQueries(profile, discoveryBudget, startedAt);
    const queryLog = [];
    const counters = { attempted: 0, succeeded: 0, failed: 0, credits: 0, rawResults: 0 };
    const collected = [];
    let quotaStopped = false;

    logger.log("Starting Tavily discovery...");
    logger.log(`Discovery plan: ${discoveryQueries.length} profile-derived searches + up to ${verificationBudget} official-source refinements (cap ${maxQueries}).`);
    logger.log(`Candidate limits: ${resultsPerQuery} results/query, ${maxCandidates} unique URLs, Gemini batches of ${geminiBatchSize}.`);

    const runTavilyQueries = async (queries, phase) => {
      for (const query of queries) {
        if (counters.attempted >= maxQueries || quotaStopped) break;
        counters.attempted++;
        tavilyRequestsThisRun++;
        logger.log(`[Tavily ${counters.attempted}/${maxQueries}] ${phase}: ${query}`);
        try {
          const response = await search({ apiKey: env.TAVILY_API_KEY, query, maxResults: resultsPerQuery });
          counters.succeeded++;
          counters.credits += response.credits;
          counters.rawResults += response.results.length;
          collected.push(...response.results);
          queryLog.push({ phase, query, status: "succeeded", result_count: response.results.length, credits: response.credits, request_id: response.requestId });
          logger.log(`  collected ${response.results.length} results; Tavily reported ${response.credits} credit(s).`);
        } catch (error) {
          counters.failed++;
          queryLog.push({ phase, query, status: "failed", error: error.message });
          logger.warn(`  ${error.message}`);
          if (error instanceof TavilyApiError && [429, 432, 433].includes(error.status)) {
            quotaStopped = true;
            logger.warn("  Stopping additional Tavily requests because a rate or usage limit was reached.");
          }
        }
      }
    };

    await runTavilyQueries(discoveryQueries, "discovery");
    if (!counters.succeeded) throw new Error("All Tavily discovery queries failed; existing opportunity data was preserved.");

    const provisional = deduplicateSearchResults(collected, maxCandidates, maxContentChars);
    const remainingQueryBudget = maxQueries - counters.attempted;
    if (remainingQueryBudget > 0 && !quotaStopped) {
      await runTavilyQueries(buildOfficialSourceQueries(provisional, remainingQueryBudget, startedAt), "official-source refinement");
    }

    const candidates = deduplicateSearchResults(collected, maxCandidates, maxContentChars);
    logger.log(`Tavily discovery complete: ${candidates.length} unique candidates from ${counters.rawResults} results and ${counters.attempted} request(s).`);
    if (!candidates.length) throw new Error("Tavily returned no usable candidate URLs; existing opportunity data was preserved.");

    const candidateBatches = batches(candidates, geminiBatchSize);
    cache = {
      version: CACHE_VERSION,
      created_at: startedAt.toISOString(),
      updated_at: startedAt.toISOString(),
      discovery: {
        current_date: currentDate,
        query_log: queryLog,
        tavily_summary: counters,
        configuration: { maxQueries, resultsPerQuery, maxCandidates, maxContentChars, geminiBatchSize }
      },
      gemini_context: {
        profile,
        existing_opportunities: current.opportunities
      },
      candidates,
      batches: candidateBatches.map((batch, index) => ({
        index,
        candidate_indexes: batch.map(candidate => candidates.indexOf(candidate)),
        status: "pending",
        completed_at: null,
        opportunities: []
      })),
      state: { status: "pending", attempts: 0, last_error: null, next_retry_at: null }
    };
    logger.log("Persisting discovery cache before Gemini processing...");
    await writeJsonAtomic(cachePath, cache);
  }

  const pendingBatches = cache.batches.filter(batch => batch.status !== "completed");
  if (pendingBatches.length && !env.GEMINI_API_KEY) {
    throw new Error(`Pending cache has ${pendingBatches.length} unfinished Gemini batch(es). Set GEMINI_API_KEY to resume; Tavily will remain skipped.`);
  }

  if (forceBlockedRetry && cache.state?.status === "blocked") {
    logger.log("Explicitly retrying previously blocked Gemini work.");
  }
  cache.state.status = "processing";
  cache.state.next_retry_at = null;
  cache.updated_at = now().toISOString();
  await writeJsonAtomic(cachePath, cache);

  const firstPending = cache.batches.findIndex(batch => batch.status !== "completed");
  logger.log(firstPending >= 0
    ? `Starting Gemini processing at batch ${firstPending + 1}/${cache.batches.length}. Completed batches will be skipped.`
    : "All Gemini batches are already checkpointed. Finalizing the cached discovery cycle.");

  for (const batch of cache.batches) {
    if (batch.status === "completed") {
      logger.log(`[Gemini ${batch.index + 1}/${cache.batches.length}] checkpoint found; skipping completed batch.`);
      continue;
    }

    const candidates = batchCandidates(cache, batch);
    geminiRequestsThisRun++;
    logger.log(`[Gemini ${batch.index + 1}/${cache.batches.length}] analyzing ${candidates.length} cached Tavily candidates.`);
    try {
      const result = await extract({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL || "gemini-3.8-flash",
        profile: cache.gemini_context?.profile || profile,
        existing: cache.gemini_context?.existing_opportunities || current.opportunities,
        candidates,
        currentDate: cache.discovery.current_date
      });
      batch.status = "completed";
      batch.opportunities = result.opportunities;
      batch.completed_at = now().toISOString();
      cache.state.status = "processing";
      cache.state.last_error = null;
      cache.updated_at = batch.completed_at;
      await writeJsonAtomic(cachePath, cache);
      logger.log(`  Gemini returned ${result.opportunities.length} opportunity candidate(s); batch checkpoint persisted.`);
    } catch (error) {
      const failedAt = now();
      const state = failureState(error, failedAt, retryMinutes);
      cache.state = {
        ...cache.state,
        status: state.status,
        attempts: (cache.state.attempts || 0) + 1,
        last_error: state,
        next_retry_at: state.next_retry_at
      };
      cache.updated_at = failedAt.toISOString();
      await writeJsonAtomic(cachePath, cache);
      const statusLabel = state.http_status ? `HTTP ${state.http_status}` : "an unclassified error";
      logger.error(`Gemini processing failed with ${statusLabel}. Keeping discovery cache for recovery.`);
      if (state.status === "retry_pending") {
        logger.error(`No Tavily search will be performed on retry. Next eligible retry: ${state.next_retry_at}.`);
      } else {
        logger.error("This appears to be a permanent/configuration error. Automatic retries are blocked until an explicit retry is requested.");
      }
      throw error;
    }
  }

  const extracted = cache.batches.flatMap(batch => batch.opportunities || []);
  const verifiedAt = now().toISOString();
  const allowedSourceUrls = new Set(cache.candidates.map(candidate => canonicalizeUrl(candidate.url)).filter(Boolean));
  const { opportunities, stats } = mergeOpportunities(current.opportunities, extracted, verifiedAt, allowedSourceUrls);

  logger.log("Gemini processing complete. Writing opportunities.json...");
  await writeJsonAtomic(opportunitiesPath, { generated_at: verifiedAt, data_mode: "live", opportunities });
  logger.log("Discovery completed successfully. Deleting discovery cache.");
  await deleteCache(cachePath);

  logger.log(`Run summary: ${cache.candidates.length} cached candidates; ${stats.newRecords} new, ${stats.updatedRecords} deadline changes, ${stats.rejected} rejected, ${stats.duplicates} duplicates, ${stats.accepted} accepted.`);
  logger.log(`API usage this invocation: ${tavilyRequestsThisRun} Tavily request(s), ${geminiRequestsThisRun} Gemini request(s).`);
  return { outcome: "completed", tavilyRequests: tavilyRequestsThisRun, geminiRequests: geminiRequestsThisRun, stats };
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  runDiscovery().catch(error => {
    console.error(`Discovery failed: ${error.message}`);
    console.error("Existing data/opportunities.json was preserved. Any discovery cache/checkpoints remain available for recovery.");
    process.exitCode = 1;
  });
}
