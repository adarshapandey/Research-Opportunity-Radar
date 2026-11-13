import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { formatScanAge } from '../../radar-utils.js';
import { validateProfileChanges,matchStoredOpportunity } from '../../profile-utils.js';
import { saveProfileAndRun } from '../../github-profile.js';
import { applyProfile } from '../apply-profile.mjs';

test('scan age switches at exactly 24 hours and floors whole days', () => {
  const start = '2026-11-01T00:00:00Z';
  for (const [hours,label] of [[0,'less than an hour ago'],[1,'1 hour ago'],[23.99,'23 hours ago'],[24,'1 day ago'],[36,'1 day ago'],[48,'2 days ago'],[71.9,'2 days ago']]) {
    assert.equal(formatScanAge(start,new Date(Date.parse(start)+hours*3600000)),label);
  }
});

const changes={research_areas:['Astronomy'],current_projects:['Stellar imaging'],keywords:['spectroscopy']};
test('profile validation limits input and strips unrelated fields', () => {
  assert.deepEqual(validateProfileChanges({...changes,name:'overwrite',research_areas:[' Astronomy ','Astronomy']}),changes);
  assert.throws(()=>validateProfileChanges({...changes,research_areas:[]}),/research area/);
  assert.throws(()=>validateProfileChanges({...changes,keywords:['x'.repeat(201)]}),/200/);
});

test('old opportunities are reclassified against the changed profile', () => {
  const op={title:'Vision Conference',topics:['Computer Vision'],source:{evidence:'Vision papers'}};
  assert.equal(matchStoredOpportunity(op,changes).matches_profile,false);
  assert.equal(matchStoredOpportunity(op,{...changes,research_areas:['Computer Vision']}).matches_profile,true);
});

const reply=(data,status=200)=>({ok:status<400,status,json:async()=>data});
function githubMock({failure=false,staleRuns=false}={}) {
  const calls=[];
  let polls=0;
  return {calls,fetch:async(url,options)=>{
    calls.push({url,options});
    if (url.includes('/contents/')) return reply({sha:'a'.repeat(40)});
    if (url.endsWith('/dispatches')) return reply(null,204);
    if (url.includes('/runs?')) return reply({workflow_runs:[
      {id:99,display_title:'Profile update unrelated',status:'completed',conclusion:'success'},
      ...(!staleRuns || ++polls>1 ? [{id:123,display_title:'Profile update test-request',status:'in_progress'}] : [])
    ]});
    if (url.endsWith('/jobs')) return reply({jobs:[{steps:[{name:'Commit research profile',conclusion:'success'}]}]});
    return reply({id:123,status:'completed',conclusion:failure?'failure':'success'});
  }};
}
test('save dispatches exactly one correlated run and monitors through publication', async () => {
  const mock=githubMock({staleRuns:true}),statuses=[];
  const result=await saveProfileAndRun({token:'test-token',changes,requestId:'test-request',fetchImpl:mock.fetch,sleep:async()=>{},onStatus:s=>statuses.push(s),maxPolls:5});
  assert.equal(result.runURL,'https://github.com/adarshapandey/Research-Opportunity-Radar/actions/runs/123');
  const posts=mock.calls.filter(c=>c.options.method==='POST');
  assert.equal(posts.length,1);
  const body=JSON.parse(posts[0].options.body);
  assert.equal(body.ref,'dev');
  assert.equal(body.inputs.profile_base_sha,'a'.repeat(40));
  assert.deepEqual(JSON.parse(body.inputs.profile_json),changes);
  assert.ok(!posts[0].options.body.includes('test-token'));
  assert.equal(statuses.at(-1).phase,'complete');
});
test('pipeline failure reports that the profile commit already succeeded', async () => {
  const mock=githubMock({failure:true});
  await assert.rejects(saveProfileAndRun({token:'test-token',changes,requestId:'test-request',fetchImpl:mock.fetch,sleep:async()=>{}}),error=>error.profileSaved===true && /Profile saved, but/.test(error.message));
});
test('denied authentication does not dispatch or retry mutations', async () => {
  let calls=0;
  await assert.rejects(saveProfileAndRun({token:'bad-token',changes,fetchImpl:async()=>{calls++;return reply({},403)}}),/403/);
  assert.equal(calls,1);
});
test('a lost dispatch response reports uncertainty and does not automatically resubmit', async () => {
  let posts=0;
  await assert.rejects(saveProfileAndRun({token:'test-token',changes,fetchImpl:async(url,options)=>{
    if (options.method==='POST') {posts++;throw new TypeError('Failed to fetch');}
    return reply({sha:'a'.repeat(40)});
  }}),error=> /may have received/.test(error.message) && Boolean(error.runURL));
  assert.equal(posts,1);
});
test('closing progress stops monitoring, without cancelling the workflow', async () => {
  const mock=githubMock(),controller=new AbortController();
  await assert.rejects(saveProfileAndRun({token:'test-token',changes,requestId:'test-request',signal:controller.signal,fetchImpl:mock.fetch,sleep:async()=>controller.abort()}),{name:'AbortError'});
  assert.equal(mock.calls.filter(c=>c.options.method==='POST').length,1);
  assert.equal(mock.calls.some(c=>c.url.includes('/cancel')),false);
});

test('workflow profile writer preserves metadata and rejects stale queued changes', async () => {
  const root=await mkdtemp(join(tmpdir(),'radar-profile-test-'));
  await mkdir(join(root,'data'));
  const path=join(root,'data/profile.json');
  await writeFile(path,JSON.stringify({name:'Adarsha',initials:'AP',...changes}));
  execFileSync('git',['init','--quiet'],{cwd:root});
  execFileSync('git',['add','data/profile.json'],{cwd:root});
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.org','commit','--quiet','-m','fixture'],{cwd:root});
  const sha=execFileSync('git',['rev-parse','HEAD:data/profile.json'],{cwd:root,encoding:'utf8'}).trim();
  await assert.rejects(applyProfile({root,env:{PROFILE_JSON:JSON.stringify(changes),PROFILE_BASE_SHA:'b'.repeat(40)}}),/changed while/);
  await applyProfile({root,env:{PROFILE_JSON:JSON.stringify({...changes,name:'do not overwrite',keywords:['LiDAR']}),PROFILE_BASE_SHA:sha}});
  const saved=JSON.parse(await readFile(path,'utf8'));
  assert.equal(saved.name,'Adarsha');assert.equal(saved.initials,'AP');assert.deepEqual(saved.keywords,['LiDAR']);
});
