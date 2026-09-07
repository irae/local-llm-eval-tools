#!/usr/bin/env python3
"""fake-server.py answers completion requests from a JSON scenario file.

It reads FAKE_SERVER_SCENARIO, listens on FAKE_SERVER_PORT, and appends
one JSON line per request to FAKE_SERVER_LOG.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCENARIO_PATH = os.environ["FAKE_SERVER_SCENARIO"]
PORT = int(os.environ["FAKE_SERVER_PORT"])
LOG_PATH = os.environ["FAKE_SERVER_LOG"]

with open(SCENARIO_PATH) as _handle:
    SCENARIO = json.load(_handle)

RATES = SCENARIO.get("rates", [1.0])
AT = SCENARIO.get("at", {})
HANG_S = SCENARIO.get("hang_s", 0)
PROBE_MODE = SCENARIO.get("probe", "ok")
FLAVOR = SCENARIO.get("flavor", "llama")

GENERATED_TEXT = "the model keeps decoding steady tokens"

ALLOWED_PATHS = {
    "llama": {"/completion", "/v1/chat/completions"},
    "lmstudio": {"/v1/chat/completions"},
    "mlx": {"/v1/completions"},
}

STATE_LOCK = threading.Lock()
STATE = {"request_index": 0, "step_index": 0, "dead": False}
LOG_LOCK = threading.Lock()


def rate_for(step_index):
    if not RATES:
        return 0.0
    if step_index < len(RATES):
        return RATES[step_index]
    return RATES[-1]


def prompt_text(payload):
    if "messages" in payload:
        messages = payload["messages"]
        return messages[-1]["content"] if messages else ""
    return payload.get("prompt", "")


def is_probe(payload):
    one_token = payload.get("n_predict") == 1 or payload.get("max_tokens") == 1
    return one_token and prompt_text(payload) == "ok"


def log_request(index, path, kind, prompt):
    entry = {"index": index, "path": path, "kind": kind, "prompt": prompt}
    with LOG_LOCK:
        with open(LOG_PATH, "a") as handle:
            handle.write(json.dumps(entry) + "\n")


class Handler(BaseHTTPRequestHandler):

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        payload = json.loads(body) if body else {}
        path = self.path
        probe = is_probe(payload)

        with STATE_LOCK:
            index = STATE["request_index"]
            STATE["request_index"] += 1
            step_index = None
            if not probe:
                step_index = STATE["step_index"]
                STATE["step_index"] += 1
            dead = STATE["dead"]

        log_request(index, path, "probe" if probe else "step",
                    prompt_text(payload))

        if path not in ALLOWED_PATHS.get(FLAVOR, set()):
            self.send_response(404)
            self.end_headers()
            return

        if dead:
            self._hang_forever()
            return

        if probe:
            if PROBE_MODE == "timeout":
                self._hang_forever()
                return
            self._answer(path, rate=0.0, text="ok", stream=False)
            return

        action = AT.get(str(step_index))

        if action == "die":
            with STATE_LOCK:
                STATE["dead"] = True
            self._hang_forever()
            return

        if action == "fail":
            self.send_response(500)
            self.end_headers()
            return

        if action == "hang":
            time.sleep(HANG_S)

        text = "" if action == "empty" else GENERATED_TEXT
        rate = 0.0 if action == "empty" else rate_for(step_index)

        self._answer(path, rate=rate, text=text,
                    stream=bool(payload.get("stream")))

    def _hang_forever(self):
        while True:
            time.sleep(3600)

    def _answer(self, path, rate, text, stream):
        if stream:
            self._answer_stream(path, text, rate)
            return
        body = self._body_for(path, rate, text)
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body_for(self, path, rate, text):
        if path == "/completion":
            return {"content": text,
                    "timings": {"predicted_per_second": rate}}
        if path == "/v1/chat/completions":
            body = {"choices": [{"message": {"content": text}}],
                    "usage": {"completion_tokens": len(text.split())}}
            if FLAVOR == "llama":
                body["timings"] = {"predicted_per_second": rate}
            return body
        if path == "/v1/completions":
            return {"choices": [{"text": text}],
                    "usage": {"completion_tokens": len(text.split())}}
        return {}

    def _answer_stream(self, path, text, rate):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        words = text.split()
        gap = 1.0 / rate if rate > 0 else 0.05
        for position, word in enumerate(words):
            piece = word + " "
            if path == "/v1/chat/completions":
                chunk = {"choices": [{"delta": {"content": piece}}]}
            else:
                chunk = {"choices": [{"text": piece}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.flush()
            if position < len(words) - 1:
                time.sleep(gap)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
