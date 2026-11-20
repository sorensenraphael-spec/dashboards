#!/usr/bin/env python3
"""Explicitly request and confirm the existing legacy main-root Pages build.

Uses only the workflow's GH_TOKEN (GITHUB_TOKEN) and GITHUB_REPOSITORY environment.
Required job permissions: contents: write for the preceding push, pages: write.
No PAT, configuration changes, token logging, or automatic POST retries.

Official documentation (checked 2026-11-20):
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions
https://docs.github.com/en/rest/pages/pages#request-a-github-pages-build
https://docs.github.com/en/actions/concepts/security/github_token
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

REPOSITORY = 'sorensenraphael-spec/dashboards'
API_ROOT = 'https://api.github.com'
API_VERSION = '2022-11-28'
MAX_TIMEOUT = 480
POLL_SECONDS = 15


class BuildError(Exception):
    """A safe, credential-free failure message."""


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the authorization header to a redirect destination.
        return None


class GitHubAPI:
    def __init__(self, token: str, repository: str):
        if repository != REPOSITORY:
            raise BuildError('GITHUB_REPOSITORY must be ' + REPOSITORY)
        if not token or not token.strip():
            raise BuildError('GH_TOKEN is required')
        self._token = token
        self._prefix = '/repos/' + repository
        self._opener = urllib.request.build_opener(NoRedirects())

    def request(self, method: str, suffix: str, *, timeout: float):
        if suffix not in ('', '/pages', '/pages/builds', '/pages/builds/latest') and not re.fullmatch(r'/pages/builds/[0-9]+', suffix):
            raise BuildError('Refused an unexpected GitHub API path')
        request = urllib.request.Request(
            API_ROOT + self._prefix + suffix,
            data=b'{}' if method == 'POST' else None,
            method=method,
            headers={
                'Accept': 'application/vnd.github+json',
                'Authorization': 'Bearer ' + self._token,
                'X-GitHub-Api-Version': API_VERSION,
                'Content-Type': 'application/json',
                'User-Agent': 'wheat-pages-build-confirmation',
            },
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                expected_status = 201 if method == 'POST' else 200
                if response.status != expected_status:
                    raise BuildError(f'GitHub API returned HTTP {response.status}; expected {expected_status}')
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise BuildError('GitHub API response exceeded the size limit')
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise BuildError('GitHub API returned an unexpected JSON response')
                return value
        except urllib.error.HTTPError as error:
            # Do not print response bodies, exception strings, request headers,
            # or URLs supplied by the server: any could contain sensitive text.
            raise BuildError(f'GitHub API returned HTTP {error.code}; build was not confirmed') from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise BuildError('GitHub API network request failed; build was not confirmed') from None
        except (ValueError, UnicodeError):
            raise BuildError('GitHub API returned invalid JSON') from None


def confirm_build(api, expected_sha: str, *, timeout_seconds: float = MAX_TIMEOUT,
                  monotonic=time.monotonic, sleep=time.sleep):
    """Make one POST, then require the exact commit in a successful build.

The request endpoint chooses the latest default-branch revision rather than
accepting a SHA. A concurrent branch change therefore fails confirmation safely.
Once a matching build is observed, its numeric build URL is pinned so later
unrelated builds cannot substitute for it.
"""
    if not re.fullmatch(r'[0-9a-fA-F]{40}', expected_sha):
        raise BuildError('Expected commit must be a full 40-character hexadecimal SHA')
    expected_sha = expected_sha.lower()
    if not 0 < timeout_seconds <= MAX_TIMEOUT:
        raise BuildError('Timeout must be greater than zero and at most 480 seconds')
    deadline = monotonic() + timeout_seconds

    def request(method, suffix):
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise BuildError('Timed out before the expected Pages commit was confirmed built')
        return api.request(method, suffix, timeout=min(30, remaining))

    repository = request('GET', '')
    if repository.get('full_name') != REPOSITORY or repository.get('default_branch') != 'main':
        raise BuildError('Refused repository identity or default branch other than the expected repository/main')
    pages = request('GET', '/pages')
    source = pages.get('source')
    if pages.get('build_type') != 'legacy' or not isinstance(source, dict) or source.get('branch') != 'main' or source.get('path') != '/':
        raise BuildError('Refused Pages configuration: legacy build from main root is required')

    request('POST', '/pages/builds')
    poll_path = '/pages/builds/latest'
    prefix = API_ROOT + '/repos/' + REPOSITORY
    while True:
        build = request('GET', poll_path)
        commit = build.get('commit')
        if isinstance(commit, str) and commit.lower() == expected_sha:
            url = build.get('url')
            if not isinstance(url, str) or not re.fullmatch(re.escape(prefix) + r'/pages/builds/[0-9]+', url):
                raise BuildError('Matching Pages build has an invalid build URL')
            poll_path = url[len(prefix):]
            error = build.get('error')
            if (isinstance(error, dict) and error.get('message')) or build.get('status') in ('errored', 'error', 'failed', 'cancelled', 'canceled'):
                raise BuildError('GitHub reported a failed build for the expected commit; inspect the Pages workflow logs')
            if build.get('status') == 'built':
                return {'status': 'built', 'commit': expected_sha, 'buildUrl': url}
            if build.get('status') not in ('queued', 'building'):
                raise BuildError('GitHub returned an unexpected status for the matching Pages build')
        elif poll_path != '/pages/builds/latest':
            raise BuildError('Pinned Pages build no longer matches the expected commit')
        # An older/unrelated successful build is never sufficient confirmation.
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise BuildError('Timed out before the expected Pages commit was confirmed built')
        sleep(min(POLL_SECONDS, remaining))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-sha', required=True, help='Full SHA successfully pushed to main')
    parser.add_argument('--timeout-seconds', type=float, default=MAX_TIMEOUT)
    args = parser.parse_args(argv)
    try:
        api = GitHubAPI(os.environ.get('GH_TOKEN', ''), os.environ.get('GITHUB_REPOSITORY', ''))
        result = confirm_build(api, args.expected_sha, timeout_seconds=args.timeout_seconds)
    except BuildError as error:
        print('Pages build confirmation failed: ' + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
