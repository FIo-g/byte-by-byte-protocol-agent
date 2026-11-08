#!/usr/bin/env python3
"""N06 known practice capture of normal SUM sessions; never an inferred-protocol score."""
import hashlib
import json
import platform
import re
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Expected sums come from the known practice spec, never from the server under test.
SESSIONS = [([1, 2, 3], 6), ([10, 20], 30), ([65535, 65535], 131070), ([1000], 1000), ([7, 7, 7, 7, 7], 35)]
REPO = Path(__file__).resolve().parent.parent


def now():
    return datetime.now(timezone.utc).isoformat()


def sha256(filename):
    with open(filename, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(*args):
    return subprocess.check_output(["git", "-C", str(REPO), *args], text=True).strip()


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    return process.poll() is not None


def main():
    if len(sys.argv) != 4:
        print("Usage: python3 scripts/n06-capture.py <server-binary> <client-binary> <new-result.json>")
        return 2
    target = Path(sys.argv[3]).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8"):
        pass
    pcap = target.with_suffix(".pcap")
    result = {"task": "N06", "classification": "practice capture of normal sessions (known protocol)",
              "started_at": now(), "success": False, "stage": "input",
              "argv": sys.argv, "python": platform.python_version(), "experiment_score": False}
    server = tcpdump = None
    try:
        server_bin = Path(sys.argv[1]).resolve(strict=True)
        client_bin = Path(sys.argv[2]).resolve(strict=True)
        result["inputs"] = {"server": {"path": str(server_bin), "sha256": sha256(server_bin)},
                            "client": {"path": str(client_bin), "sha256": sha256(client_bin)}}
        result["code_commit"] = git("rev-parse", "HEAD")
        result["code_dirty"] = bool(git("status", "--porcelain"))
        result["gcc"] = subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0]
        version = subprocess.run(["tcpdump", "--version"], capture_output=True, text=True)
        result["tcpdump_version"] = (version.stdout + version.stderr).splitlines()[0]

        with pcap.open("x"):
            pass
        # Probe before tcpdump starts so the probe connection is not in the capture.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        result["port"] = port
        result["stage"] = "server_start"
        result["server_command"] = [str(server_bin), str(port)]
        with (target.parent / (target.name + ".server.stderr")).open("x") as log:
            server = subprocess.Popen(result["server_command"], stdout=log, stderr=log)
        deadline = time.monotonic() + 5
        while True:
            if server.poll() is not None:
                raise RuntimeError("Practice server exited before connection")
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                break
            except ConnectionRefusedError:
                if time.monotonic() > deadline:
                    raise TimeoutError("Practice server did not listen within 5 seconds")
                time.sleep(0.02)

        result["stage"] = "tcpdump_start"
        tcpdump_cmd = ["tcpdump", "-i", "lo", "-p", "-n", "-U", "-s", "0", "-Z", "root",
                       "-w", str(pcap), f"tcp port {port}"]
        result["tcpdump_command"] = tcpdump_cmd
        tcpdump_log = target.parent / (target.name + ".tcpdump.stderr")
        with tcpdump_log.open("x") as log:
            tcpdump = subprocess.Popen(tcpdump_cmd, stdout=log, stderr=log)
        deadline = time.monotonic() + 5
        while "listening on" not in tcpdump_log.read_text(encoding="utf-8", errors="replace"):
            if tcpdump.poll() is not None:
                raise RuntimeError("tcpdump exited before capture started")
            if time.monotonic() > deadline:
                raise TimeoutError("tcpdump did not start capture within 5 seconds")
            time.sleep(0.05)

        result["stage"] = "sessions"
        result["sessions"] = []
        for numbers, expected in SESSIONS:
            args = [str(port), *map(str, numbers)]
            run = subprocess.run([str(client_bin), *args], capture_output=True, text=True, timeout=10)
            result["sessions"].append({"args": args, "expected": expected,
                                       "stdout": run.stdout, "exit_code": run.returncode})
            if run.returncode != 0 or run.stdout != f"sum={expected}\n":
                raise RuntimeError(f"Client session did not match expected sum: {args}")

        # shortcut: fixed wait because SIGINT drops packets still held in the kernel capture block; 0.5 s lost them under Docker Desktop, 2 s captured all, so upgrade to an explicit end marker if this flakes.
        time.sleep(2)
        tcpdump.send_signal(signal.SIGINT)
        try:
            tcpdump.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tcpdump.kill()
            tcpdump.wait()
        match = re.search(r"(\d+) packets captured", tcpdump_log.read_text(encoding="utf-8", errors="replace"))
        if match is None:
            raise RuntimeError("tcpdump did not report captured packets")
        result["packets_captured"] = int(match.group(1))

        result["stage"] = "verify"
        syn = subprocess.run(["tcpdump", "-nn", "-r", str(pcap),
                              "tcp[tcpflags] & (tcp-syn|tcp-ack) == tcp-syn"],
                             capture_output=True, text=True, check=True)
        result["syn_count"] = len([line for line in syn.stdout.splitlines() if line.strip()])
        if result["syn_count"] != len(SESSIONS):
            raise RuntimeError(f"Expected {len(SESSIONS)} SYN packets, saw {result['syn_count']}")
        if sha256(server_bin) != result["inputs"]["server"]["sha256"] or \
                sha256(client_bin) != result["inputs"]["client"]["sha256"]:
            raise RuntimeError("Practice binary changed during capture")
        result["pcap"] = {"path": str(pcap), "sha256": sha256(pcap), "bytes": pcap.stat().st_size}
        result.update(success=True, stage="complete")
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if tcpdump is not None:
            result["tcpdump_stopped"] = stop(tcpdump)
        if server is not None:
            result["server_stopped"] = stop(server)
        result["finished_at"] = now()
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"task": "N06", "success": result["success"], "stage": result["stage"], "result": str(target)}))
    return 0 if result["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
