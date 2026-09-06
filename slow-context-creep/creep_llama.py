#!/usr/bin/env python3
"""creep_llama.py — context creep against llama-server.

The method lives in `creep.py`; this file holds only what is specific to
llama-server.

Two endpoints, because they answer different questions:

    ENDPOINT=completion   raw /completion, no chat template at all.
                          Comparable with every published number in this
                          repo, and the default.
    ENDPOINT=chat         /v1/chat/completions, which goes through the
                          chat template. This is the path a harness like
                          pi actually uses, so it is the number a user
                          feels. The template adds a system turn and any
                          tool definitions to every request, so real use
                          reaches a given depth sooner than the raw curve
                          suggests.

Thinking: llama-server defaults `enable_thinking` to TRUE on the chat
path. `THINKING=off` sends `enable_thinking: false`. The raw completion
path has no template and therefore no thinking either way.

Liveness: the runner probes ONE real completion here when a step stays
silent for `STALL_S`. Neither endpoint streams, so the whole step counts
as silence and the stall clock runs from the start of the request. Set
`STALL_S` above the longest prefill this config can have. llama-server
has no silent-death signature worth grepping, so this file passes no
server log.

Usage:
    DEPTH_LIST=4096,8192,16384 MODEL=gemma-4-12b-it creep_llama.py \\
    > results/<config>-creep.tsv 2>&1
"""

import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import creep

ENDPOINT = os.environ.get("ENDPOINT", "completion")
THINKING = os.environ.get("THINKING", "off")


def post(path, payload, timeout=3600):
    request = urllib.request.Request(
        creep.BASE + path, json.dumps(payload).encode(),
        {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def step_completion(prompt, _label):
    reply = post("/completion", {"prompt": prompt, "n_predict": 64,
                                 "temperature": 0, "cache_prompt": True})
    timings = reply.get("timings", {})
    return timings.get("predicted_per_second") or 0.0, reply.get("content", "")


def probe(timeout):
    if ENDPOINT == "chat":
        reply = post("/v1/chat/completions",
                     {"model": creep.MODEL,
                      "messages": [{"role": "user", "content": "ok"}],
                      "max_tokens": 1, "temperature": 0}, timeout)
        return bool(reply.get("choices"))
    reply = post("/completion", {"prompt": "ok", "n_predict": 1,
                                 "temperature": 0, "cache_prompt": False},
                 timeout)
    return "content" in reply


def step_chat(prompt, _label):
    payload = {"model": creep.MODEL,
               "messages": [{"role": "user", "content": prompt}],
               "max_tokens": 64, "temperature": 0}
    if THINKING == "off":
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    began = time.time()
    reply = post("/v1/chat/completions", payload)
    elapsed = time.time() - began
    message = reply["choices"][0].get("message") or {}
    text = (message.get("content") or "") + (message.get("reasoning_content") or "")

    # Use the server's own decode rate, as the completion path does.
    # Wall clock here would include prompt processing, which makes the
    # chat curve look catastrophically slower than the raw one for a
    # reason that has nothing to do with decode.
    timings = reply.get("timings") or {}
    rate = timings.get("predicted_per_second")
    if rate:
        return rate, text
    produced = reply.get("usage", {}).get("completion_tokens") or 0
    return (produced / elapsed if elapsed else 0.0), text


def main():
    creep.usage(__doc__)
    if ENDPOINT == "chat" and not creep.MODEL:
        creep.die("chat endpoint needs MODEL set")
    print("llama-server, endpoint=%s thinking=%s contexts=%d pause=%.0fs"
          % (ENDPOINT, THINKING if ENDPOINT == "chat" else "n/a (no template)",
             creep.N_CONTEXTS, creep.STEP_PAUSE_S), flush=True)
    step = step_chat if ENDPOINT == "chat" else step_completion
    raise SystemExit(creep.run(step, probe))


if __name__ == "__main__":
    main()
