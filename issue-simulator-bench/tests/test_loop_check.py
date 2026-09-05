"""Tests for benchmarks/loop-check.py, against real logs.

Fixtures: tests/fixtures/README.md says where each one came from.
"""
import importlib.util
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
SCRIPT = os.path.join(ROOT, "benchmarks", "loop-check.py")

_spec = importlib.util.spec_from_file_location("loop_check", SCRIPT)
loop_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(loop_check)


def run(*args):
    return subprocess.run(
        [sys.executable, SCRIPT] + list(args),
        capture_output=True, text=True)


class Shape(unittest.TestCase):
    def test_letter_runs_become_one_mark(self):
        self.assertEqual(loop_check.shape("ls -F"), "W -W")

    def test_a_counter_cannot_hide(self):
        self.assertEqual(loop_check.shape("item 41"), loop_check.shape("item 42"))

    def test_two_different_commands_keep_different_shapes(self):
        self.assertNotEqual(loop_check.shape("ls -F"), loop_check.shape("cat a b c"))


class WorstWindow(unittest.TestCase):
    def test_a_run_shorter_than_the_window_is_never_a_loop(self):
        self.assertEqual(loop_check.worst_window(["a", "a", "a"], 60), (1.0, 0))

    def test_all_distinct_scores_one(self):
        lines = ["a " * i + "z" for i in range(1, 11)]
        self.assertEqual(loop_check.worst_window(lines, 5)[0], 1.0)

    def test_one_repeated_shape_scores_the_floor(self):
        ratio, where = loop_check.worst_window(["ls -F"] * 10, 5)
        self.assertEqual(ratio, 0.2)
        self.assertEqual(where, 0)

    def test_late_repetition_is_not_diluted_by_early_health(self):
        healthy = ["a " * i + "z" for i in range(1, 41)]
        ratio, where = loop_check.worst_window(healthy + ["ls -F"] * 10, 5)
        self.assertEqual(ratio, 0.2)
        self.assertEqual(where, 40)


class SessionLog(unittest.TestCase):
    """A pi session log: the three kinds come from assistant message blocks."""

    def test_a_looped_session_log_reports_loop_and_exits_one(self):
        result = run(os.path.join(FIXTURES, "session-loop.jsonl"))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("toolcall_delta", result.stdout)
        self.assertIn("ratio=0.02", result.stdout)
        self.assertIn("LOOP", result.stdout)

    def test_the_loop_verdict_prints_the_repeated_line(self):
        result = run(os.path.join(FIXTURES, "session-loop.jsonl"))
        self.assertIn("ls -F", result.stdout)

    def test_a_healthy_session_log_exits_zero(self):
        result = run(os.path.join(FIXTURES, "session-healthy.jsonl"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("LOOP", result.stdout)

    def test_every_tool_call_is_one_line(self):
        kinds = loop_check.read_lines(os.path.join(FIXTURES, "session-loop.jsonl"))
        self.assertEqual(len(kinds["toolcall_delta"]), 61)

    def test_the_three_kinds_are_the_same_as_on_an_events_log(self):
        kinds = loop_check.read_lines(os.path.join(FIXTURES, "session-loop.jsonl"))
        self.assertEqual(sorted(kinds),
                         ["text_delta", "thinking_delta", "toolcall_delta"])


class EventsLog(unittest.TestCase):
    """The runner's events log: one line per tool call, the 2026-09-05 fix."""

    def test_each_tool_call_ends_its_own_line(self):
        kinds = loop_check.read_lines(os.path.join(FIXTURES, "events-toolcalls.jsonl"))
        self.assertEqual(len(kinds["toolcall_delta"]), 30)

    def test_a_repeated_command_enters_the_window(self):
        result = run(os.path.join(FIXTURES, "events-toolcalls.jsonl"), "5", "0.5")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("ratio=0.20", result.stdout)
        self.assertIn("LOOP", result.stdout)

    def test_the_same_log_is_healthy_at_the_shipped_threshold(self):
        result = run(os.path.join(FIXTURES, "events-toolcalls.jsonl"))
        self.assertEqual(result.returncode, 0, result.stderr)


class Arguments(unittest.TestCase):
    def test_no_argument_prints_the_usage(self):
        result = run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Usage: loop-check.py", result.stderr)

    def test_the_window_and_the_threshold_are_arguments(self):
        healthy = os.path.join(FIXTURES, "session-healthy.jsonl")
        self.assertEqual(run(healthy).returncode, 0)
        self.assertEqual(run(healthy, "60", "0.9").returncode, 1)

    def test_a_file_with_no_json_reports_no_kind(self):
        path = os.path.join(FIXTURES, "server-llama-healthy.log")
        self.assertEqual(loop_check.read_lines(path), {})


if __name__ == "__main__":
    unittest.main()
