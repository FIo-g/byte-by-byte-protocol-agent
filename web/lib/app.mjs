// HTTP 라우팅, 입력 검증, 로컬 전용 보안 규칙.
// 접속 대상(target)은 서버 설정으로 고정하고 요청으로 바꿀 수 없다.
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { sendRequest } from "./client.mjs";
import { DEFAULT_EVALUATOR, runEvaluation } from "./evaluate.mjs";
import { InputError, encodeRequest } from "./protocol.mjs";
import { QueueFullError, createQueue } from "./queue.mjs";

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY = 4096;

class HttpError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}

function hostName(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader) return null;
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1).toLowerCase();
  return hostHeader.split(":")[0].toLowerCase();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    let size = 0;
    const chunks = [];
    let tooLarge = Number.isFinite(declared) && declared > MAX_BODY;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => (tooLarge ? reject(new HttpError(413, "body_too_large", `본문은 ${MAX_BODY}바이트까지입니다.`)) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

async function readJsonObject(req, allowed) {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    req.resume();
    throw new HttpError(415, "unsupported_media_type", "Content-Type: application/json만 받습니다.");
  }
  const text = await readBody(req);
  let body;
  try { body = text.trim() === "" ? {} : JSON.parse(text); } catch {
    throw new HttpError(400, "invalid_json", "본문이 JSON이 아닙니다.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body", "본문은 JSON 객체여야 합니다.");
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, "unknown_field", `허용하지 않는 필드: ${unknown.join(", ")}`);
  return body;
}

export function createApp({
  root, spec, practiceServer, target, publicDir, log = () => {},
  evaluator = DEFAULT_EVALUATOR, evaluationTimeoutMs = 60000, sendTimeoutMs = 3000, maxWaiting = 8,
}) {
  const queue = createQueue({ maxWaiting });
  let latestEvaluation = null;
  const serverInfo = () => ({ ...practiceServer.snapshot(), host: target.host, port: target.port });

  function send(res, status, body, headers = {}) {
    const isBuffer = Buffer.isBuffer(body);
    const payload = isBuffer ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": isBuffer ? headers["Content-Type"] : "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  function requireRunning() {
    const server = practiceServer.snapshot();
    if (server.state !== "running") throw new HttpError(503, "server_unavailable", server.message ?? `연습 서버 상태: ${server.state}`);
  }

  async function inQueue(task) {
    try { return await queue.run(task); } catch (error) {
      if (error instanceof QueueFullError) throw new HttpError(429, "queue_full", error.message);
      throw error;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    const path = url.pathname;
    const host = hostName(req.headers.host);
    if (!LOCAL_HOSTS.has(host)) throw new HttpError(403, "forbidden_host", "로컬 주소(localhost/127.0.0.1)로만 접속할 수 있습니다.");
    if (req.method === "POST" && req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) {
      throw new HttpError(403, "forbidden_origin", "다른 출처의 요청은 받지 않습니다.");
    }

    if (req.method === "GET") {
      if (path === "/api/health") {
        return send(res, 200, {
          ok: true,
          server: serverInfo(),
          spec: { name: spec.name, format: spec.format, classification: spec.classification, experiment_score: spec.experiment_score },
          queue: { running: queue.running, waiting: queue.waiting },
          evaluator: { command: evaluator, script_exists: evaluator.length > 1 ? existsSync(join(root, evaluator[1])) : null },
        });
      }
      if (path === "/api/spec") return send(res, 200, spec);
      if (path === "/api/evaluate/latest") return send(res, 200, { evaluation: latestEvaluation });
      const file = STATIC[path];
      if (!file) throw new HttpError(404, "not_found", "없는 경로입니다.");
      return send(res, 200, readFileSync(join(publicDir, file[0])), { "Content-Type": file[1] });
    }

    if (req.method === "POST" && path === "/api/send") {
      const body = await readJsonObject(req, ["numbers"]);
      try {
        // 서버에서 입력을 다시 검증한다(정수, 0~65535, 1~32개). 잘못되면 연결하지 않는다.
        encodeRequest(spec, body.numbers, { minCount: 1 });
      } catch (error) {
        if (error instanceof InputError) throw new HttpError(400, "invalid_input", error.message);
        throw error;
      }
      requireRunning();
      const result = await inQueue(() => sendRequest({ spec, numbers: body.numbers, host: target.host, port: target.port, timeoutMs: sendTimeoutMs, minCount: 1 }));
      log({ level: "info", message: "send", outcome: result.outcome, request_hex: result.request.hex, response_hex: result.response.hex });
      return send(res, 200, { result, server: serverInfo() });
    }

    if (req.method === "POST" && path === "/api/evaluate") {
      await readJsonObject(req, []);
      requireRunning();
      const evaluation = await inQueue(() => runEvaluation({ root, target, server: serverInfo(), evaluator, timeoutMs: evaluationTimeoutMs }));
      latestEvaluation = evaluation;
      log({ level: "info", message: "evaluate", status: evaluation.status, out_file: evaluation.out_file });
      return send(res, 200, { evaluation });
    }

    if (req.method === "POST") throw new HttpError(404, "not_found", "없는 경로입니다.");
    throw new HttpError(405, "method_not_allowed", `${req.method}는 허용하지 않습니다.`);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return send(res, error.status, { error: error.error, message: error.message });
      log({ level: "error", message: "unhandled", error: String(error?.stack ?? error) });
      return send(res, 500, { error: "internal_error", message: "백엔드 오류" });
    });
  });
}
