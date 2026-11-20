// 연습 서버(runs/n06/practice-server) 프로세스 관리. 바이너리 SHA-256을 기록한다.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function canConnect(host, port) {
  return new Promise((done) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => { socket.end(); done(true); });
    socket.once("error", () => done(false));
  });
}

export function createPracticeServer({ binary, relativeBinary, port, host = "127.0.0.1", startTimeoutMs = 5000 }) {
  const label = relativeBinary ?? binary;
  let child = null;
  let state = { state: "stopped", pid: null, sha256: null, binary: label, host, port, message: null };

  const set = (patch) => { state = { ...state, ...patch }; };

  return {
    snapshot: () => ({ ...state }),

    async start() {
      if (!existsSync(binary)) {
        set({
          state: "binary_missing",
          message: `${label} 가 없습니다. 먼저 빌드하세요: docker compose -f compose.n05.yaml run --rm n05 gcc -O0 -fno-inline -Wall -Wextra -o runs/n06/practice-server practice/n06/server.c`,
        });
        return this.snapshot();
      }
      set({ sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") });
      try {
        child = spawn(binary, [String(port)], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (error) {
        set({ state: "failed", message: `서버를 실행하지 못했습니다: ${error.message}` });
        return this.snapshot();
      }
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
      const spawned = child;
      spawned.on("error", (error) => set({ state: "failed", pid: null, message: `서버를 실행하지 못했습니다: ${error.message}` }));
      spawned.on("exit", (code, signal) => {
        if (child === spawned) child = null;
        if (state.state !== "stopped") set({ state: "exited", pid: null, message: `서버가 종료됐습니다(code ${code}, signal ${signal}). ${stderr.trim()}`.trim() });
      });
      set({ state: "starting", pid: spawned.pid ?? null, message: null });

      const deadline = Date.now() + startTimeoutMs;
      while (Date.now() < deadline) {
        if (state.state !== "starting") return this.snapshot();
        if (await canConnect(host, port)) {
          set({ state: "running", message: null });
          return this.snapshot();
        }
        await sleep(50);
      }
      set({ state: "failed", message: `${startTimeoutMs} ms 안에 ${host}:${port}에서 접속을 받지 않았습니다. ${stderr.trim()}`.trim() });
      return this.snapshot();
    },

    async stop() {
      const running = child;
      set({ state: "stopped", pid: null });
      if (!running || running.exitCode !== null) return;
      const exited = new Promise((done) => running.once("exit", done));
      running.kill("SIGTERM");
      const killed = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]);
      if (!killed) {
        running.kill("SIGKILL");
        await exited;
      }
    },
  };
}
