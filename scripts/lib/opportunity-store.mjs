import { createHash } from "node:crypto";
import { canonicalizeUrl, normalizeTitle } from "../discovery-queries.mjs";

function validTimezone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (/^UTC(?:[+-](?:(?:0?\d|1[0-3])(?::?[0-5]\d)?|14(?::?00)?))?$/i.test(value)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function yearFor(opportunity) {
  const explicit = Number(opportunity.year);
  if (Number.isInteger(explicit)) return explicit;
  const titleYear = String(opportunity.title || "").match(/\b(20\d{2})\b/);
  if (titleYear) return Number(titleYear[1]);
  const milestoneYear = String(opportunity.milestones?.[0]?.datetime || "").match(/^(20\d{2})/);
  return milestoneYear ? Number(milestoneYear[1]) : null;
}

function identityKey(opportunity) {
  return [opportunity.type || "", yearFor(opportunity) || "", normalizeTitle(opportunity.title)].join("|");
}

function stableId(opportunity) {
  const year = yearFor(opportunity);
  let base = normalizeTitle(opportunity.title).replace(/\s+/g, "-").slice(0, 54) || "opportunity";
  if (year && !base.endsWith(String(year))) base = `${base}-${year}`;
  const canonicalUrl = canonicalizeUrl(opportunity.source?.url) || identityKey(opportunity);
  const suffix = createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 8);
  return `${base}-${suffix}`;
}

export function validateOpportunity(opportunity, allowedSourceUrls = new Set()) {
  const errors = [];
  if (!opportunity || typeof opportunity !== "object") return ["not an object"];
  if (!opportunity.title) errors.push("missing title");
  if (!["conference", "workshop"].includes(opportunity.type)) errors.push("invalid type");
  const year = yearFor(opportunity);
  if (!year || year < 2000 || year > 2100) errors.push("invalid year");
  if (!Array.isArray(opportunity.milestones) || !opportunity.milestones.length) errors.push("missing milestones");

  for (const milestone of opportunity.milestones || []) {
    if (!milestone.type || !milestone.label || !milestone.original_text) errors.push("incomplete milestone");
    if (!milestone.evidence) errors.push("missing milestone evidence");
    if (!milestone.datetime || Number.isNaN(Date.parse(milestone.datetime))) errors.push("invalid milestone datetime");
    if (milestone.datetime && !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(milestone.datetime)) errors.push("milestone datetime lacks explicit offset");
    if (!validTimezone(milestone.timezone)) errors.push("invalid milestone timezone");
  }

  const sourceUrl = opportunity.source?.url;
  const canonicalSource = canonicalizeUrl(sourceUrl);
  if (!sourceUrl?.startsWith("https://") || !canonicalSource) errors.push("missing HTTPS source");
  if (allowedSourceUrls.size && canonicalSource && !allowedSourceUrls.has(canonicalSource)) errors.push("source was not supplied by Tavily");
  if (!opportunity.source?.evidence) errors.push("missing source evidence");
  if (!opportunity.relevance?.reason || !opportunity.relevance?.label) errors.push("missing relevance explanation");
  if (!["Strong match", "Good match", "Potential match"].includes(opportunity.relevance?.label)) errors.push("invalid relevance label");
  return [...new Set(errors)];
}

export function mergeOpportunities(existing, discovered, verifiedAt, allowedSourceUrls = new Set()) {
  const records = new Map(existing.map(item => [item.id, item]));
  const byUrl = new Map();
  const byIdentity = new Map();
  const seenIncoming = new Set();
  const stats = {
    received: discovered.length,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    newRecords: 0,
    updatedRecords: 0
  };

  const indexRecord = record => {
    const canonicalUrl = canonicalizeUrl(record.source?.url);
    if (canonicalUrl) byUrl.set(canonicalUrl, record.id);
    const identity = identityKey(record);
    if (identity && !identity.endsWith("|")) byIdentity.set(identity, record.id);
  };
  existing.forEach(indexRecord);

  for (const incoming of discovered) {
    const errors = validateOpportunity(incoming, allowedSourceUrls);
    if (errors.length) {
      stats.rejected++;
      console.warn(`Rejected ${incoming?.title || "untitled record"}: ${errors.join(", ")}`);
      continue;
    }

    incoming.year = yearFor(incoming);
    const canonicalUrl = canonicalizeUrl(incoming.source.url);
    const identity = identityKey(incoming);
    if (seenIncoming.has(canonicalUrl) || seenIncoming.has(identity)) {
      stats.duplicates++;
      console.warn(`Skipped duplicate Gemini record: ${incoming.title}`);
      continue;
    }
    seenIncoming.add(canonicalUrl);
    seenIncoming.add(identity);

    const priorId = byUrl.get(canonicalUrl) || byIdentity.get(identity) || (records.has(incoming.id) ? incoming.id : null);
    const prior = priorId ? records.get(priorId) : null;
    const recordId = prior?.id || stableId(incoming);
    const priorPaper = prior?.milestones?.find(milestone => milestone.type === "paper_submission")?.datetime;
    const nextPaper = incoming.milestones.find(milestone => milestone.type === "paper_submission")?.datetime;
    const deadlineChanged = Boolean(priorPaper && nextPaper && priorPaper !== nextPaper);

    const merged = {
      ...prior,
      ...incoming,
      id: recordId,
      discovered: !prior,
      updated: deadlineChanged,
      change_note: deadlineChanged
        ? `Paper deadline changed from ${priorPaper} to ${nextPaper}.`
        : prior?.change_note,
      source: { ...incoming.source, last_verified: verifiedAt }
    };

    records.set(recordId, merged);
    indexRecord(merged);
    stats.accepted++;
    if (prior) {
      if (deadlineChanged) stats.updatedRecords++;
    } else {
      stats.newRecords++;
    }
  }

  return { opportunities: [...records.values()], stats };
}
