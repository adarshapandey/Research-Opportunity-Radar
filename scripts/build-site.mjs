import { readFile, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOpportunity } from './lib/opportunity-store.mjs';

export function publicDataset(data) {
  if (!Array.isArray(data.opportunities) || Number.isNaN(Date.parse(data.generated_at))) throw new Error('Invalid dataset envelope.');
  const opportunities = data.opportunities.filter(op => !/demonstration/i.test(op.source?.evidence || ''));
  if (!opportunities.length) throw new Error('Refusing to publish an empty dataset.');
  if (opportunities.length > 500) throw new Error('Dataset exceeds 500-record browser budget.');
  const ids = new Set();
  for (const op of opportunities) {
    const errors = validateOpportunity(op);
    if (typeof op.id !== 'string' || !/^[a-z0-9-]+$/.test(op.id) || ids.has(op.id)) errors.push('invalid/duplicate ID');
    if (Number.isNaN(Date.parse(op.source?.last_verified))) errors.push('invalid verification timestamp');
    if (errors.length) throw new Error(`${op.title}: ${errors.join(', ')}`);
    ids.add(op.id);
  }
  const output = { generated_at: data.generated_at, data_mode: 'live', opportunities };
  if (Buffer.byteLength(JSON.stringify(output)) > 2 * 1024 * 1024) throw new Error('Dataset exceeds 2 MB browser budget.');
  return output;
}

export async function buildSite(root = process.cwd(), input = process.env.SITE_DATA || 'data/opportunities.json') {
  const dataset = publicDataset(JSON.parse(await readFile(resolve(root,input),'utf8')));
  const profile = JSON.parse(await readFile(join(root,'data/profile.json'),'utf8'));
  if (!['research_areas','current_projects','keywords'].every(key => Array.isArray(profile[key]) && profile[key].every(v => typeof v === 'string'))) throw new Error('Invalid public profile.');
  const destination = join(root,'site');
  await rm(destination, { recursive:true, force:true });
  await mkdir(join(destination,'data'), { recursive:true });
  // Explicit allowlist: no models, scripts, keys, profiles-in-cache, or checkpoints.
  for (const file of ['index.html','app.js','styles.css','radar-utils.js','profile-utils.js','github-profile.js']) await copyFile(join(root,file),join(destination,file));
  await copyFile(join(root,'data/profile.json'),join(destination,'data/profile.json'));
  await writeFile(join(destination,'data/opportunities.json'),JSON.stringify(dataset));
  await writeFile(join(destination,'.nojekyll'),'');
  console.log(`Staged ${dataset.opportunities.length} validated opportunities in site/.`);
  return dataset;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSite().catch(error => { console.error(error.message); process.exitCode = 1; });
}
