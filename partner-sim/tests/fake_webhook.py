"""A small HTTP server that plays the SENDER's webhook in the tests.

It listens on 127.0.0.1 (a free port), records every request it gets, and answers with whatever
status the test set. Real sockets, so the tests exercise the real httpx client: nothing about the
network is faked.
"""

import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@dataclass
class Received:
    path: str
    headers: dict[str, str]  # names in lower case
    body: bytes


class FakeWebhook:
    def __init__(self) -> None:
        self.requests: list[Received] = []
        self.status = 200  # what the next answers say
        self.location: str | None = None  # a Location header, for a 3xx answer
        self.delay = 0.0  # seconds to wait before answering, to provoke a timeout
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                headers = {name.lower(): value for name, value in self.headers.items()}
                outer.requests.append(Received(self.path, headers, body))
                time.sleep(outer.delay)
                self.send_response(outer.status)
                if outer.location is not None:
                    self.send_header("Location", outer.location)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass  # keep the test output quiet

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True  # a handler still sleeping must not block the shutdown
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}/hook"
        # poll_interval: how often the loop looks for the shutdown request. The default 0.5 s
        # would make every test wait half a second at the end.
        threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        ).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
