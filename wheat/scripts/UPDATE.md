# Public wheat update

The workflow runs daily at **22:30 Europe/Zurich**, selecting one of the20:30/21:30UTC schedules according to Swiss daylight saving time. Scheduled Actions can start late. Manual `workflow_dispatch` bypasses the time guard.

Only official public Euronext settlement pages and ECB reference FX are fetched. No PC, private Site, service token, personal access token, or extra Python dependency is required. Python's standard library includes the HTML parser, HTTP client and CSV tools. `collection_core.py` contains the public collection functions extracted from the audited collector; private client methods were excluded.

The updater retains historical source keys and permits reported amendments. US March histories and their provenance remain unchanged; future US updates require another actual source import. The March dashboard uses April through February and exact delivery-year/date matches. Only FX may be carried backward, at most3calendar days. Recent volume/OI zeros remain as supplied and may be preliminary.

To create the initial downloads without any price request:

```sh
python wheat/scripts/update_public.py --rebuild-only
```

To run the offline regression and then a real public-data refresh:

```sh
python wheat/scripts/test_public_update.py
python wheat/scripts/test_request_pages_build.py
python wheat/scripts/update_public.py
```

The workflow commits only `wheat/data.json`, `wheat/data/` and `wheat/downloads/` after a successful update. Failed source retrieval leaves the last published dataset intact; Actions reports the failure. No force-push is used. A concurrent repository change can safely reject the push and require a rerun.

GitHub documents that commits made with `GITHUB_TOKEN` do not automatically trigger Pages. This workflow therefore explicitly requests the existing legacy main/root Pages build after pushing, using only the built-in token's `contents: write` and `pages: write` permissions. The helper checks the existing configuration without changing it and requires the exact pushed commit to reach `built`; an accepted request alone is insufficient. It does not replace other dashboards or change the repository's Pages publishing source.

Primary documentation:

- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions
- https://docs.github.com/en/rest/pages/pages#request-a-github-pages-build
- https://docs.github.com/en/actions/concepts/security/github_token
- https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

The Pages request path is supported by GitHub's documented permission model; the staged tests mock the API. An authorized manual workflow run must confirm the live build before treating deployment as verified.
