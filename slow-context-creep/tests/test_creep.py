"""test_creep.py runs creep.py against the fake server and fake memory tools."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SLOW_CONTEXT_CREEP_DIR = os.path.dirname(TESTS_DIR)
HELPERS_DIR = os.path.join(TESTS_DIR, "helpers")
CREEP_PY = os.path.join(SLOW_CONTEXT_CREEP_DIR, "creep.py")
FAKE_SERVER_PY = os.path.join(HELPERS_DIR, "fake-server.py")
FAKE_VM_STAT = os.path.join(HELPERS_DIR, "fake-vm_stat")
FAKE_SYSCTL = os.path.join(HELPERS_DIR, "fake-sysctl")


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
        subprocess.run(["rm", "-rf", self.tmp])

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


if __name__ == "__main__":
    unittest.main()
