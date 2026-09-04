#!/usr/bin/env python3
"""creep_lmstudio.py — context creep against LM Studio.

The method lives in `creep.py`; this file holds only what is specific to
LM Studio.

**It uses `/v1/chat/completions`, not raw completions.** LM Studio's
`/v1/completions` returns garbage on this build and streams the whole
reply in one burst with no per-token pacing — verified 2026-08-29. The
chat endpoint streams correctly and reuses the prompt cache on
append-only growth. Do not "simplify" this to raw completions.

Two consequences worth carrying when comparing against llama-server:

- This path goes THROUGH the chat template, so it is not the same shape
  as llama's raw `/completion` curve. Compare like with like: use
  `ENDPOINT=chat` on `creep_llama.py`.
- Thinking on this backend is whatever the model entry defaults to. For
  `gemma-4-12b-it-mlx` it is off and cannot be turned on (probed
  2026-09-04). There is no toggle to set here.

Decode speed comes from the gaps between streamed chunks, because this
server reports no timings of its own.

Liveness: this path streams, so every chunk calls `creep.beat()` and a
step that still sends tokens never counts as stalled. Only a silent
phase — prefill, or a full recompute near the window edge — can reach
`STALL_S` and start the one real completion the runner probes with. LM
Studio writes its log through the app, so this file passes no server
log.

Usage:
    DEPTH_LIST=4096,8192 MODEL=gemma-4-12b-it-mlx creep_lmstudio.py \\
    > results/<config>-creep.tsv 2>&1
"""

import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import creep


def probe(timeout):
    payload = {"model": creep.MODEL,
               "messages": [{"role": "user", "content": "ok"}],
               "max_tokens": 1, "temperature": 0}
    request = urllib.request.Request(
        creep.BASE + "/v1/chat/completions", json.dumps(payload).encode(),
        {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return bool(json.load(response).get("choices"))


def step(prompt, _label):
    payload = {"model": creep.MODEL,
               "messages": [{"role": "user", "content": prompt}],
               "max_tokens": 64, "temperature": 0, "stream": True}
    request = urllib.request.Request(
        creep.BASE + "/v1/chat/completions", json.dumps(payload).encode(),
        {"Content-Type": "application/json"})

    stamps = []
    pieces = []
    with urllib.request.urlopen(request, timeout=3600) as response:
        for line in response:
            if not line.startswith(b"data:") or b"[DONE]" in line:
                continue
            chunk = json.loads(line[5:])
            delta = chunk["choices"][0].get("delta", {})
            piece = delta.get("content") or delta.get("reasoning_content")
            if piece:
                creep.beat()
                stamps.append(time.time())
                pieces.append(piece)

    # First chunk carries the prompt-processing wait; measure the gaps
    # between chunks, which is decode.
    if len(stamps) < 3:
        return 0.0, "".join(pieces)
    span = stamps[-1] - stamps[0]
    return ((len(stamps) - 1) / span if span else 0.0), "".join(pieces)


def main():
    creep.usage(__doc__)
    if not creep.MODEL:
        creep.die("MODEL must be the key from `lms ls`, "
                  "e.g. gemma-4-12b-it-mlx")
    print("LM Studio, chat endpoint, contexts=%d pause=%.0fs"
          % (creep.N_CONTEXTS, creep.STEP_PAUSE_S), flush=True)
    raise SystemExit(creep.run(step, probe))


if __name__ == "__main__":
    main()
