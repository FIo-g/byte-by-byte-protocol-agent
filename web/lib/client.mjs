// TCP 클라이언트. data 이벤트 하나를 메시지 하나로 보지 않는다:
// 헤더를 모아 length를 읽고, 그만큼 더 모아 프레임 하나를 완성한다.
// 결과: ok / error_frame / timeout / eof_no_response / truncated / protocol_violation / connection_error / connect_failed
import net from "node:net";
import { decodeResponse, encodeRequest, parseResponseHeader, toHex } from "./protocol.mjs";

const OUTCOME_TEXT = {
  ok: "정상 응답",
  error_frame: "서버가 오류 프레임을 보냄",
  timeout: "시간 초과 (응답이 끝까지 오지 않음)",
  eof_no_response: "응답 없이 서버가 연결을 닫음",
  truncated: "응답이 도중에 끊김",
  protocol_violation: "명세와 다른 응답",
  connection_error: "연결 오류",
  connect_failed: "연결 실패",
};

const round = (ms) => Math.round(ms * 100) / 100;

export async function sendRequest({
  spec, numbers, host, port, timeoutMs = 3000, settleMs = 500, minCount = 1, maxBytes = 4096,
}) {
  const request = encodeRequest(spec, numbers, { minCount }); // 잘못된 입력은 여기서 InputError(연결 전)
  const started = process.hrtime.bigint();

  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let connected = false;
    let closedByServer = false;
    let errorCode = null;
    let frameLength = null;
    let frameDone = false;
    let finished = false;
    let settleTimer = null;
    const notes = [];

    const socket = net.createConnection({ host, port });
    const mainTimer = setTimeout(() => {
      if (!connected) finish("connect_failed", { error_code: "ETIMEDOUT", error_message: `${timeoutMs} ms 안에 연결하지 못했습니다.` });
      else finish("timeout", { error_message: `${timeoutMs} ms 안에 응답 프레임이 완성되지 않았습니다.` });
    }, timeoutMs);

    function received() { return Buffer.concat(chunks); }

    function finish(outcome, extra = {}) {
      if (finished) return;
      finished = true;
      clearTimeout(mainTimer);
      clearTimeout(settleTimer);
      socket.destroy();
      const all = received();
      let frameHex = null;
      let trailingHex = null;
      let decoded = null;
      let violation = extra.violation;
      if (frameDone) {
        const frame = all.subarray(0, frameLength);
        frameHex = toHex(frame);
        trailingHex = toHex(all.subarray(frameLength));
        if (trailingHex) notes.push(`프레임 뒤에 ${all.length - frameLength}바이트가 더 왔습니다: ${trailingHex.slice(0, 64)}${trailingHex.length > 64 ? "…" : ""}`);
        decoded = decodeResponse(spec, frame);
        if (!decoded.ok) { outcome = "protocol_violation"; violation = decoded.reason; decoded = null; }
        else if (decoded.role === "error") outcome = "error_frame";
      }
      if (extra.note) notes.push(extra.note);
      resolve({
        ok: outcome === "ok",
        outcome,
        outcome_text: OUTCOME_TEXT[outcome],
        ...(violation ? { violation } : {}),
        ...(extra.error_message ? { error_message: extra.error_message } : {}),
        request: { message: request.message, hex: request.hex, fields: request.fields, bytes: request.bytes.length },
        response: { hex: toHex(all), frame_hex: frameHex, trailing_hex: trailingHex, bytes_received: total, decoded },
        connection: {
          host, port, connected,
          closed_by_server: connected ? closedByServer : null,
          error_code: extra.error_code ?? errorCode,
        },
        elapsed_ms: round(Number(process.hrtime.bigint() - started) / 1e6),
        notes,
      });
    }

    function frameFinished(extra) { finish("ok", extra); }

    socket.on("connect", () => {
      connected = true;
      socket.write(request.bytes);
    });

    socket.on("data", (chunk) => {
      if (finished) return;
      chunks.push(chunk);
      total += chunk.length;
      if (!frameDone) {
        const all = received();
        if (frameLength === null && all.length >= spec.header.size) {
          const head = parseResponseHeader(spec, all.subarray(0, spec.header.size));
          if (!head.ok) return finish("protocol_violation", { violation: head.reason });
          frameLength = head.totalLength;
        }
        if (frameLength !== null && all.length >= frameLength) {
          frameDone = true;
          clearTimeout(mainTimer);
          // 프레임은 완성됐다. 서버가 연결을 닫는지 잠깐 지켜본다.
          settleTimer = setTimeout(() => frameFinished({ note: `서버가 ${settleMs} ms 안에 연결을 닫지 않았습니다.` }), settleMs);
        }
      }
      if (total > maxBytes) {
        if (frameDone) frameFinished({ note: `받은 바이트가 한도(${maxBytes})를 넘어 연결을 끊었습니다.` });
        else finish("protocol_violation", { violation: `프레임이 완성되기 전에 한도(${maxBytes}바이트)를 넘었습니다.` });
      }
    });

    socket.on("end", () => {
      closedByServer = true;
      if (frameDone) return frameFinished();
      if (total === 0) return finish("eof_no_response");
      return finish("truncated", { error_message: `프레임(${frameLength ?? "?"}바이트) 중 ${total}바이트만 받고 연결이 닫혔습니다.` });
    });

    socket.on("error", (error) => {
      errorCode = error.code ?? null;
      if (!connected) return finish("connect_failed", { error_code: errorCode, error_message: error.message });
      closedByServer = true;
      if (frameDone) return frameFinished({ note: `응답을 다 받은 뒤 연결 오류(${errorCode})가 났습니다. 결과에는 영향이 없습니다.` });
      return finish("connection_error", { error_message: error.message });
    });

    socket.on("close", () => {
      if (finished) return;
      closedByServer = true;
      if (frameDone) return frameFinished();
      if (total === 0) return finish("eof_no_response");
      return finish("truncated");
    });
  });
}
