import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfileChanges } from '../profile-utils.js';
import { writeJsonAtomic } from './discover.mjs';

export async function applyProfile({ root = process.cwd(), env = process.env } = {}) {
  if (!env.PROFILE_JSON) return false;
  const changes = validateProfileChanges(JSON.parse(env.PROFILE_JSON));
  if (!/^[a-f0-9]{40}$/.test(env.PROFILE_BASE_SHA || '')) throw new Error('A valid base profile revision is required.');
  const revision = execFileSync('git',['rev-parse','HEAD:data/profile.json'],{cwd:root,encoding:'utf8'}).trim();
  if (revision !== env.PROFILE_BASE_SHA) throw new Error('Profile changed while this update was queued. Reload the profile and save again.');
  const path = resolve(root,'data/profile.json');
  const current = JSON.parse(await readFile(path,'utf8'));
  await writeJsonAtomic(path,{...current,...changes});
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyProfile().catch(error => { console.error(error.message); process.exitCode = 1; });
}
