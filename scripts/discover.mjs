import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { searchTavily, TavilyApiError } from './providers/tavily.mjs';
import { extractOpportunitiesLocally } from './providers/local-model.mjs';
import { buildDiscoveryQueries, buildOfficialSourceQueries, canonicalizeUrl, deduplicateSearchResults } from './discovery-queries.mjs';
import { mergeOpportunities, validateOpportunity } from './lib/opportunity-store.mjs';
import { matchStoredOpportunity } from '../profile-utils.js';

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
function setting(env, name, fallback, max) {
  const n = Number(env[name] || fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer from 1 to ${max}.`);
  return n;
}

export async function runDiscovery({ root = defaultRoot, env = process.env, now = () => new Date(), search = searchTavily, extract = extractOpportunitiesLocally, logger = console } = {}) {
  const profile = await readJson(join(root, 'data/profile.json'));
  const dataPath = join(root, 'data/opportunities.json');
  const current = await readJson(dataPath);
  if (!Array.isArray(current.opportunities)) throw new Error('Missing opportunities array.');
  const cachePath = join(root, '.cache/discovery.json');
  const reportPath = join(root, '.cache/discovery-report.json');
  const started = now();
  const maxCandidates = setting(env, 'TAVILY_MAX_CANDIDATES', 20, 30);
  const inputFile = env.DISCOVERY_INPUT;
  let cache = null;
  if (!inputFile) {
    try { cache = await readJson(cachePath); }
    catch (error) { if (error.code !== 'ENOENT') logger.warn(`Ignoring unusable checkpoint: ${error.message}`); }
    if (cache && (cache.version !== 2 || !Number.isFinite(Date.parse(cache.created_at)) || +started - Date.parse(cache.created_at) > 48 * 3600000 || !Array.isArray(cache.candidates) || !Array.isArray(cache.completed) || !Array.isArray(cache.records) || cache.profile !== JSON.stringify(profile))) cache = null;
  }
  let tavilyRequests = 0;
  if (!cache) {
    let candidates;
    if (inputFile) {
      candidates = deduplicateSearchResults((await readJson(resolve(root, inputFile))).candidates, maxCandidates, 6000);
    } else {
      if (!env.TAVILY_API_KEY) throw new Error('TAVILY_API_KEY is required. Use DISCOVERY_INPUT for offline search replay.');
      const maxQueries = setting(env, 'TAVILY_MAX_QUERIES', 10, 20);
      const resultsPerQuery = setting(env, 'TAVILY_RESULTS_PER_QUERY', 5, 10);
      const collected = [];
      let quotaStopped = false;
      const runQueries = async queries => {
        for (const query of queries) {
          if (tavilyRequests >= maxQueries || quotaStopped) break;
          tavilyRequests++;
          try {
            const result = await search({ apiKey: env.TAVILY_API_KEY, query, maxResults: resultsPerQuery });
            collected.push(...result.results);
          } catch (error) {
            logger.warn(`Search failed: ${error.message}`);
            if (error instanceof TavilyApiError && [429,432,433].includes(error.status)) quotaStopped = true;
          }
        }
      };
      await runQueries(buildDiscoveryQueries(profile, maxQueries >= 4 ? maxQueries - 2 : maxQueries, started));
      await runQueries(buildOfficialSourceQueries(deduplicateSearchResults(collected), maxQueries - tavilyRequests, started));
      candidates = deduplicateSearchResults(collected, maxCandidates, 6000);
    }
    if (!candidates.length) throw new Error('No usable sources; existing dataset was preserved.');
    cache = { version: 2, created_at: started.toISOString(), profile: JSON.stringify(profile), candidates, completed: [], records: [] };
    if (!inputFile) await writeJsonAtomic(cachePath, cache);
  }
  const report = { started_at: started.toISOString(), model: 'Qwen2.5-3B-Instruct Q4_K_M', tavily_requests: tavilyRequests, candidates: cache.candidates.length, pages: [], accepted: 0, rejected: 0 };
  let completedThisRun = 0;
  for (const [index, candidate] of cache.candidates.entries()) {
    if (cache.completed.includes(index)) continue;
    const time = Date.now();
    try {
      const result = await extract({ candidate, profile, currentDate: started.toISOString().slice(0,10), env });
      if (!Array.isArray(result.opportunities)) throw new Error('Invalid extractor response.');
      const accepted = result.opportunities.filter(op => {
        const errors = validateOpportunity(op, new Set([canonicalizeUrl(candidate.url)]));
        if (errors.length) { report.rejected++; logger.warn(`Rejected ${op?.title}: ${errors.join(', ')}`); return false; }
        return op.milestones.some(m => Date.parse(m.datetime) > +started);
      });
      cache.records.push(...accepted);
      cache.completed.push(index);
      completedThisRun++;
      report.pages.push({ url: candidate.url, status: 'completed', accepted: accepted.length, duration_ms: Date.now() - time });
      logger.log(`[${index + 1}/${cache.candidates.length}] ${accepted.length} accepted (${Date.now() - time} ms): ${candidate.url}`);
      if (!inputFile) await writeJsonAtomic(cachePath, cache);
    } catch (error) {
      report.pages.push({ url: candidate.url, status: 'failed', error: error.message, duration_ms: Date.now() - time });
      logger.warn(`[${index + 1}] Preserving source for retry: ${error.message}`);
    }
  }
  report.finished_at = now().toISOString();
  if (!completedThisRun && !cache.completed.length) {
    await writeJsonAtomic(reportPath, report);
    throw new Error('Every inference request failed; dataset and published site remain unchanged.');
  }
  const allowed = new Set(cache.candidates.map(c => canonicalizeUrl(c.url)).filter(Boolean));
  const { opportunities, stats } = mergeOpportunities(current.opportunities.map(op => matchStoredOpportunity(op,profile)), cache.records.map(op => ({...op,matches_profile:true})), started.toISOString(), allowed);
  report.accepted = stats.accepted;
  report.merge = stats;
  const output = { ...current, opportunities };
  if (stats.accepted) { output.generated_at = started.toISOString(); output.data_mode = 'live'; }
  const outputPath = env.DISCOVERY_OUTPUT ? resolve(root, env.DISCOVERY_OUTPUT) : inputFile ? join(root, '.cache/preview-opportunities.json') : dataPath;
  if (inputFile && outputPath === dataPath) throw new Error('Replay cannot overwrite production data; choose a preview output path.');
  await writeJsonAtomic(outputPath, output);
  await writeJsonAtomic(reportPath, report);
  logger.log(`Saved ${stats.accepted} accepted updates to ${outputPath}. ${report.pages.filter(p => p.status === 'failed').length} source failures.`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDiscovery().catch(error => { console.error(error.message); process.exitCode = 1; });
}
