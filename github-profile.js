import { validateProfileChanges } from './profile-utils.js';

// Public repository coordinates, never credentials. Update these when forking.
export const githubRepository = { owner:'adarshapandey', repo:'Research-Opportunity-Radar', branch:'dev', workflow:'discover.yml' };
const pause = (ms, signal) => new Promise((resolve,reject) => {
  const stop = () => { clearTimeout(timer); reject(new DOMException('Stopped watching', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort',stop); resolve(); },ms);
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort',stop,{once:true});
});

export async function saveProfileAndRun({ token, changes, onStatus = () => {}, signal, fetchImpl = fetch, sleep = pause, requestId = crypto.randomUUID(), maxPolls = 420 }) {
  const profile = validateProfileChanges(changes);
  if (!token?.trim()) throw new Error('Enter a GitHub token to save the repository profile.');
  const { owner,repo,branch,workflow } = githubRepository;
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const actionsURL = `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`;
  let profileSaved = false, dispatched = false, dispatchAttempted = false, runURL = actionsURL;
  const request = async (path, options = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      ...options, signal:AbortSignal.any([signal,AbortSignal.timeout(30000)].filter(Boolean)), cache:'no-store',
      headers:{ Accept:'application/vnd.github+json', Authorization:`Bearer ${token.trim()}`, 'X-GitHub-Api-Version':'2022-11-28', ...(options.body ? {'Content-Type':'application/json'} : {}) }
    });
    if (!response.ok) {
      const error = new Error(`GitHub request failed (${response.status}). Check repository access and token permissions.`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
  try {
    onStatus({ phase:'saving', message:'Checking the repository profile…' });
    const file = await request(`/contents/data/profile.json?ref=${branch}`);
    if (!/^[a-f0-9]{40}$/.test(file.sha)) throw new Error('GitHub returned an invalid profile revision.');
    onStatus({ phase:'saving', message:'Requesting profile save and radar update…' });
    dispatchAttempted = true;
    await request(`/actions/workflows/${workflow}/dispatches`, { method:'POST', body:JSON.stringify({
      ref:branch, inputs:{run_discovery:'true', profile_json:JSON.stringify(profile), profile_base_sha:file.sha, request_id:requestId}
    }) });
    dispatched = true;
    let runId;
    for (let poll = 0; poll < maxPolls; poll++) {
      signal?.throwIfAborted();
      let run;
      if (!runId) {
        const listing = await request(`/actions/workflows/${workflow}/runs?branch=${branch}&event=workflow_dispatch&per_page=100`);
        run = listing.workflow_runs?.find(r => r.display_title === `Profile update ${requestId}`);
        if (run) {
          if (!Number.isSafeInteger(run.id) || run.id < 1) throw new Error('GitHub returned an invalid workflow run.');
          runId = run.id;
          runURL = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
        }
      } else run = await request(`/actions/runs/${runId}`);
      if (!run) onStatus({phase:'queued',message:'Update requested. Waiting for GitHub to start…',runURL});
      else {
        const jobs = await request(`/actions/runs/${runId}/jobs`);
        const steps = jobs.jobs?.flatMap(j => j.steps || []) || [];
        profileSaved ||= steps.some(s => s.name === 'Commit research profile' && s.conclusion === 'success');
        if (run.status === 'completed') {
          if (run.conclusion !== 'success') throw new Error(profileSaved ? 'Profile saved, but the radar update failed. Open the GitHub run for details.' : 'Profile update did not complete. Open the GitHub run for details.');
          onStatus({phase:'complete',message:'Profile saved and radar published.',runURL,profileSaved:true});
          return {profile,runURL,requestId};
        }
        const publishing = steps.some(s => s.name === 'Publish validated site' && s.status !== 'queued');
        onStatus({phase:publishing ? 'publishing' : profileSaved ? 'discovering' : 'queued',
          message:publishing ? 'Publishing your updated radar…' : profileSaved ? 'Profile saved. Discovering and checking opportunities…' : 'Waiting for GitHub to validate and save your profile…',runURL,profileSaved});
      }
      await sleep(15000,signal);
    }
    throw new Error('Still running in GitHub. Continue following the linked run; do not submit the profile again.');
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    // A lost connection after dispatch must not be presented as a failed commit.
    const uncertainDispatch = dispatchAttempted && !dispatched && (!error.status || error.status >= 500);
    const message = uncertainDispatch ? 'GitHub may have received your update, but the response was lost. Check the Actions link before saving again.'
      : profileSaved && !error.message.startsWith('Profile saved') ? `Profile saved; completion of the radar update could not be confirmed. ${error.message}`
      : dispatched && !profileSaved && !error.message.startsWith('Profile update') ? `Update requested; completion could not be confirmed. ${error.message}` : error.message;
    const failure = new Error(message);
    failure.runURL = dispatched || uncertainDispatch ? runURL : null;
    failure.profileSaved = profileSaved;
    throw failure;
  }
}
