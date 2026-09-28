const SEARCH_ENDPOINT = "https://api.tavily.com/search";

export class TavilyApiError extends Error {
  constructor(status, message) {
    super(`Tavily search failed (${status}): ${message}`);
    this.name = "TavilyApiError";
    this.status = status;
  }
}

export async function searchTavily({ apiKey, query, maxResults = 5 }) {
  if (!apiKey) throw new Error("TAVILY_API_KEY is required for live discovery.");

  const response = await fetch(SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      chunks_per_source: 3,
      max_results: maxResults,
      topic: "general",
      include_answer: false,
      include_raw_content: "markdown",
      include_published_date: true,
      include_images: false,
      include_usage: true,
      auto_parameters: false,
      safe_search: true
    })
  });

  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new TavilyApiError(response.status, body || "non-JSON response");
  }

  if (!response.ok) {
    const detail = payload?.detail?.error || payload?.detail || payload?.message || body;
    throw new TavilyApiError(response.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }

  if (!Array.isArray(payload.results)) {
    throw new TavilyApiError(response.status, "response did not contain a results array");
  }

  return {
    results: payload.results.map(result => ({ ...result, discovery_query: query })),
    credits: Number(payload.usage?.credits) || 1,
    requestId: payload.request_id || null
  };
}
