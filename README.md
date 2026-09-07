# local-llm-eval-tools

These are the tools I use to choose a local model for my own
hardware. The measurements and the site that publishes the results live
in [`choose-a-local-llm`](https://github.com/irae/choose-a-local-llm).

- [`slow-context-creep`](slow-context-creep/): a depth sweep that grows
  a prompt step by step against a served model and records decode
  speed, memory, and the stop verdict. Backends: llama-server,
  mlx_lm.server, LM Studio. macOS only, because it reads macOS-specific
  memory counters.
- [`issue-simulator-bench`](issue-simulator-bench/): runs several models
  against the same real repository issue through pi, nudges a run past
  harness hiccups, scores it objectively from a battery and telemetry,
  and takes a judge's verdict as an option.

License: MIT, see [LICENSE](LICENSE).
