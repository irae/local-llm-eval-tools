#!/usr/bin/env python3
"""loop-check.py — one detector for every repetition loop shape seen.

Research run 2. Four arms produced three different repetition loop shapes, and
each of the earlier detectors caught only its own:

| Shape | Example | Caught by |
| --- | --- | --- |
| identical lines in a row | one sentence 498 times | measure-repeat-run.py |
| a counter, every line unique | `ls -d examples/bk-...` x1133 | measure-neardup.py |
| a short cycle, A A B A A B | "Actually..." / "I'll proceed." | **nothing, until this** |

The cycle defeats every consecutive-identity test, because identity
breaks every second or third line. It also defeats a distinct-line count
over the whole run, because the run's earlier healthy work dilutes it.

One measure covers all three:

  **the ratio of distinct SHAPES to lines, inside a sliding window**

Shape means the line with every letter run replaced by `W` and every
digit run by `N`, so a counter cannot hide. The window means late
repetition loop is not diluted by early health. A healthy run sits near 1.0. A
repetition loop of any of the three shapes drops it toward zero.

The threshold is 0.10, and it is set by the clean arm, not by taste. A
healthy run still emits structurally repetitive text — dependency lists,
checklists, JSON — and the clean control arm reaches 0.20 on a
package.json block. A threshold of 0.25 flags that arm, which would make
the detector useless. Measured values: clean arm 0.20 and 0.67, the three
loops 0.02, 0.02 and 0.03. There is an order of magnitude between
them, so 0.10 sits in empty space.

Usage: loop-check.py <events.jsonl> [window] [threshold]
Defaults: window 60 lines, threshold 0.10. Exits 1 on repetition loop.
"""

import json
import re
import sys

DEFAULT_WINDOW = 60
DEFAULT_THRESHOLD = 0.10


def shape(line):
    line = re.sub(r'[A-Za-z]+', 'W', line)
    return re.sub(r'\d+', 'N', line)


def read_lines(path):
    kinds = {}
    for raw in open(path, errors='replace'):
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        event = record.get('assistantMessageEvent') or {}
        delta = event.get('delta')
        if isinstance(delta, str):
            kinds.setdefault(event.get('type'), []).append(delta)
    out = {}
    for kind, parts in kinds.items():
        text = ''.join(parts)
        out[kind] = [l.strip() for l in re.split(r'\\n|\n', text) if l.strip()]
    return out


def worst_window(lines, window):
    if len(lines) < window:
        return 1.0, 0
    shapes = [shape(l) for l in lines]
    worst = 1.0
    where = 0
    for start in range(0, len(shapes) - window + 1):
        chunk = shapes[start:start + window]
        ratio = len(set(chunk)) / window
        if ratio < worst:
            worst = ratio
            where = start
    return worst, where


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    window = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_WINDOW
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_THRESHOLD

    looped = False
    for kind, lines in sorted(read_lines(path).items()):
        ratio, where = worst_window(lines, window)
        verdict = 'LOOP' if ratio < threshold else 'ok'
        print('%-16s lines=%-6d worst distinct-shape ratio=%.2f at line %-6d %s'
              % (kind, len(lines), ratio, where, verdict))
        if ratio < threshold:
            looped = True
            sample = lines[where:where + window]
            seen = []
            for line in sample:
                if line not in seen:
                    seen.append(line)
                if len(seen) == 3:
                    break
            for line in seen:
                print('                 %r' % line[:74])

    sys.exit(1 if looped else 0)


if __name__ == '__main__':
    main()
