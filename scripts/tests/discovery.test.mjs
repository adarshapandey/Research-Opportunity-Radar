import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDiscoveryQueries,
  canonicalizeUrl,
  deduplicateSearchResults
} from "../discovery-queries.mjs";
import { mergeOpportunities, validateOpportunity } from "../lib/opportunity-store.mjs";
import { runDiscovery } from "../discover.mjs";
import { parseDeadline } from '../lib/deadlines.mjs';
import { groundRecords, extractOpportunitiesLocally, runLocalModel } from '../providers/local-model.mjs';
import { publicDataset, buildSite } from '../build-site.mjs';
import { nextMilestone, escapeHTML, readStored } from '../../radar-utils.js';
import { readdir, chmod } from 'node:fs/promises';

const profile = {
  research_areas: ["Computer Vision", "Medical Imaging", "Remote Sensing", "Foundation Models"],
  current_projects: ["UAV multimodal sensing"],
  keywords: ["LiDAR", "uncertainty"]
};

test("profile-derived queries are open-ended and respect the budget", () => {
  const queries = buildDiscoveryQueries(profile, 6, new Date("2026-09-27T00:00:00Z"));
  assert.equal(queries.length, 6);
  assert.match(queries.join(" "), /Medical Imaging|Remote Sensing|Foundation Models|Computer Vision/i);
  assert.ok(queries.every(query => query.includes("2026 2027")));
});

test("URL canonicalization and Tavily-result deduplication remove tracking duplicates", () => {
  assert.equal(
    canonicalizeUrl("https://www.example.org/cfp/?utm_source=test#dates"),
    "example.org/cfp"
  );
  const results = deduplicateSearchResults([
    { title: "CFP", url: "https://example.org/cfp?utm_source=a", content: "short", score: 0.5, discovery_query: "one" },
    { title: "CFP", url: "https://www.example.org/cfp/", raw_content: "a much longer official source", score: 0.8, discovery_query: "two" }
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].content, "a much longer official source");
  assert.deepEqual(results[0].discovery_queries, ["one", "two"]);
});

function opportunity(overrides = {}) {
  return {
    id: "model-id",
    title: "Example Vision Workshop 2027",
    type: "workshop",
    type_label: "Independent workshop",
    year: 2027,
    organization: 'Example workshop',
    topics: ['Computer Vision'],
    location: { city: 'Unknown', country: 'Unknown', virtual: false },
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: "2026-11-08T23:59:00-12:00",
      timezone: "UTC-12",
      timezone_label: "Anywhere on Earth",
      original_text: "November 8, 2026, 11:59 PM AoE",
      evidence: "The official page states the submission deadline."
    }],
    source: { url: "https://example.org/official-cfp", type: "Official CFP", evidence: "The page states the paper deadline." },
    relevance: { level: "high", label: "Strong match", matched_topics: ["computer vision"], reason: "Matches the profile." },
    ...overrides
  };
}

test("merge matches deterministic identity, detects paper changes, and skips duplicate outputs", () => {
  const existing = [opportunity({
    id: "existing-workshop",
    source: { url: "https://old.example.org/event", evidence: "Old evidence" },
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: "2026-11-01T23:59:00-12:00",
      timezone: "UTC-12",
      original_text: "November 1, 2026, 11:59 PM AoE",
      evidence: "The old official page stated the submission deadline."
    }]
  })];
  const duplicate = opportunity({ source: { url: "https://example.net/other-page", type: "Official CFP", evidence: "Duplicate page" } });
  const allowed = new Set([canonicalizeUrl("https://example.org/official-cfp"), canonicalizeUrl("https://example.net/other-page")]);
  const result = mergeOpportunities(existing, [opportunity(), duplicate], "2026-09-27T12:00:00Z", allowed);

  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].id, "existing-workshop");
  assert.equal(result.opportunities[0].updated, true);
  assert.equal(result.stats.updatedRecords, 1);
  assert.equal(result.stats.duplicates, 1);

  const repeated = mergeOpportunities(result.opportunities, [opportunity()], "2026-09-27T12:05:00Z", allowed);
  assert.equal(repeated.opportunities.length, 1);
  assert.equal(repeated.opportunities[0].id, "existing-workshop");
});

test("validation rejects invented sources, invalid timezones, and datetimes without offsets", () => {
  const invalid = opportunity({
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: "2026-11-08T23:59:00",
      timezone: "Moon/Base",
      original_text: "November 8",
      evidence: "The page says November 8."
    }]
  });
  const errors = validateOpportunity(invalid, new Set([canonicalizeUrl("https://different.example/cfp")]));
  assert.ok(errors.includes("milestone datetime lacks explicit offset"));
  assert.ok(errors.includes("invalid milestone timezone"));
  assert.ok(errors.includes("source was not supplied by Tavily"));
});

test("validation requires evidence for each milestone", () => {
  const missingEvidence = opportunity();
  delete missingEvidence.milestones[0].evidence;
  const errors = validateOpportunity(
    missingEvidence,
    new Set([canonicalizeUrl("https://example.org/official-cfp")])
  );
  assert.ok(errors.includes("missing milestone evidence"));
});

test("validation accepts bare numeric timezone offsets on every supported Node version", () => {
  const withBareOffset = opportunity({
    milestones: [{
      type: "paper_submission",
      label: "Paper submission",
      datetime: "2026-11-08T23:59:00-12:00",
      timezone: "-12:00",
      timezone_label: "Anywhere on Earth",
      original_text: "November 8, 2026, 11:59 PM AoE",
      evidence: "The official page states the submission deadline."
    }]
  });
  const errors = validateOpportunity(
    withBareOffset,
    new Set([canonicalizeUrl("https://example.org/official-cfp")])
  );
  assert.deepEqual(errors, []);
});


const quietLogger = { log() {}, warn() {}, error() {} };
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'radar-local-test-'));
  await mkdir(join(root,'data'));
  await writeFile(join(root,'data/profile.json'),JSON.stringify(profile));
  await writeFile(join(root,'data/opportunities.json'),JSON.stringify({ generated_at:'2026-09-01T00:00:00Z',data_mode:'live',opportunities:[] }));
  return root;
}
const source = { title:'Example Vision Workshop 2027', url:'https://example.org/official-cfp', raw_content:'Example Vision Workshop 2027 covers Computer Vision. Paper submission deadline: November 8, 2026, 11:59 PM AoE.', score:1 };
const fixedNow = () => new Date('2026-09-27T12:00:00Z');
const readData = async root => JSON.parse(await readFile(join(root,'data/opportunities.json'),'utf8'));
const options = root => ({root,env:{TAVILY_API_KEY:'test',TAVILY_MAX_QUERIES:'1'},now:fixedNow,logger:quietLogger,search:async () => ({results:[source]})});

test('explicit evidence dates normalize AoE, UTC and offsets', () => {
  assert.equal(parseDeadline('November 8, 2026, 11:59 PM AoE').datetime,'2026-11-08T23:59:00-12:00');
  assert.equal(parseDeadline('8 December 2026 at 17:00 UTC+01:00').datetime,'2026-12-08T17:00:00+01:00');
  assert.equal(parseDeadline('2026-12-08T17:00:00Z').datetime,'2026-12-08T17:00:00+00:00');
});

test('ambiguous, invalid and incomplete source deadlines are rejected', () => {
  for (const text of ['November 8, 2026 AoE','November 8, 2026 11:59 PM','February 30, 2026 17:00 UTC','November 8, 2026 17:00 CST','November 8, 2026 17:00 UTC+15','November 8, 2026 17:00 UTC and November 9, 2026 17:00 UTC']) assert.equal(parseDeadline(text),null,text);
});

test('grounding rejects fabricated evidence and unrelated source topics', () => {
  const candidate = {...source,content:source.raw_content};
  const raw = {title:source.title,type:'workshop',year:2027,organization:'Made up',topics:['Computer Vision','Invented'],milestones:[{type:'paper_submission',evidence:'Paper submission deadline: November 8, 2026, 11:59 PM AoE.'}]};
  const [record] = groundRecords([raw],candidate,profile);
  assert.equal(record.milestones[0].datetime,'2026-11-08T23:59:00-12:00');
  assert.equal(record.organization,'See source');
  assert.deepEqual(record.topics,['Computer Vision']);
  assert.equal(groundRecords([{...raw,milestones:[{type:'paper_submission',evidence:'November 9, 2026, 11:59 PM AoE'}]}],candidate,profile).length,0);
  assert.equal(groundRecords([raw],candidate,{research_areas:['Astronomy']}).length,0);
});

test('split model records consolidate milestones without dropping a submission deadline', () => {
  const evidence = 'Abstract submission: November 1, 2026, 17:00 UTC. Paper submission: November 8, 2026, 17:00 UTC.';
  const candidate = {...source,content:`${source.title} Computer Vision. ${evidence}`};
  const raw = {title:source.title,type:'workshop',year:2027,organization:'Unknown',topics:['Computer Vision']};
  const records = groundRecords([
    {...raw,milestones:[{type:'abstract_submission',evidence:'Abstract submission: November 1, 2026, 17:00 UTC.'}]},
    {...raw,milestones:[{type:'paper_submission',evidence:'Paper submission: November 8, 2026, 17:00 UTC.'}]}
  ],candidate,profile);
  assert.equal(records.length,1);
  assert.equal(records[0].milestones.length,2);
});

test('different opportunities sharing an event page remain separate', () => {
  const first = opportunity();
  const second = opportunity({title:'Another Vision Workshop 2027'});
  const result = mergeOpportunities([], [first,second], '2026-09-27T00:00:00Z');
  assert.equal(result.opportunities.length,2);
});

test('extractor rejects malformed output without accepting arbitrary fields', async () => {
  await assert.rejects(extractOpportunitiesLocally({candidate:{...source,content:source.raw_content},profile,currentDate:'2026-09-27',infer:async()=>({opportunities:'bad'})}),/lacks opportunities/);
});

test('local discovery caches sources before extraction and persists valid updates', async () => {
  const root = await workspace();
  const report = await runDiscovery({...options(root),extract:async()=>{
    await access(join(root,'.cache/discovery.json'));
    return {opportunities:[opportunity()]};
  }});
  assert.equal(report.accepted,1);
  assert.equal((await readData(root)).opportunities.length,1);
});

test('total inference failure preserves the original dataset byte for byte', async () => {
  const root = await workspace();
  const before = await readFile(join(root,'data/opportunities.json'),'utf8');
  await assert.rejects(runDiscovery({...options(root),extract:async()=>{throw new Error('timeout')}}),/Every inference/);
  assert.equal(await readFile(join(root,'data/opportunities.json'),'utf8'),before);
  await access(join(root,'.cache/discovery.json'));
});

test('partial inference failure preserves success and retries only failed sources', async () => {
  const root = await workspace();
  const search = async()=>({results:[source,{...source,url:'https://example.org/other',title:'Other workshop'}]});
  let calls=0;
  await runDiscovery({...options(root),search,extract:async()=>{if (++calls===2) throw new Error('timeout');return {opportunities:[opportunity()]}}});
  assert.equal((await readData(root)).opportunities.length,1);
  calls=0;
  await runDiscovery({...options(root),search:async()=>{throw new Error('must use cache')},extract:async()=>{calls++;return {opportunities:[]}}});
  assert.equal(calls,1);
});

test('weekly discovery expires stale checkpoints instead of starving new searches', async () => {
  const root = await workspace();
  await runDiscovery({...options(root),extract:async()=>({opportunities:[]})});
  let searches=0;
  await runDiscovery({...options(root),now:()=>new Date('2026-10-04T12:00:00Z'),search:async()=>{searches++;return {results:[source]}},extract:async()=>({opportunities:[]})});
  assert.equal(searches,1);
});

test('fixture replay does not overwrite live data or make search requests', async () => {
  const root = await workspace();
  const before = await readFile(join(root,'data/opportunities.json'),'utf8');
  await writeFile(join(root,'fixture.json'),JSON.stringify({candidates:[source]}));
  await runDiscovery({...options(root),env:{DISCOVERY_INPUT:'fixture.json'},search:async()=>{throw new Error('no network')},extract:async()=>({opportunities:[opportunity()]})});
  assert.equal(await readFile(join(root,'data/opportunities.json'),'utf8'),before);
  await access(join(root,'.cache/preview-opportunities.json'));
});

test('Tavily failure preserves existing data', async () => {
  const root = await workspace();
  const before = await readFile(join(root,'data/opportunities.json'),'utf8');
  await assert.rejects(runDiscovery({...options(root),search:async()=>{throw new Error('offline')}}),/No usable sources/);
  assert.equal(await readFile(join(root,'data/opportunities.json'),'utf8'),before);
});

test('frontend picks the earliest future milestone and excludes expired records', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const op = opportunity({milestones:[{type:'paper_submission',datetime:'2026-11-20T23:59:00Z'},{type:'abstract_submission',datetime:'2026-11-10T23:59:00Z'}]});
  assert.equal(nextMilestone(op,now).type,'abstract_submission');
  assert.equal(nextMilestone(op,new Date('2026-12-01')),null);
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.deepEqual(readStored({getItem:()=>'{broken'},'key',[],Array.isArray),[]);
});

test('validation handles malformed model fields without throwing', () => {
  for (const value of [null,[],{...opportunity(),milestones:{}},{...opportunity(),milestones:[null]},{...opportunity(),source:{url:42}},{...opportunity(),relevance:{}}]) assert.ok(validateOpportunity(value).length);
});

test('deployment rejects broken schemas and excludes demo entries', () => {
  const good = {...opportunity(),source:{...opportunity().source,last_verified:'2026-09-27T00:00:00Z'}};
  const demo = {...good,id:'demo',source:{...good.source,evidence:'Demonstration record'}};
  const data = {generated_at:'2026-09-27T00:00:00Z',opportunities:[good,demo]};
  assert.equal(publicDataset(data).opportunities.length,1);
  assert.throws(()=>publicDataset({...data,opportunities:[{...good,location:null}]}),/location/);
  assert.throws(()=>publicDataset({...data,opportunities:[good,good]}),/duplicate/);
});

test('static build contains only public assets, no model, checkpoint or scripts', async () => {
  const root = await workspace();
  for (const file of ['index.html','app.js','styles.css','radar-utils.js','profile-utils.js','github-profile.js']) await writeFile(join(root,file),'test');
  const good = {...opportunity(),source:{...opportunity().source,last_verified:'2026-09-27T00:00:00Z'}};
  await writeFile(join(root,'data/opportunities.json'),JSON.stringify({generated_at:'2026-09-27T00:00:00Z',opportunities:[good]}));
  await mkdir(join(root,'site'));
  await writeFile(join(root,'site/model.gguf'),'should not survive rebuild');
  await buildSite(root);
  assert.deepEqual((await readdir(join(root,'site'))).sort(),['.nojekyll','app.js','data','github-profile.js','index.html','profile-utils.js','radar-utils.js','styles.css']);
  assert.deepEqual((await readdir(join(root,'site/data'))).sort(),['opportunities.json','profile.json']);
});


test('real model child process is killed on timeout and errors omit source prompts', async () => {
  const root = await workspace();
  const binary = join(root,'slow-model');
  await writeFile(binary,'#!/usr/bin/env python3\nimport time\ntime.sleep(5)\n');
  await chmod(binary,0o755);
  const started = Date.now();
  await assert.rejects(runLocalModel({prompt:'private source marker',env:{RADAR_LLAMA_CLI:binary,LOCAL_MODEL_TIMEOUT_MS:'200'}}),error=> /timed out/.test(error.message) && !error.message.includes('private source marker'));
  assert.ok(Date.now()-started < 3000);
});
