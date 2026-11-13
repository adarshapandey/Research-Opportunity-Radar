import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { escapeHTML, nextMilestone, readStored, formatScanAge } from '../../radar-utils.js';
import { publicDataset } from '../build-site.mjs';

test('frontend loads the published data, opens closed details and escapes search input without inference', async () => {
  const data = publicDataset(JSON.parse(await readFile(new URL('../../data/opportunities.json',import.meta.url),'utf8')));
  const profile = JSON.parse(await readFile(new URL('../../data/profile.json',import.meta.url),'utf8'));
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key,{textContent:'',innerHTML:'',hidden:false,style:{},classList:{toggle() {},add() {},remove() {}},focus(){}});
    return nodes.get(key);
  };
  node('#profile-form').areas={};node('#profile-form').projects={};node('#profile-form').keywords={};
  const requests=[],errors=[];
  let pendingSave,finishSave;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-13T20:00:00Z'])); } }
  const context = vm.createContext({
    h:escapeHTML,nextMilestone,readStored,formatScanAge,Date:Clock,Intl,AbortController,
    saveProfileAndRun:options=>{pendingSave=options;options.onStatus({message:'Profile saved. Discovering opportunities…',runURL:'https://github.com/adarshapandey/Research-Opportunity-Radar/actions/runs/123'});return new Promise(resolve=>{finishSave=resolve})},
    document:{querySelector:node,querySelectorAll:()=>[],body:{style:{}},addEventListener(){}},
    window:{addEventListener(){},scrollTo(){}},location:{hash:''},
    localStorage:{getItem:()=>'{bad-json',setItem(){}},
    setTimeout:()=>0,clearTimeout(){},console:{error:e=>errors.push(e)},
    fetch:async url=>{requests.push(url);return {json:async()=>url.includes('opportunities') ? data : profile}}
  });
  const code=(await readFile(new URL('../../app.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'');
  await vm.runInContext(code,context);
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests,['data/opportunities.json','data/profile.json']);
  assert.equal(node('#hero-title').textContent.includes('ICLR'),false);
  assert.equal(node('#discovery-count').textContent,data.opportunities.filter(o=>o.discovered).length);
  vm.runInContext('openDetails("iclr-2027")',context);
  assert.match(node('#detail-content').innerHTML,/No upcoming milestones/);
  vm.runInContext('renderSearch("<img src=x onerror=alert(1)>")',context);
  assert.ok(!node('#search-results').innerHTML.includes('<img'));
  assert.match(node('#search-results').innerHTML,/&lt;img/);
  vm.runInContext('toggleWatch("iclr-2027")',context);
  assert.match(node('#watchlist-grid').innerHTML,/ICLR/);
  node('#github-token').value='test-token';
  const saving=vm.runInContext('document.querySelector("#profile-form").onsubmit({preventDefault(){}})',context);
  assert.equal(node('#profile-save').disabled,true);
  assert.equal(node('#profile-fields').disabled,true);
  assert.equal(node('#github-token').value,'');
  assert.equal(pendingSave.token,'test-token');
  assert.match(node('#profile-status').textContent,/Discovering/);
  assert.equal(node('#profile-run-link').hidden,false);
  finishSave({profile:{research_areas:['Astronomy'],current_projects:[],keywords:[]}});
  await saving;
  assert.equal(node('#profile-save').disabled,false);
  assert.match(node('#profile-status').textContent,/saved and radar published/);
});
