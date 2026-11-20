// 웹이 쓰는 그 서버를 N07 평가기(--target)로 평가하고 결과 JSON을 읽는다.
// 평가기는 인자 배열로만 실행한다(shell 없음). 결과 파일 이름은 서버가 만든다.
// 판정: success:true는 "절차가 끝났다"는 뜻일 뿐이다. 통과 여부는 summary.all_pass로 본다.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_EVALUATOR = ["python3", "scripts/n07-evaluate.py"];
export const DEFAULT_CASES = "practice/n06/cases.json";

const STATUS_TEXT = {
  all_pass: "평가 완료 · 전부 통과",
  completed_with_mismatch: "평가 완료 · 불일치 있음",
  run_failed: "평가 실행 실패",
  timeout: "평가 시간 초과",
};

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

const tail = (text, limit = 2000) => (text.length > limit ? `…${text.slice(-limit)}` : text);

export function runEvaluation({ root, target, server = null, evaluator = DEFAULT_EVALUATOR, cases = DEFAULT_CASES, timeoutMs = 60000 }) {
  const outFile = `runs/n08/eval-web-${stamp()}-${randomBytes(3).toString("hex")}.json`;
  const targetText = `${target.host}:${target.port}`;
  const args = [...evaluator.slice(1), "--cases", cases, "--target", targetText, "--out", outFile];
  const started = Date.now();
  const base = { target: targetText, server, out_file: outFile, command: [evaluator[0], ...args], started_at: new Date(started).toISOString() };

  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const done = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = fields.status;
      resolve({ ...base, exit_code: null, signal: null, result: null, stderr_tail: tail(stderr), error_message: null, ...fields, status_text: STATUS_TEXT[status], duration_ms: Date.now() - started });
    };

    try { mkdirSync(join(root, "runs/n08"), { recursive: true }); } catch (error) {
      return done({ status: "run_failed", error_message: `결과 폴더를 만들지 못했습니다: ${error.message}` });
    }

    let child;
    try {
      child = spawn(evaluator[0], args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: process.env });
    } catch (error) {
      return done({ status: "run_failed", error_message: `평가기를 실행하지 못했습니다: ${error.message}` });
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = tail(stderr + chunk.toString("utf8"), 8000); });
    child.on("error", (error) => done({ status: "run_failed", error_message: `평가기를 실행하지 못했습니다: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (timedOut) return done({ status: "timeout", exit_code: code, signal: signal ?? "SIGKILL", error_message: `${timeoutMs} ms 안에 끝나지 않아 평가기를 종료했습니다.` });
      const path = join(root, outFile);
      let result = null;
      if (existsSync(path)) {
        try { result = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
          return done({ status: "run_failed", exit_code: code, signal, error_message: `결과 JSON을 읽지 못했습니다: ${error.message}` });
        }
      }
      if (!result) return done({ status: "run_failed", exit_code: code, signal, error_message: `평가기가 결과 JSON을 남기지 않았습니다(종료 코드 ${code}).` });
      if (result.success !== true) {
        return done({ status: "run_failed", exit_code: code, signal, result, error_message: `평가가 끝까지 진행되지 않았습니다 (stage: ${result.stage}).` });
      }
      if (result.summary?.all_pass === true && code === 0) return done({ status: "all_pass", exit_code: code, signal, result });
      if (result.summary?.all_pass === false) return done({ status: "completed_with_mismatch", exit_code: code, signal, result });
      return done({ status: "run_failed", exit_code: code, signal, result, error_message: `종료 코드 ${code}와 결과 요약이 맞지 않습니다.` });
    });
  });
}
