import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractOpportunitiesLocally } from './providers/local-model.mjs';
import { writeJsonAtomic } from './discover.mjs';

const fixture = process.env.MODEL_EVAL_INPUT || 'scripts/fixtures/extraction.json';
const fixtures = JSON.parse(await readFile(fixture,'utf8'));
const { candidates } = fixtures;
// Regression fixtures must not depend on the user's changing research interests.
const profile = fixtures.profile || JSON.parse(await readFile('data/profile.json','utf8'));
const results = [];
for (const candidate of candidates.slice(0, Number(process.env.MODEL_EVAL_LIMIT) || candidates.length)) {
  const started = Date.now();
  let opportunities = [], error;
  try { ({ opportunities } = await extractOpportunitiesLocally({ candidate, profile, currentDate:'2026-11-13', env:process.env })); }
  catch (failure) { error = failure.message; }
  const actual = opportunities.flatMap(op => op.milestones.map(m => ({type:m.type,datetime:m.datetime})));
  const expected = candidate.expected;
  const identityPass = !candidate.expected_event || (opportunities.length === 1 && ['title','type','year'].every(key => opportunities[0][key] === candidate.expected_event[key]));
  const pass = error ? false : expected === undefined ? null : identityPass && actual.length === expected.length && expected.every(e => actual.some(a => a.type === e.type && Date.parse(a.datetime) === Date.parse(e.datetime)));
  const row = { ...(error ? {error} : {}), url:candidate.url, duration_ms:Date.now()-started, pass, events:opportunities.map(({title,type,year})=>({title,type,year})), actual, ...(expected ? { expected } : {}) };
  results.push(row);
  await writeJsonAtomic(process.env.MODEL_EVAL_INPUT ? '.cache/cached-model-evaluation.json' : '.cache/model-evaluation.json', { model:'Qwen2.5-3B-Instruct-Q4_K_M', runtime:'llama.cpp b6000 CPU', recorded_at:new Date().toISOString(), fixture, results });
  console.log(`${pass === null ? 'OBSERVED' : pass ? 'PASS' : 'FAIL'} ${row.duration_ms} ms ${candidate.url}: ${actual.length} milestones`);
}
const report = { model:'Qwen2.5-3B-Instruct-Q4_K_M', runtime:'llama.cpp b6000 CPU', recorded_at:new Date().toISOString(), fixture:resolve(fixture), results };
await writeJsonAtomic(process.env.MODEL_EVAL_INPUT ? '.cache/cached-model-evaluation.json' : '.cache/model-evaluation.json',report);
if (results.some(r => r.pass === false)) process.exitCode = 1;
