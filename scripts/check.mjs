import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await check(path);
    else if (/\.(mjs|js)$/.test(entry.name)) execFileSync(process.execPath, ['--check',path],{stdio:'inherit'});
  }
}
for (const file of ['app.js','radar-utils.js','profile-utils.js','github-profile.js']) execFileSync(process.execPath, ['--check',file],{stdio:'inherit'});
await check('scripts');
console.log('JavaScript syntax checks passed.');
