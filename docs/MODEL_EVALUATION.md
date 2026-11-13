# Local model evaluation

Measured on November 13, 2026 using Qwen2.5-3B-Instruct Q4_K_M, llama.cpp b6000, CPU only, four inference threads, context 8,192 tokens and temperature zero. Weights and runtime match scripts/model-config.json. These are development-machine measurements, not measurements from a GitHub runner.

## Labeled regression cases

The evaluation checks event title, type and event year for positive cases, as well as every expected milestone type/datetime and negative-case abstention. Source-grounding code is part of the evaluated pipeline. A raw small-model answer is not accepted without validation.

| Case | Elapsed | Result |
| --- | --- | --- |
| vision | 16.0 s | Pass |
| learning | 17.6 s | Pass |
| remote | 14.9 s | Pass |
| missing-time | 13.4 s | Pass |
| missing-zone | 14.0 s | Pass |
| event-only | 26.9 s | Pass |

The six cases cover AoE, an abstract plus paper deadline, UTC+01:00, missing time, missing timezone, and an event date with no submission deadline. This small fixture suite is a regression gate, not a general accuracy estimate. Re-run with npm run model:evaluate on your machine.

## Real cached-source observations

Three captured Tavily pages were replayed. The two HTTPS pages took approximately 80 and 63 seconds and produced no accepted milestones. The HTTP-only page was skipped because accepted records require HTTPS. These pages do not establish positive real-world recall. The AAAI page states dates and AoE but lacks explicit submission times, so the current rules intentionally omit those deadlines.

An earlier attempt to process the HTTP aggregator spent three minutes before timing out. The extractor now skips HTTP-only candidates before inference; all other per-page inference requests have a three-minute kill timeout. Failures are summarized without dumping source prompts or runtime internals.

The initial development evaluation checked dates alone and missed generic event names emitted by the model. Evaluation now also checks event identity. Grounding prefers a verbatim event header when the page explicitly names an event/year and rejects generic names without informative overlap with the page title. Split records for a single event are consolidated before merging.

## End-to-end replay

A final real-model replay of the two positive vision/learning sources accepted exactly two events. The learning event retained its 2027 identity and both abstract/paper milestones. Building from that preview dataset passed validation and staged nine records (seven existing public records plus two test events). The source opportunity file was unchanged, and the public build was then restored to the seven repository records.

## Practical limits

- Large pages can take a minute or more on CPU; the weekly job may take tens of minutes. No model runs on the website, and the existing published site remains available during the job.
- A source needs an explicit supported date, year, time and timezone. Date-only deadlines, ambiguous zones, unsupported formats and incomplete excerpts are omitted.
- Relevance uses literal profile-term matches and can miss synonyms.
- The model can miss opportunities or choose incorrect milestone labels. Source excerpts and label/date checks reduce risk but cannot prove semantic accuracy.
- Live Tavily calls, the scheduled GitHub runner, repository permissions and actual Pages deployment were not exercised during development. Local replay does not spend Tavily credits.

The model is a tested starting point for conservative extraction, not a claim of parity with Gemini. Broader labeled examples from actual target conference sites are needed before making stronger accuracy claims.
