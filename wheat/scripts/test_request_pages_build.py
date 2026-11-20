"""Offline tests: no GitHub request or credential access is performed."""
import io
import unittest
import urllib.error
from unittest.mock import patch

import request_pages_build as helper

SHA = 'a' * 40
OTHER = 'b' * 40
PREFIX = helper.API_ROOT + '/repos/' + helper.REPOSITORY
CONFIG = {'build_type': 'legacy', 'source': {'branch': 'main', 'path': '/'}}
REPO = {'full_name': helper.REPOSITORY, 'default_branch': 'main'}


def build(status, commit=SHA, number=42, error=None):
    return {'url': PREFIX + '/pages/builds/' + str(number), 'status': status,
            'commit': commit, 'error': {'message': error}}


class Clock:
    def __init__(self): self.now = 0; self.waits = []
    def monotonic(self): return self.now
    def sleep(self, amount): self.waits.append(amount); self.now += amount


class FakeAPI:
    def __init__(self, responses): self.responses = iter(responses); self.calls = []
    def request(self, method, suffix, *, timeout):
        self.calls.append((method, suffix, timeout))
        value = next(self.responses)
        if isinstance(value, Exception): raise value
        return value


class PagesTests(unittest.TestCase):
    def confirm(self, responses, **kwargs):
        api, clock = FakeAPI(responses), Clock()
        result = helper.confirm_build(api, SHA, monotonic=clock.monotonic, sleep=clock.sleep, **kwargs)
        return result, api, clock

    def test_post_old_build_poll_and_pinned_exact_commit(self):
        result, api, clock = self.confirm([REPO, CONFIG, {'status': 'queued'},
            build('built', OTHER, 41), build('building'), build('built')])
        self.assertEqual(result['commit'], SHA)
        self.assertEqual([(m,p) for m,p,t in api.calls], [('GET',''),('GET','/pages'),
            ('POST','/pages/builds'),('GET','/pages/builds/latest'),
            ('GET','/pages/builds/latest'),('GET','/pages/builds/42')])
        self.assertEqual(clock.waits, [15,15])
        self.assertTrue(all(0 < t <= 30 for m,p,t in api.calls))

    def test_explicit_build_error_fails(self):
        with self.assertRaisesRegex(helper.BuildError, 'failed build'):
            self.confirm([REPO, CONFIG, {}, build('errored', error='server error')])

    def test_built_with_error_is_not_success(self):
        with self.assertRaises(helper.BuildError):
            self.confirm([REPO, CONFIG, {}, build('built', error='failure')])

    def test_refuses_wrong_config_before_post(self):
        for config in [{'build_type':'workflow','source':CONFIG['source']},
                       {'build_type':'legacy','source':{'branch':'other','path':'/'}},
                       {'build_type':'legacy','source':{'branch':'main','path':'/docs'}}]:
            api = FakeAPI([REPO,config])
            with self.assertRaisesRegex(helper.BuildError, 'configuration'):
                helper.confirm_build(api,SHA)
            self.assertFalse(any(m=='POST' for m,p,t in api.calls))

    def test_refuses_wrong_default_branch(self):
        api=FakeAPI([{**REPO,'default_branch':'other'}])
        with self.assertRaisesRegex(helper.BuildError,'default branch'):
            helper.confirm_build(api,SHA)
        self.assertEqual(len(api.calls),1)

    def test_old_success_cannot_satisfy_timeout(self):
        clock=Clock();api=FakeAPI([REPO,CONFIG,{},build('built',OTHER),build('built',OTHER)])
        with self.assertRaisesRegex(helper.BuildError,'Timed out'):
            helper.confirm_build(api,SHA,timeout_seconds=20,monotonic=clock.monotonic,sleep=clock.sleep)
        self.assertEqual(clock.waits,[15,5])
        self.assertEqual(clock.now,20)

    def test_api_error_is_not_retried_as_post(self):
        api=FakeAPI([REPO,CONFIG,helper.BuildError('HTTP 403')])
        with self.assertRaisesRegex(helper.BuildError,'403'): helper.confirm_build(api,SHA)
        self.assertEqual(sum(m=='POST' for m,p,t in api.calls),1)

    def test_matching_build_url_must_be_same_fixed_api_repository(self):
        bad=build('building');bad['url']='https://attacker.example/steal'
        with self.assertRaisesRegex(helper.BuildError,'invalid build URL'):
            self.confirm([REPO,CONFIG,{},bad])

    def test_expected_sha_and_repository_guards(self):
        with self.assertRaises(helper.BuildError): helper.GitHubAPI('fake','other/repo')
        with self.assertRaises(helper.BuildError): helper.GitHubAPI('',helper.REPOSITORY)
        api=FakeAPI([])
        with self.assertRaises(helper.BuildError): helper.confirm_build(api,'not-a-sha')
        self.assertEqual(api.calls,[])

    def test_http_error_message_never_contains_token_or_body(self):
        token='fake-sensitive-token-for-test'
        api=helper.GitHubAPI(token,helper.REPOSITORY)
        failure=urllib.error.HTTPError('https://api.github.com/',403,token,{},io.BytesIO(token.encode()))
        with patch.object(api._opener,'open',side_effect=failure):
            with self.assertRaises(helper.BuildError) as caught:
                api.request('POST','/pages/builds',timeout=10)
        self.assertNotIn(token,str(caught.exception))
        self.assertIn('403',str(caught.exception))


if __name__ == '__main__': unittest.main()
