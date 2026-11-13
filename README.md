# Research Opportunity Radar

A static personal conference/workshop radar with Tuesday discovery performed entirely in GitHub Actions. Tavily supplies source content. A pinned Qwen2.5-3B-Instruct Q4_K_M model runs locally on the runner's CPU using llama.cpp b6000. No hosted inference API or Gemini key is used.

The website loads only HTML, CSS, JavaScript and public JSON. Inference never runs in the browser. The public build excludes model weights, source caches, scripts and diagnostic reports. A failed discovery, model evaluation, build, or deployment leaves the previous Pages deployment available.

## Branches and activation

- `main`: old implementation; leave it unchanged.
- `dev`: new implementation and the single discovery/deployment workflow.
- Make `dev` the GitHub repository's default branch **after local testing and pushing it**. GitHub schedules run from the default branch; changing this setting does not modify `main`.
- The workflow runs Tuesdays at **06:17 America/Los_Angeles**, with daylight saving handled by the schedule timezone. GitHub may delay scheduled jobs.
- Pushes to `dev` publish validated static assets without downloading a model or spending Tavily credits. Scheduled runs perform discovery, then publish within the same workflow. A manual run can optionally perform discovery.
- Pages serves the new version at the existing URL. It does not create a second preview URL for `dev`.

See [the local testing guide](docs/LOCAL_TESTING.md) before pushing. This checkout does not change GitHub settings automatically.

## Pipeline

1. Generate up to ten profile-derived Tavily searches, including official-source refinements.
2. Deduplicate and retain up to twenty candidate pages, 6,000 characters each.
3. Persist source checkpoints under ignored `.cache/` before inference.
4. Process one page at a time with the local CPU model, an 8,192-token context, at most 1,800 output tokens and a three-minute per-page timeout. Child processes are killed on timeout.
5. Constrain output to a JSON schema. Require exact source excerpts and source-supported titles/topics. Code parses dates and timezones from evidence; the model cannot invent a normalized datetime.
6. Accept only relevant records with valid display fields and at least one future milestone. Ambiguous deadlines are omitted rather than guessed.
7. Merge accepted records, validate the public dataset, commit data to `dev`, and directly deploy the staged `site/` artifact.

Partial source failures do not discard successful extractions. Complete inference failure preserves the dataset. Checkpoints expire after 48 hours, so last week's failures cannot indefinitely prevent fresh searches. Recent retry runs can reuse completed pages. Model evaluation failure blocks scheduled discovery and publishing.

## Accuracy and coverage

The local model is an extractor, not an authority. Every accepted milestone must contain an explicit date, year, time and timezone together in a source excerpt. The deterministic parser supports English month names, ISO dates, AoE, UTC/GMT and explicit UTC/GMT offsets. Unstated times, ambiguous zone abbreviations and IANA zones without an explicit supported offset are currently rejected. This intentionally reduces coverage; date-only CFPs will not become new countdowns.

Relevance uses exact case-insensitive matches against repository profile terms, with transparent template explanations. It does not claim deep semantic ranking. Source links are labeled “Search-discovered source”; being returned by search does not prove a page is official. Follow the source before relying on a deadline.

Scan age displays whole hours below 24 hours and whole days thereafter.

Existing historical records remain in storage. On discovery, stored records are reclassified against the current research profile; unmatched records stay in search/watchlist and are excluded from the main radar/discovery feed. The frontend excludes expired records from the next-deadline calculation, selects milestones chronologically, and still permits inspection through search/watchlist. Demonstration records are excluded from the published artifact. There is no automatic deletion of historical records.

The model passed the six checked-in labeled smoke cases during development; that is a regression check, not a general accuracy benchmark. See `docs/MODEL_EVALUATION.md` for measured results and limitations.

## Prerequisites

- Node.js **22+** and npm.
- Python **3.10+**.
- Linux x64 for the bundled prebuilt CPU runtime (the Actions workflow uses Ubuntu 22.04).
- About **2.1 GB** for model weights plus runtime/download space; allow **6 GB free disk** and **8 GB RAM** as a practical local starting point.
- No `npm install` is required: the JavaScript code has no package dependencies.

Model and runtime downloads are pinned and SHA-256 verified. Their URLs, revisions and checksums are in `scripts/model-config.json`. The model carries the upstream [Qwen Research license](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/blob/main/LICENSE).

## Commands

```bash
npm run check          # Syntax-check application and scripts
npm test               # Offline regression and frontend smoke tests
npm run build          # Validate data and create public site/ only
npm run preview        # Serve site/ at http://localhost:4173
npm run model:setup    # Download/check CPU runtime and model, first run ~2.1 GB
npm run model:evaluate # Real inference on six labeled positive/negative fixtures
npm run discover:replay # Real inference on cached Tavily sources; preview output only
npm run discover       # Live search; requires TAVILY_API_KEY, writes repository data
```

`npm run dev` serves the source tree for development. Use `npm run build` followed by `npm run preview` when checking the exact deployment artifact.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAVILY_API_KEY` | Required for fresh live searches | Set in shell or GitHub Actions secrets |
| `TAVILY_MAX_QUERIES` | 10 | Total search cap, maximum 20 |
| `TAVILY_RESULTS_PER_QUERY` | 5 | Search results per query, maximum 10 |
| `TAVILY_MAX_CANDIDATES` | 20 | Pages processed per cycle, maximum 30 |
| `LOCAL_MODEL_TIMEOUT_MS` | 180000 | Inference process timeout per page |
| `RADAR_LLAMA_CLI` | `.cache/local-model/runtime/build/bin/llama-cli` | Existing compatible CLI, e.g. on macOS |
| `RADAR_MODEL_PATH` | `.cache/local-model/model.gguf` | Existing compatible model weights |
| `DISCOVERY_INPUT` | Unset | Replay a JSON file containing `candidates`; never calls Tavily |
| `DISCOVERY_OUTPUT` | Live: `data/opportunities.json`; replay: `.cache/preview-opportunities.json` | Alternative output for safe local tests |
| `SITE_DATA` | `data/opportunities.json` | Dataset to validate and stage for preview |
| `MODEL_EVAL_INPUT` | `scripts/fixtures/extraction.json` | Alternative observed evaluation sources |
| `MODEL_EVAL_LIMIT` | All supplied sources | Limit real model evaluation pages |

No dotenv loader is used. Merely creating `.env` does not load variables.

## Data ownership

`data/profile.json` drives scheduled discovery. Website profile saves dispatch an authenticated GitHub Actions run that commits the new profile, discovers opportunities, and republishes the site. Watchlists remain browser-local. See [profile saving setup](docs/PROFILE_SAVING.md) for the required repository-scoped token and progress behavior. The research profile and accepted opportunities are public assets. Tavily keys remain in the Actions environment; the user token used to save profiles is held only in browser memory and sent directly to GitHub.

The former Gemini checkpoint has been removed from public data. Its Tavily candidates are preserved as `scripts/fixtures/cached-tavily.json` for reproducible local replay, excluded from the website. New checkpoints, weights, reports, preview data and `site/` are ignored by Git.
