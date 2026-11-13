# Saving a research profile from the website

The site stays static. Saving dispatches the `discover.yml` workflow on `dev` through GitHub's authenticated REST API. GitHub Actions validates and commits `data/profile.json`, runs discovery, and publishes the site. No model runs in the browser.

## One-time repository setup

Push the reviewed implementation to `dev`, make `dev` the default branch, and complete the Pages/Actions activation in `LOCAL_TESTING.md`. The deployed workflow must include the new `profile_json`, `profile_base_sha` and `request_id` inputs; the older workflow cannot accept website saves. Allow unattended deployments from `dev` in the github-pages environment.

Create a **fine-grained personal access token** in GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens:

- Select only `adarshapandey/Research-Opportunity-Radar`.
- Grant repository **Actions: read and write** (dispatch and monitor runs).
- Grant repository **Contents: read** (read the current profile revision).
- Choose an expiration appropriate for your use. Organization repositories may require token approval.

The workflow uses its own `GITHUB_TOKEN` with Contents write to commit the profile; the browser token does not need Contents write. Do not put this user token in the repository, public JSON, an Actions workflow input, or localStorage. The UI keeps it only in memory for the operation and clears the password field immediately after submission. Enter it again for a subsequent save.

For a fork, update the public owner/repository coordinates in `github-profile.js` before publishing. This implementation is a personal owner-controlled editor, not a multi-user sign-in system. A seamless “Sign in with GitHub” flow would require an OAuth/App setup and an authentication backend.

## User experience

1. Open Research profile and edit areas, projects and keywords.
2. Enter the repository-scoped token and click **Save profile & update radar**.
3. The dialog shows saving, waiting, discovering and publishing progress, plus a link to the exact correlated run. Processing can take many minutes.
4. The workflow checks that the profile revision has not changed while the update was queued. It preserves name, initials and unrelated metadata, and only accepts the three editable arrays.
5. A successful run reloads the page to display the published data. Browser data fetches bypass the browser cache; Pages propagation may still take a little time.

**Continue in background** closes the dialog and stops polling, without cancelling the workflow. Never paste your token into this chat or commit it to Git.

Research profiles are public repository/site data. Anyone may browse the site, but saving requires GitHub authorization for this repository. The token is sent directly to `api.github.com` and is not included in profile/workflow payloads or diagnostic reports.

## Failure and matching behavior

A rejected/stale profile is not written. If the profile commit succeeds and a later stage fails, the profile remains committed but the previously deployed website remains online; the dialog says that the profile was saved but the radar update failed. Open the run link to inspect the failure. A monitoring/network failure after dispatch does not automatically submit another request.

New discovery uses the committed profile. Recent checkpoints are invalidated when profile contents change. Stored opportunities are reclassified against the new terms: unmatched records remain accessible in search/watchlist, while the main radar and discovery feed exclude records marked as unmatched. Existing matches use literal title/topic/evidence overlap, not semantic inference.

## Local verification before pushing

```bash
npm run check
npm test
npm run build
npm run preview
```

The automated tests mock GitHub: they do not commit to your real repository, consume Tavily credits or dispatch Actions. They cover age boundaries, successful save/monitoring, unrelated concurrent runs, permission errors, post-commit failures, background continuation, and a temporary-repository test of the profile writer and stale-revision check.

Preview the form and progress styling locally. **Clicking Save with a real token from localhost talks to the real GitHub repository**; it does not edit the local checkout. Test a real save only after the new `dev` workflow is pushed and configured. The live save/commit/publish path has not been exercised by the coding agent because it requires user credentials and the activated remote workflow.

GitHub API references: [workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [browser CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests).
