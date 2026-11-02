import pytest
import requests

from tbcounter.api import Client


def test_worker_token_requests_never_follow_redirects():
    class Session:
        def __init__(self):
            self.headers = {}
            self.calls = []

        def request(self, method, url, **kwargs):
            self.calls.append((method, url, kwargs))
            response = requests.Response()
            response.status_code = 302
            response.headers['Location'] = 'https://untrusted.example/token-sink'
            return response

    session = Session()
    client = Client('http://backend:8080', 'fixture-token', session)
    with pytest.raises(requests.HTTPError, match='redirects are forbidden'):
        client.streams()
    assert len(session.calls) == 1
    assert session.calls[0][1] == 'http://backend:8080/api/internal/automation/streams'
    assert session.calls[0][2]['allow_redirects'] is False
