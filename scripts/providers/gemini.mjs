const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiApiError extends Error {
  constructor(status, message) {
    super(`Gemini request failed (${status}): ${message}`);
    this.name = "GeminiApiError";
    this.status = status;
  }
}

function existingSummary(existing) {
  return existing.map(({ id, title, type, year, source, milestones }) => ({
    id,
    title,
    type,
    year,
    source_url: source?.url,
    milestones: (milestones || []).map(({ type: milestoneType, datetime }) => ({
      type: milestoneType,
      datetime
    }))
  }));
}

export async function extractOpportunitiesWithGemini({
  apiKey,
  profile,
  existing,
  candidates,
  currentDate,
  model = "gemini-3.8-flash"
}) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for extraction.");
  if (!Array.isArray(candidates) || !candidates.length) throw new Error("Gemini extraction requires at least one Tavily candidate.");

  const prompt = `You are the extraction, normalization, and relevance-analysis stage of a personal academic-opportunity radar.

CURRENT DATE (UTC): ${currentDate}

RESEARCH PROFILE:
${JSON.stringify(profile, null, 2)}

KNOWN OPPORTUNITIES FOR DEDUPLICATION AND DEADLINE-CHANGE CONTEXT:
${JSON.stringify(existingSummary(existing), null, 2)}

TAVILY-DISCOVERED SOURCE MATERIAL:
${JSON.stringify(candidates, null, 2)}

Your job is to inspect only the supplied Tavily source material and return currently open or upcoming academic opportunities that are relevant to the research profile.

Rules:
- Do not perform web search and do not use facts that are absent from the supplied source material.
- The source URL for every returned record MUST exactly match one of the supplied candidate URLs.
- Prefer official conference, workshop, organizer, or venue pages. If the supplied material is only an aggregator and does not provide trustworthy evidence, omit the opportunity.
- Conferences and workshops are first-class opportunity types. A workshop may be attached, independent, archival, non-archival, a paper CFP, or a workshop-proposal opportunity; preserve distinctions supported by the source.
- Preserve every stated milestone separately, including abstract, paper, supplementary, rebuttal, notification, camera-ready, registration, workshop proposal, and workshop paper deadlines.
- Preserve exact original deadline wording and include concise source-grounded evidence for each milestone when available.
- Normalize every deadline to an ISO-8601 datetime with an explicit offset. AoE means UTC-12. Never infer an unstated date, time, or timezone. Omit a record when no actionable, unambiguous milestone can be normalized.
- Classify relevance using the full profile: topic, current project, methodology, application domain, opportunity type, and evidence quality.
- Use only the labels Strong match, Good match, or Potential match. Do not produce numeric relevance scores and do not tell the user to submit.
- Return records for new opportunities as well as known opportunities whose source material contains current deadline information.
- Return at most one record per distinct opportunity from this candidate batch.
- Return strict JSON only.

Required JSON shape:
{"opportunities":[{"id":"model-suggested-stable-slug","title":"...","type":"conference|workshop","type_label":"Main conference|Attached workshop|Independent workshop","parent_event":null,"year":2027,"organization":"...","location":{"city":"...","country":"...","virtual":false},"topics":["..."],"publication":{"archival":null,"details":"..."},"milestones":[{"type":"paper_submission","label":"Paper submission","datetime":"ISO-8601 with explicit offset","timezone":"IANA zone or UTC offset","timezone_label":"Anywhere on Earth","original_text":"...","evidence":"..."}],"source":{"url":"exact supplied candidate URL","type":"Official CFP|Official event site|Organizer site|Other","evidence":"concise source-grounded evidence supporting the opportunity and deadline"},"relevance":{"level":"high|medium|potential","label":"Strong match|Good match|Potential match","matched_topics":["..."],"reason":"Why this source-documented opportunity matches the profile"}}]}`;

  const response = await fetch(`${API_ROOT}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        maxOutputTokens: 16384
      }
    })
  });

  const responseBody = await response.text();
  if (!response.ok) throw new GeminiApiError(response.status, responseBody);

  let payload;
  try {
    payload = JSON.parse(responseBody);
  } catch {
    throw new Error("Gemini returned a non-JSON API response.");
  }

  const text = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
  if (!text) throw new Error("Gemini returned no structured content.");

  let result;
  try {
    result = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
  } catch {
    throw new Error("Gemini returned malformed opportunity JSON.");
  }
  if (!Array.isArray(result.opportunities)) throw new Error("Gemini response did not contain an opportunities array.");
  return result;
}
