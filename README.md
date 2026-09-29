# AI Research Opportunity Radar

A calm, deadline-first personal web app for autonomously discovering globally relevant AI conferences and workshops, preserving timezone semantics (including AoE), and explaining why each call overlaps with an evolving research profile.

The repository is deliberately static and designed for free-tier operation: GitHub Pages serves the interface, GitHub Actions runs discovery on a schedule, Tavily searches the open web, and Gemini extracts and reasons over the returned source material. Neither API key ever reaches the browser.

## What works

- Deadline-first radar with a motivational countdown
- Conferences and workshops as first-class opportunity types
- Multiple typed milestones per opportunity
- AoE/UTC-12 preservation plus local-time conversion in detail views
- Evidence-linked relevance explanations and source freshness
- Deadline change signals
- AI discovery feed, timeline, search, filters, and opportunity details
- Device-local watchlist and editable research profile
- Responsive keyboard-accessible interface
- Scheduled Tavily discovery with batched Gemini extraction
- Durable Tavily-to-Gemini cache with batch-level recovery checkpoints
- Deterministic URL/title identity matching plus source-constrained validation
- GitHub Pages deployment workflow

The bundled opportunity records are clearly marked demonstration data. They make the product fully explorable before the live discovery workflow is connected, but should not be used as submission advice.

## Run locally

```bash
clone the repository
npm run dev
```

Open `http://localhost:4173`. No install step is required.


## Safety model

Tavily Search returns ranked URLs, snippets, and cleaned page content. Gemini receives only that material and has no web-search tool. Returned records are rejected unless their source URL came from Tavily, their milestones have parseable datetimes with explicit offsets and valid timezone values, and source evidence and a supported relevance label are present. Paper-deadline changes are detected before merging.

The default budget is ten basic Tavily searches per discovery cycle, five results per search, at most thirty unique candidate URLs, and Gemini batches of ten. This means at most three Gemini batches for a new cycle, with up to five immediate requests per batch when retryable failures occur. Tavily results are written to `data/discovery-cache.json` before the first Gemini request. Each successful Gemini batch is immediately validated and merged into `data/opportunities.json`, then marked completed in the cache.

If Gemini returns a retryable error, including 429, 500, 502, 503, or 504, the current batch is retried immediately up to five total attempts in the same process. There is no sleep between attempts and Tavily is not called again. If all five attempts fail, the cache remains for the next weekly discovery run, which skips Tavily and resumes only unfinished Gemini batches. HTTP 400, 401, 403, and 404 stop after one request and mark the cache as blocked. After fixing the configuration, use the manual workflow's **force Gemini retry** option or set `FORCE_GEMINI_RETRY=true` locally. There is no Gemini health-check request.

The workflow commits cache creation, incremental opportunity updates, and checkpoints even when a later Gemini batch exits with an API error. Earlier successful batches remain visible and are not rolled back. The cache is deleted only after every Gemini batch has completed and its merge has been persisted successfully.

Search results can contain stale or incomplete content, and the code does not perform a separate deterministic fetch after Tavily Search. Before relying on a deadline, follow the source link shown in the detail view.

## Discovery configuration

Environment variables are supplied by the shell locally and by GitHub Actions secrets/configuration in automation. No dotenv loader is used.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAVILY_API_KEY` | required for live runs | Tavily Search authentication. |
| `GEMINI_API_KEY` | required for live runs | Gemini extraction authentication. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Extraction/relevance model. |
| `TAVILY_MAX_QUERIES` | `10` | Total search cap, hard-capped by code at 20. |
| `TAVILY_RESULTS_PER_QUERY` | `5` | Ranked results requested per search. |
| `TAVILY_MAX_CANDIDATES` | `30` | Unique candidate URLs retained for Gemini. |
| `TAVILY_MAX_CONTENT_CHARS` | `6000` | Maximum source characters retained per URL. |
| `GEMINI_BATCH_SIZE` | `10` | Candidate sources sent per Gemini call. |
| `GEMINI_MAX_IMMEDIATE_ATTEMPTS` | `5` | Total Gemini attempts per unfinished batch in one invocation, hard-capped by code at 5. |
| `FORCE_GEMINI_RETRY` | false | Explicitly retry cached work blocked by a permanent/configuration error. |

With Tavily's current one-credit basic-search pricing, the default scheduled configuration uses at most ten credits per run. The repository never opts into pay-as-you-go or automatically falls back to a paid provider; plan enforcement remains the responsibility of the Tavily and Gemini accounts.

## Data ownership

- `data/profile.json` is the default profile used by scheduled discovery.
- Editing the profile in the website stores a private override in that browser's `localStorage`.
- To make profile edits affect scheduled discovery, update `data/profile.json` in the repository.
- `data/opportunities.json` is public because GitHub Pages must serve it.
- A pending `data/discovery-cache.json` is repository-persisted and may also be publicly served by Pages. It contains search-result URLs/content and checkpoints, never API keys.

## Useful commands

```bash
npm run check       # JavaScript syntax validation
npm test            # dependency-free discovery/merge tests
npm run discover    # dry run without both keys; live with both API keys
```

If a pending cache exists, `npm run discover` needs only `GEMINI_API_KEY`; it skips Tavily automatically and resumes unfinished Gemini batches.
