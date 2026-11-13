# Local testing before pushing dev

Run these commands from the project directory. They do not push a branch, change the GitHub default branch, or publish a website.

## 1. Confirm the branch and prerequisites

```bash
cd /home/adarsha/Documents/vibe-coding-projects/Research-Opportunity-Radar
git branch --show-current
node --version
npm --version
python3 --version
```

Expect branch `dev`, Node 22 or later, and Python 3.10 or later. Install Node/Python on your machine if absent. No npm dependency installation is needed.

## 2. Run fast offline checks

```bash
npm run check
npm test
npm run build
```

All tests should pass. The build prints the number of validated public records. The committed starting dataset produces seven public records; five demonstration records remain in source storage but are excluded from `site/`.

The tests cover source grounding, timezone parsing, malformed model output, search/model failure preservation, partial recovery, cache expiry, safe replay, HTML escaping, chronological deadlines, frontend initialization and deployment asset isolation. They do not load a model or call Tavily.

## 3. Preview the exact public website

```bash
npm run preview
```

Open http://localhost:4173. Check Radar, Discoveries, Watchlist, search, tracking and opportunity details. Closed entries should show no upcoming milestones. The featured entry must have a future milestone. Use your browser's Network panel to confirm there is no model download or inference request. Only public assets and JSON are needed (plus Google Fonts).

Leave this preview running while executing the model tests in a second terminal. The website should remain responsive. Stop it with Ctrl+C when finished.

## 4. Download the pinned model/runtime once

```bash
npm run model:setup
```

This downloads approximately 2.1 GB of model weights and the Linux x64 CPU runtime into ignored `.cache/local-model/`. Checksums are verified, including on subsequent setup runs. Allow about 6 GB free disk and 8 GB RAM. This step needs internet access, but no API key.

For another OS, install a compatible llama.cpp CLI and set `RADAR_LLAMA_CLI` to its absolute path before setup. Set `RADAR_MODEL_PATH` only when you already have compatible weights. The automated GitHub runtime is pinned to b6000; changing the runtime/model requires repeating the evaluation.

## 5. Test real local inference

```bash
npm run model:evaluate
```

Expect six `PASS` lines and exit status zero. The cases cover AoE, multiple milestones, a UTC offset, a missing time, a missing timezone, and event dates that are not submission deadlines. Results and durations are written to `.cache/model-evaluation.json`. No Tavily request is made, and live opportunity data is unchanged.

This verifies narrow regression cases. It does not establish general extraction accuracy on all conference sites.

## 6. Replay the old search cache safely

For a short run using the first three ranked sources:

```bash
DISCOVERY_INPUT=scripts/fixtures/cached-tavily.json TAVILY_MAX_CANDIDATES=3 npm run discover
SITE_DATA=.cache/preview-opportunities.json npm run build
npm run preview
```

Replay uses current repository profile/date and fresh local inference, not old Gemini outputs. It never calls Tavily or overwrites `data/opportunities.json`. It writes preview data to `.cache/preview-opportunities.json` and diagnostics to `.cache/discovery-report.json`. Some cached pages may produce zero accepted records because dates are old, incomplete, unrelated, or missing explicit times/zones. Zero accepted records is different from an inference failure.

To replay up to twenty cached sources:

```bash
npm run discover:replay
```

Larger pages take substantially longer than the small smoke fixtures. Each page has a three-minute inference timeout. Individual failed pages are reported; if every inference fails, the command exits nonzero and leaves the existing dataset untouched.

## 7. Test fresh Tavily discovery without changing live data

Read the API key without putting it in shell history:

```bash
read -rsp 'Tavily API key: ' TAVILY_API_KEY
export TAVILY_API_KEY
printf '\n'
TAVILY_MAX_QUERIES=2 TAVILY_MAX_CANDIDATES=3 DISCOVERY_OUTPUT=.cache/live-preview.json npm run discover
unset TAVILY_API_KEY
SITE_DATA=.cache/live-preview.json npm run build
npm run preview
```

This uses Tavily credits, runs the local model, and writes a preview dataset. It does not modify the repository opportunity file or deploy anything. New checkpoints can be reused within 48 hours; if you specifically need a completely fresh search after a local live run, rename `.cache/discovery.json` before repeating it.

## 8. Rebuild from repository data and review

```bash
npm run build
git diff --check
git status --short
git diff -- data/opportunities.json
git diff -- .github/workflows/discover.yml
```

The live opportunity file should be unchanged after replay/preview-only tests. `.cache/`, model weights and `site/` should not appear as untracked changes. Inspect `docs/MODEL_EVALUATION.md` and the implementation before committing.

## Activation after testing

These are one-time activation steps, intentionally not performed by local tests:

1. Commit the reviewed changes on `dev` and push **that branch**. A push triggers a static validation/build/deployment attempt; it does not run Tavily/model discovery. If Pages currently blocks `dev`, that deployment will wait/fail until the environment permits it.
2. In GitHub repository Settings → Branches (or the default-branch setting shown in your GitHub UI), change the default branch to `dev`. This leaves the old `main` branch's code untouched.
3. Set Settings → Pages → Build and deployment → Source to **GitHub Actions**.
4. In Settings → Environments → `github-pages`, allow deployments from `dev` and ensure no required reviewer prevents unattended scheduled publishing. Apply the policy appropriate for this repository.
5. Ensure Actions is enabled, the `TAVILY_API_KEY` Actions secret exists, and repository policies permit the workflow's contents-write and Pages permissions. Gemini secrets are unused.
6. Confirm the `Discover and deploy dev` workflow is enabled. Tuesday 06:17 Pacific runs will automatically download/restore the model, run real-model regression tests, discover opportunities, validate data, commit to `dev`, and publish in the same workflow. There is no dependency on an automated commit triggering another workflow.

A manual full discovery run is available as an optional initial check; ongoing Tuesday runs require no manual action. GitHub can delay schedules, and public repositories with 60 days of inactivity can have schedules disabled by GitHub. See [GitHub scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

A failed run preserves the previous published site. Its Actions logs and diagnostic report artifacts explain the failure. The next Tuesday starts fresh search work once old checkpoints exceed 48 hours.

## Website profile saves

See [PROFILE_SAVING.md](PROFILE_SAVING.md) for authenticated repository saves and background discovery. Offline tests mock GitHub; clicking Save with a real token from a local preview affects the remote repository after the new workflow is activated.
