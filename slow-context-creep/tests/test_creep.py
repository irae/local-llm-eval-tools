"""test_creep.py runs creep.py against the fake server and fake memory tools."""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SLOW_CONTEXT_CREEP_DIR = os.path.dirname(TESTS_DIR)
HELPERS_DIR = os.path.join(TESTS_DIR, "helpers")
FIXTURES_DIR = os.path.join(TESTS_DIR, "fixtures")
CREEP_PY = os.path.join(SLOW_CONTEXT_CREEP_DIR, "creep.py")

sys.path.insert(0, SLOW_CONTEXT_CREEP_DIR)
import creep as creep_module
FAKE_SERVER_PY = os.path.join(HELPERS_DIR, "fake-server.py")
FAKE_VM_STAT = os.path.join(HELPERS_DIR, "fake-vm_stat")
FAKE_SYSCTL = os.path.join(HELPERS_DIR, "fake-sysctl")

STOP_LINE_RE = re.compile(
    r"^STOP: (below [0-9.]+ tok/s|request failed|silent halt|swap grew|"
    r"[0-9]+ or more pages|generation thread died|server dead)")


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def wait_for_port(port, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError("fake server did not open port %d in time" % port)


class CreepTestCase(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

        self.port = free_port()
        self.base_url = "http://127.0.0.1:%d" % self.port

        self.server_scenario_path = os.path.join(self.tmp, "server_scenario.json")
        with open(self.server_scenario_path, "w") as handle:
            json.dump({"rates": [30, 28, 26], "flavor": "llama", "probe": "ok"},
                      handle)

        self.mem_scenario_path = os.path.join(self.tmp, "mem_scenario.json")
        with open(self.mem_scenario_path, "w") as handle:
            json.dump({"snapshots": [
                {"free": 1000000, "wired": 100000, "compressions": 500,
                 "decompressions": 400, "swap_used_mb": 0},
                {"free": 1000000, "wired": 100000, "compressions": 500,
                 "decompressions": 400, "swap_used_mb": 0},
                {"free": 1000000, "wired": 100000, "compressions": 500,
                 "decompressions": 400, "swap_used_mb": 0},
            ]}, handle)

        self.server_log_path = os.path.join(self.tmp, "server_requests.jsonl")
        server_env = dict(os.environ)
        server_env["FAKE_SERVER_SCENARIO"] = self.server_scenario_path
        server_env["FAKE_SERVER_PORT"] = str(self.port)
        server_env["FAKE_SERVER_LOG"] = self.server_log_path
        self.server_process = subprocess.Popen(
            [sys.executable, FAKE_SERVER_PY], env=server_env)
        wait_for_port(self.port)

        self.bin_dir = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin_dir)
        os.symlink(FAKE_VM_STAT, os.path.join(self.bin_dir, "vm_stat"))
        os.symlink(FAKE_SYSCTL, os.path.join(self.bin_dir, "sysctl"))

    def tearDown(self):
        self.server_process.kill()
        self.server_process.wait()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def restart_server(self, scenario):
        """Restart the fake server with a new scenario on the same port.

        The fake server reads its scenario once at start, so a test that
        needs different rates or a different `at` map must restart it
        before calling run_creep.
        """
        self.server_process.kill()
        self.server_process.wait()
        with open(self.server_scenario_path, "w") as handle:
            json.dump(scenario, handle)
        server_env = dict(os.environ)
        server_env["FAKE_SERVER_SCENARIO"] = self.server_scenario_path
        server_env["FAKE_SERVER_PORT"] = str(self.port)
        server_env["FAKE_SERVER_LOG"] = self.server_log_path
        self.server_process = subprocess.Popen(
            [sys.executable, FAKE_SERVER_PY], env=server_env)
        wait_for_port(self.port)

    def write_mem_scenario(self, snapshots):
        with open(self.mem_scenario_path, "w") as handle:
            json.dump({"snapshots": snapshots}, handle)

    def read_request_log(self):
        with open(self.server_log_path) as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def run_creep(self, backend, env=None, timeout=60):
        index_path = os.path.join(self.tmp, "mem_index")
        if os.path.exists(index_path):
            os.remove(index_path)

        full_env = dict(os.environ)
        full_env["PATH"] = self.bin_dir + os.pathsep + full_env.get("PATH", "")
        full_env["SWEEP_BASE"] = self.base_url
        full_env["DEPTH_LIST"] = "200,400,600"
        full_env["STEP_PAUSE_S"] = "0"
        full_env["STALL_S"] = "1"
        full_env["PROBE_TIMEOUT_S"] = "1"
        full_env["MODEL"] = "fake"
        full_env["FAKE_MEM_SCENARIO"] = self.mem_scenario_path
        full_env["FAKE_MEM_INDEX"] = index_path
        if env:
            full_env.update(env)

        return subprocess.run([sys.executable, CREEP_PY, backend],
                              env=full_env, capture_output=True, text=True,
                              timeout=timeout)

    def test_fake_server_answers_completion_with_first_rate(self):
        request = urllib.request.Request(
            self.base_url + "/completion",
            json.dumps({"prompt": "hello", "n_predict": 64}).encode(),
            {"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            reply = json.load(response)

        self.assertEqual(reply["timings"]["predicted_per_second"], 30)

    def test_fake_vm_stat_reports_a_different_wired_value_on_the_second_call(self):
        mem_scenario_path = os.path.join(self.tmp, "wired_scenario.json")
        with open(mem_scenario_path, "w") as handle:
            json.dump({"snapshots": [
                {"free": 1000000, "wired": 100000, "compressions": 500,
                 "decompressions": 400, "swap_used_mb": 0},
                {"free": 1000000, "wired": 113259, "compressions": 500,
                 "decompressions": 400, "swap_used_mb": 0},
            ]}, handle)
        index_path = os.path.join(self.tmp, "wired_index")
        env = dict(os.environ)
        env["FAKE_MEM_SCENARIO"] = mem_scenario_path
        env["FAKE_MEM_INDEX"] = index_path

        first = subprocess.run([FAKE_VM_STAT], env=env, capture_output=True,
                               text=True, check=True)
        second = subprocess.run([FAKE_VM_STAT], env=env, capture_output=True,
                                text=True, check=True)

        first_wired = self._wired_value(first.stdout)
        second_wired = self._wired_value(second.stdout)
        self.assertNotEqual(first_wired, second_wired)
        self.assertEqual(first_wired, 100000)
        self.assertEqual(second_wired, 113259)

    def test_fake_sysctl_reports_swap_used_for_the_current_snapshot(self):
        mem_scenario_path = os.path.join(self.tmp, "swap_scenario.json")
        with open(mem_scenario_path, "w") as handle:
            json.dump({"snapshots": [
                {"free": 1000000, "wired": 100000, "compressions": 500,
                 "decompressions": 400, "swap_used_mb": 512},
            ]}, handle)
        index_path = os.path.join(self.tmp, "swap_index")
        env = dict(os.environ)
        env["FAKE_MEM_SCENARIO"] = mem_scenario_path
        env["FAKE_MEM_INDEX"] = index_path

        subprocess.run([FAKE_VM_STAT], env=env, capture_output=True,
                       text=True, check=True)
        sysctl_result = subprocess.run([FAKE_SYSCTL, "-n", "vm.swapusage"],
                                       env=env, capture_output=True,
                                       text=True, check=True)

        self.assertIn("used = 512.00M", sysctl_result.stdout)

    @staticmethod
    def _wired_value(vm_stat_output):
        for line in vm_stat_output.splitlines():
            if line.startswith("Pages wired down:"):
                _, _, value = line.partition(":")
                return int(value.strip().rstrip("."))
        raise AssertionError("no 'Pages wired down' line in: %r" % vm_stat_output)

    def test_help_without_backend_prints_env_var_names_and_exits_zero(self):
        result = subprocess.run([sys.executable, CREEP_PY, "--help"],
                                capture_output=True, text=True, timeout=10)

        self.assertEqual(result.returncode, 0)
        self.assertIn("DEPTH_LIST", result.stdout)
        self.assertIn("STALL_S", result.stdout)

    def test_llama_help_prints_the_llama_docstring_and_exits_zero(self):
        result = subprocess.run([sys.executable, CREEP_PY, "llama", "--help"],
                                capture_output=True, text=True, timeout=10)

        self.assertEqual(result.returncode, 0)
        self.assertIn("llama-server", result.stdout)
        self.assertIn("ENDPOINT=completion", result.stdout)

    def test_no_backend_exits_two(self):
        result = subprocess.run([sys.executable, CREEP_PY],
                                capture_output=True, text=True, timeout=10)

        self.assertEqual(result.returncode, 2)

    def test_unknown_backend_exits_two(self):
        result = subprocess.run([sys.executable, CREEP_PY, "bogus"],
                                capture_output=True, text=True, timeout=10)

        self.assertEqual(result.returncode, 2)

    def test_unknown_backend_with_help_still_exits_two(self):
        result = subprocess.run([sys.executable, CREEP_PY, "bogus", "--help"],
                                capture_output=True, text=True, timeout=10)

        self.assertEqual(result.returncode, 2)

    def test_depth_list_unset_exits_two(self):
        env = dict(os.environ)
        env.pop("DEPTH_LIST", None)
        env["SWEEP_BASE"] = self.base_url
        env["MODEL"] = "fake"

        result = subprocess.run([sys.executable, CREEP_PY, "llama"], env=env,
                                capture_output=True, text=True, timeout=10)

        self.assertEqual(result.returncode, 2)

    def test_vm_stat_missing_from_path_exits_two_naming_vm_stat(self):
        env = dict(os.environ)
        env["DEPTH_LIST"] = "200,400,600"
        env["SWEEP_BASE"] = self.base_url
        env["MODEL"] = "fake"
        env["STEP_PAUSE_S"] = "0"
        env["PATH"] = "/usr/bin:/bin"

        result = subprocess.run([sys.executable, CREEP_PY, "llama"], env=env,
                                capture_output=True, text=True, timeout=10)

        self.assertEqual(result.returncode, 2)
        self.assertIn("vm_stat", result.stderr)

    def test_default_run_prints_the_llama_shape_and_no_ceiling_found(self):
        result = self.run_creep("llama")

        self.assertEqual(result.returncode, 0)
        lines = result.stdout.splitlines()
        self.assertEqual(
            lines[0],
            "llama-server, endpoint=completion thinking=n/a (no template) "
            "contexts=1 pause=0s")
        start_index = next(
            index for index, line in enumerate(lines)
            if line.startswith("start:"))

        fixture_path = os.path.join(
            TESTS_DIR, "fixtures", "creep-qwen38-gguf-short-q8.tsv")
        with open(fixture_path) as handle:
            fixture_header = handle.read().splitlines()[2]
        self.assertEqual(lines[start_index + 1], fixture_header)

        self.assertEqual(lines[-1], "no ceiling found up to 600")
        rows = [line for line in lines[start_index + 2:-1]
               if line.startswith("A\t")]
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(len(row.split("\t")), 9)

    def test_fast_pause_prints_warning_before_the_first_row(self):
        result = self.run_creep("llama")

        lines = result.stdout.splitlines()
        warning_index = next(
            index for index, line in enumerate(lines)
            if line.startswith("WARNING:"))
        first_row_index = next(
            index for index, line in enumerate(lines)
            if line.startswith("A\t"))
        self.assertLess(warning_index, first_row_index)

    def test_rate_below_floor_stops_the_sweep_and_keeps_earlier_rows(self):
        self.restart_server({"rates": [30, 5], "flavor": "llama", "probe": "ok"})

        result = self.run_creep("llama")

        self.assertEqual(result.returncode, 0)
        lines = result.stdout.splitlines()
        rows = [line for line in lines if line.startswith("A\t")]
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0].split("\t")[2].startswith("30"))
        self.assertTrue(rows[1].split("\t")[2].startswith("5"))
        stop_line = lines[-1]
        self.assertRegex(stop_line, r"^STOP: below 8 tok/s at depth \d+$")
        self.assertRegex(stop_line, STOP_LINE_RE)

    def test_request_failure_stops_the_sweep_with_one_row_before_it(self):
        self.restart_server({"rates": [30, 28, 26], "flavor": "llama",
                             "probe": "ok", "at": {"1": "fail"}})

        result = self.run_creep("llama")

        self.assertEqual(result.returncode, 42)
        lines = result.stdout.splitlines()
        rows = [line for line in lines if line.startswith("A\t")]
        self.assertEqual(len(rows), 1)
        stop_line = lines[-1]
        self.assertIn("STOP: request failed", stop_line)
        self.assertRegex(stop_line, STOP_LINE_RE)

    def test_empty_reply_stops_the_sweep_as_a_silent_halt(self):
        self.restart_server({"rates": [30, 28, 26], "flavor": "llama",
                             "probe": "ok", "at": {"1": "empty"}})

        result = self.run_creep("llama")

        self.assertEqual(result.returncode, 42)
        stop_line = result.stdout.splitlines()[-1]
        self.assertIn("STOP: silent halt", stop_line)
        self.assertRegex(stop_line, STOP_LINE_RE)

    def test_growing_swap_stops_the_sweep(self):
        self.write_mem_scenario([
            {"free": 1000000, "wired": 100000, "compressions": 500,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 500,
             "decompressions": 400, "swap_used_mb": 5},
        ])

        result = self.run_creep("llama")

        self.assertEqual(result.returncode, 42)
        stop_line = result.stdout.splitlines()[-1]
        self.assertIn("STOP: swap grew", stop_line)
        self.assertRegex(stop_line, STOP_LINE_RE)

    def test_sustained_compaction_without_recovery_stops_the_sweep(self):
        self.restart_server({"rates": [30, 25, 20, 15], "flavor": "llama",
                             "probe": "ok"})
        self.write_mem_scenario([
            {"free": 1000000, "wired": 100000, "compressions": 500,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 750,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 1050,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 1350,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 1650,
             "decompressions": 400, "swap_used_mb": 0},
        ])

        result = self.run_creep("llama", env={"DEPTH_LIST": "200,400,600,800"})

        self.assertEqual(result.returncode, 42)
        stop_line = result.stdout.splitlines()[-1]
        self.assertRegex(
            stop_line,
            r"^STOP: 200 or more pages compressed or decompressed on 3 "
            r"steps in a row, and speed did not come back, by depth \d+$")
        self.assertRegex(stop_line, STOP_LINE_RE)

    def test_sustained_compaction_with_recovery_does_not_stop_the_sweep(self):
        self.restart_server({"rates": [30, 30, 30, 30], "flavor": "llama",
                             "probe": "ok"})
        self.write_mem_scenario([
            {"free": 1000000, "wired": 100000, "compressions": 500,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 750,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 1050,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 1350,
             "decompressions": 400, "swap_used_mb": 0},
            {"free": 1000000, "wired": 100000, "compressions": 1650,
             "decompressions": 400, "swap_used_mb": 0},
        ])

        result = self.run_creep("llama", env={"DEPTH_LIST": "200,400,600,800"})

        self.assertEqual(result.returncode, 0)
        lines = result.stdout.splitlines()
        self.assertFalse(any(line.startswith("STOP:") for line in lines))
        self.assertEqual(lines[-1], "no ceiling found up to 800")

    def test_stall_then_probe_answers_and_the_sweep_continues(self):
        self.restart_server({"rates": [30, 28, 26], "flavor": "llama",
                             "probe": "ok", "at": {"1": "hang"}, "hang_s": 3})

        result = self.run_creep("llama")

        self.assertEqual(result.returncode, 0)
        lines = result.stdout.splitlines()
        stall_index = next(
            index for index, line in enumerate(lines)
            if line.startswith("STALL: no output for"))
        probe_index = next(
            index for index, line in enumerate(lines)
            if index > stall_index and "the probe answered" in line
            and "alive" in line)
        row_index = next(
            index for index, line in enumerate(lines)
            if index > probe_index and line.startswith("A\t"))

        self.assertTrue(lines[probe_index].startswith("  "))
        self.assertEqual(lines[-1], "no ceiling found up to 600")
        self.assertGreater(row_index, probe_index)

    def test_dead_server_after_failed_probes_stops_the_sweep(self):
        self.restart_server({"rates": [30, 28, 26], "flavor": "llama",
                             "probe": "timeout", "at": {"1": "die"}})

        result = self.run_creep("llama", timeout=15)

        self.assertEqual(result.returncode, 42)
        lines = result.stdout.splitlines()
        stall_indexes = [index for index, line in enumerate(lines)
                         if line.startswith("STALL: no output for")]
        self.assertEqual(len(stall_indexes), 2)
        failed_probe_index = next(
            index for index, line in enumerate(lines)
            if "probe 1 of 2 failed" in line)
        self.assertGreater(failed_probe_index, stall_indexes[0])
        self.assertLess(failed_probe_index, stall_indexes[1])
        stop_line = lines[-1]
        self.assertIn("STOP: server dead", stop_line)
        self.assertRegex(stop_line, STOP_LINE_RE)

    def test_death_signature_in_server_log_stops_the_sweep(self):
        self.restart_server({"rates": [30, 28, 26], "flavor": "mlx",
                             "probe": "ok", "at": {"1": "hang"}, "hang_s": 4})

        fixture_path = os.path.join(
            FIXTURES_DIR, "server-qwen36-mlx-creep.log")
        with open(fixture_path) as handle:
            fixture_lines = handle.readlines()

        server_log_path = os.path.join(self.tmp, "mlx_server.log")
        with open(server_log_path, "w") as handle:
            handle.writelines(fixture_lines[:60])

        index_path = os.path.join(self.tmp, "mem_index")
        if os.path.exists(index_path):
            os.remove(index_path)

        env = dict(os.environ)
        env["PATH"] = self.bin_dir + os.pathsep + env.get("PATH", "")
        env["SWEEP_BASE"] = self.base_url
        env["DEPTH_LIST"] = "200,400,600"
        env["STEP_PAUSE_S"] = "0"
        env["STALL_S"] = "1"
        env["PROBE_TIMEOUT_S"] = "1"
        env["MODEL"] = "fake"
        env["SERVER_LOG"] = server_log_path
        env["FAKE_MEM_SCENARIO"] = self.mem_scenario_path
        env["FAKE_MEM_INDEX"] = index_path

        process = subprocess.Popen(
            [sys.executable, CREEP_PY, "mlx"], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1)

        output_lines = []
        first_row_seen = threading.Event()

        def read_output():
            for line in process.stdout:
                output_lines.append(line.rstrip("\n"))
                if line.startswith("A\t"):
                    first_row_seen.set()

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        try:
            self.assertTrue(first_row_seen.wait(10),
                            "no row appeared before the wait timed out")
            time.sleep(1.5)

            with open(server_log_path, "a") as handle:
                handle.writelines(fixture_lines[60:])

            process.wait(timeout=15)
        finally:
            if process.poll() is None:
                process.kill()
            reader.join(timeout=5)
            process.stdout.close()

        self.assertEqual(process.returncode, 42)
        stop_lines = [line for line in output_lines
                     if line.startswith("STOP:")]
        self.assertEqual(len(stop_lines), 1)
        self.assertIn("generation thread died in %s" % server_log_path,
                      stop_lines[0])
        self.assertRegex(stop_lines[0], STOP_LINE_RE)

    def test_round_robin_grows_two_contexts_without_prefix_collision(self):
        result = self.run_creep("llama", env={"N_CONTEXTS": "2"})

        self.assertEqual(result.returncode, 0)
        lines = result.stdout.splitlines()
        labels = [line[0] for line in lines if line.startswith(("A\t", "B\t"))]
        self.assertEqual(labels, ["A", "B", "A", "B", "A", "B"])

        steps = [entry for entry in self.read_request_log()
                if entry["kind"] == "step"]
        self.assertEqual(len(steps), 6)
        context_a = [steps[index]["prompt"] for index in (0, 2, 4)]
        context_b = [steps[index]["prompt"] for index in (1, 3, 5)]
        for prompts in (context_a, context_b):
            for earlier, later in zip(prompts, prompts[1:]):
                self.assertTrue(later.startswith(earlier))

        block_re = re.compile(r"parse_record_(\d{6})")
        a_blocks = [int(number) for prompt in context_a
                   for number in block_re.findall(prompt)]
        b_blocks = [int(number) for prompt in context_b
                   for number in block_re.findall(prompt)]
        self.assertTrue(a_blocks)
        self.assertTrue(b_blocks)
        self.assertLess(max(a_blocks), creep_module.RANGE_SPAN)
        self.assertGreaterEqual(min(b_blocks), creep_module.RANGE_SPAN)

    def test_llama_completion_backend_hits_completion_path_and_carries_the_rate(self):
        result = self.run_creep("llama")

        self.assertEqual(result.returncode, 0)
        steps = [entry for entry in self.read_request_log()
                if entry["kind"] == "step"]
        self.assertTrue(steps)
        self.assertTrue(all(entry["path"] == "/completion" for entry in steps))

        first_row = next(line for line in result.stdout.splitlines()
                         if line.startswith("A\t"))
        self.assertEqual(float(first_row.split("\t")[2]), 30.0)

    def test_llama_chat_backend_hits_chat_path_and_reads_rate_from_timings(self):
        result = self.run_creep("llama", env={"ENDPOINT": "chat"})

        self.assertEqual(result.returncode, 0)
        steps = [entry for entry in self.read_request_log()
                if entry["kind"] == "step"]
        self.assertTrue(steps)
        self.assertTrue(all(entry["path"] == "/v1/chat/completions"
                            for entry in steps))

        first_row = next(line for line in result.stdout.splitlines()
                         if line.startswith("A\t"))
        self.assertEqual(float(first_row.split("\t")[2]), 30.0)

    def test_lmstudio_backend_hits_chat_path_and_paces_the_rate_from_chunk_gaps(self):
        self.restart_server({"rates": [10, 10, 10], "flavor": "lmstudio",
                             "probe": "ok"})

        result = self.run_creep("lmstudio")

        self.assertEqual(result.returncode, 0)
        steps = [entry for entry in self.read_request_log()
                if entry["kind"] == "step"]
        self.assertTrue(steps)
        self.assertTrue(all(entry["path"] == "/v1/chat/completions"
                            for entry in steps))

        first_row = next(line for line in result.stdout.splitlines()
                         if line.startswith("A\t"))
        measured = float(first_row.split("\t")[2])
        self.assertLess(abs(measured - 10) / 10, 0.25)

    def test_mlx_backend_hits_completions_path_and_warns_without_server_log(self):
        self.restart_server({"rates": [10, 10, 10], "flavor": "mlx",
                             "probe": "ok"})

        result = self.run_creep("mlx", env={"SERVER_LOG": ""})

        self.assertEqual(result.returncode, 0)
        self.assertIn("WARNING: SERVER_LOG unset.", result.stdout)
        steps = [entry for entry in self.read_request_log()
                if entry["kind"] == "step"]
        self.assertTrue(steps)
        self.assertTrue(all(entry["path"] == "/v1/completions"
                            for entry in steps))

        first_row = next(line for line in result.stdout.splitlines()
                         if line.startswith("A\t"))
        measured = float(first_row.split("\t")[2])
        self.assertLess(abs(measured - 10) / 10, 0.25)

    def test_stop_lines_match_the_real_fixtures_stop_grammar(self):
        fixture_names = [
            "creep-qwen38-gguf-short-q8.tsv",
            "creep-qwen36-gguf-full-q8.tsv",
            "creep-gemma12-lmstudio-131k.tsv",
        ]
        for name in fixture_names:
            with open(os.path.join(FIXTURES_DIR, name)) as handle:
                stop_lines = [line for line in handle.read().splitlines()
                             if line.startswith("STOP:")]
            self.assertEqual(len(stop_lines), 1, name)
            self.assertRegex(stop_lines[0], STOP_LINE_RE, name)


if __name__ == "__main__":
    unittest.main()
