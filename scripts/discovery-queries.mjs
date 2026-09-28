const TRACKING_PARAMETERS = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"
]);

function cleanTerm(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueTerms(profile) {
  const values = [
    ...(profile.research_areas || []),
    ...(profile.current_projects || []),
    ...(profile.keywords || [])
  ].map(cleanTerm).filter(Boolean);

  const seen = new Set();
  return values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isoWeekIndex(date) {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor(utc / 604800000);
}

export function buildDiscoveryQueries(profile, limit, currentDate = new Date()) {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (!safeLimit) return [];

  const currentYear = currentDate.getUTCFullYear();
  const years = `${currentYear} ${currentYear + 1}`;
  const queries = [
    `upcoming artificial intelligence computer science conference call for papers ${years} official`,
    `upcoming machine learning workshop call for papers workshop proposal ${years} official`
  ];

  const terms = uniqueTerms(profile);
  if (!terms.length) return queries.slice(0, safeLimit);

  // Rotate through the complete profile over successive scheduled runs so a
  // conservative query budget does not permanently favor the first topics.
  const start = (isoWeekIndex(currentDate) * 2) % terms.length;
  const rotated = [...terms.slice(start), ...terms.slice(0, start)];
  let cursor = 0;

  while (queries.length < safeLimit) {
    const first = rotated[cursor % rotated.length];
    const second = rotated[(cursor + 1) % rotated.length];
    const opportunityType = queries.length % 2 === 0
      ? "conference workshop call for papers"
      : "specialized workshop CFP call for papers";
    queries.push(`"${first}" "${second}" ${opportunityType} ${years} official`);
    cursor += 2;
  }

  return [...new Set(queries)].slice(0, safeLimit);
}

export function buildOfficialSourceQueries(results, limit, currentDate = new Date()) {
  const years = `${currentDate.getUTCFullYear()} ${currentDate.getUTCFullYear() + 1}`;
  const seen = new Set();
  const queries = [];

  for (const result of results) {
    const title = cleanTerm(result.title)
      .replace(/\s*[|–—]\s*(call for papers|cfp|deadlines?).*$/i, "")
      .slice(0, 150);
    const key = title.toLowerCase();
    if (!title || title.length < 8 || seen.has(key)) continue;
    seen.add(key);
    queries.push(`"${title}" official conference workshop call for papers ${years}`);
    if (queries.length >= limit) break;
  }

  return queries;
}

export function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = url.pathname.replace(/\/(?:index\.html?)?$/i, "") || "/";
    pathname = pathname.replace(/\/{2,}/g, "/");
    const parameters = [...url.searchParams.entries()]
      .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMETERS.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));
    const search = new URLSearchParams(parameters).toString();
    return `${host}${pathname}${search ? `?${search}` : ""}`;
  } catch {
    return null;
  }
}

export function normalizeTitle(value) {
  return cleanTerm(value)
    .toLowerCase()
    .replace(/\b(call for papers|calls for papers|cfp|official site|home)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deduplicateSearchResults(results, maxCandidates = 30, maxContentChars = 6000) {
  const unique = new Map();

  for (const result of results) {
    const canonicalUrl = canonicalizeUrl(result.url);
    if (!canonicalUrl) continue;
    const content = cleanTerm(result.raw_content || result.content).slice(0, maxContentChars);
    const current = unique.get(canonicalUrl);
    const query = cleanTerm(result.discovery_query);

    if (!current) {
      unique.set(canonicalUrl, {
        title: cleanTerm(result.title),
        url: result.url,
        canonical_url: canonicalUrl,
        content,
        score: Number(result.score) || 0,
        published_date: result.published_date || null,
        discovery_queries: query ? [query] : []
      });
      continue;
    }

    if (content.length > current.content.length) current.content = content;
    if ((Number(result.score) || 0) > current.score) current.score = Number(result.score);
    if (query && !current.discovery_queries.includes(query)) current.discovery_queries.push(query);
  }

  return [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}
