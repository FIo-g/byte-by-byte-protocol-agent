// 명세 JSON(n08-draft-1)을 읽어 요청 프레임을 만들고 응답 프레임을 해석한다.
// 명세는 데이터로만 쓴다(코드로 실행하지 않는다). Node 내장 모듈만 사용.
// 2026-11-20 재작성: 원본 web/lib는 .gitignore(lib/) 때문에 커밋되지 않아 유실됐고,
// 커밋된 web/test/*.test.mjs와 docs/n08-web-client.md를 기준으로 다시 작성했다.
import { readFileSync } from "node:fs";

export class SpecError extends Error {
  constructor(message) { super(message); this.name = "SpecError"; }
}
export class InputError extends Error {
  constructor(message) { super(message); this.name = "InputError"; }
}

const INT_SIZE = { u8: 1, u16: 2, u32: 4 };
const HEX = /^(?:[0-9a-f]{2})+$/i;

export const toHex = (bytes) => Buffer.from(bytes).toString("hex");

export function loadSpec(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SpecError(`명세 JSON을 읽지 못했습니다: ${path} (${error.message})`);
  }
  return validateSpec(parsed);
}

/** 이 클라이언트가 실행할 수 있는 명세인지 검사한다. 모르는 부분은 추측하지 않고 거절한다. */
export function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new SpecError("명세가 객체가 아닙니다.");
  if (spec.transport?.protocol !== "tcp") throw new SpecError("transport.protocol은 tcp여야 합니다.");
  if (spec.transport?.byte_order !== "big") throw new SpecError("transport.byte_order는 big만 지원합니다.");

  const header = spec.header;
  if (!header || !Number.isInteger(header.size) || header.size < 1 || !Array.isArray(header.fields)) {
    throw new SpecError("header.size와 header.fields가 필요합니다.");
  }
  let end = 0;
  const kinds = { type: 0, length: 0 };
  for (const field of header.fields) {
    if (typeof field.name !== "string" || !field.name) throw new SpecError("헤더 필드에 name이 없습니다.");
    if (field.offset !== end) throw new SpecError(`헤더 필드 ${field.name}의 offset ${field.offset}이 앞 필드와 이어지지 않습니다(기대 ${end}).`);
    if (!Number.isInteger(field.size) || field.size < 1) throw new SpecError(`헤더 필드 ${field.name}의 size가 잘못됐습니다.`);
    end += field.size;
    if (field.kind === "const") {
      if (typeof field.value !== "string" || !HEX.test(field.value) || field.value.length !== field.size * 2) {
        throw new SpecError(`헤더 필드 ${field.name}의 상수 값이 size와 맞는 hex가 아닙니다.`);
      }
    } else if (field.kind === "type" || field.kind === "length") {
      kinds[field.kind] += 1;
      if (field.size > 4) throw new SpecError(`헤더 필드 ${field.name}는 4바이트 이하만 지원합니다.`);
    } else {
      throw new SpecError(`헤더 필드 ${field.name}의 kind ${field.kind}은 지원하지 않습니다.`);
    }
  }
  if (end !== header.size) throw new SpecError(`헤더 필드 합계 ${end}바이트가 header.size ${header.size}와 다릅니다.`);
  if (kinds.type !== 1 || kinds.length !== 1) throw new SpecError("헤더에는 type 필드와 length 필드가 하나씩 있어야 합니다.");

  const typeSize = header.fields.find((f) => f.kind === "type").size;
  const { request, response } = spec.messages ?? {};
  if (!Array.isArray(request) || request.length === 0) throw new SpecError("messages.request가 필요합니다.");
  if (!Array.isArray(response) || response.length === 0) throw new SpecError("messages.response가 필요합니다.");
  for (const message of [...request, ...response]) {
    if (typeof message.type !== "string" || !HEX.test(message.type) || message.type.length !== typeSize * 2) {
      throw new SpecError(`메시지 ${message.name}의 type이 헤더 type 크기와 맞는 hex가 아닙니다.`);
    }
  }
  for (const message of request) {
    const payload = message.payload;
    if (payload?.layout !== "array" || !INT_SIZE[payload.element]) throw new SpecError(`요청 ${message.name}: array(u8/u16/u32) payload만 지원합니다.`);
  }
  for (const message of response) {
    const payload = message.payload;
    if (payload?.layout !== "fields" || !Array.isArray(payload.fields) || payload.fields.length === 0) {
      throw new SpecError(`응답 ${message.name}: fields payload만 지원합니다.`);
    }
    for (const field of payload.fields) {
      if (!INT_SIZE[field.kind]) throw new SpecError(`응답 ${message.name}의 필드 ${field.name}: kind ${field.kind}은 지원하지 않습니다.`);
    }
  }
  return spec;
}

function uint(value, size) {
  const out = Buffer.alloc(size);
  out.writeUIntBE(value, 0, size);
  return out;
}

/** numbers로 요청 프레임을 만든다. 잘못된 입력은 InputError(연결하기 전에 거절). */
export function encodeRequest(spec, numbers, { minCount = 0, message } = {}) {
  const request = message ? spec.messages.request.find((m) => m.name === message) : spec.messages.request[0];
  if (!request) throw new InputError(`명세에 없는 요청 ${message}`);
  const payloadSpec = request.payload;
  const size = INT_SIZE[payloadSpec.element];
  const max = 2 ** (8 * size) - 1;

  if (!Array.isArray(numbers)) throw new InputError("numbers는 배열이어야 합니다.");
  const low = Math.max(minCount, payloadSpec.min_count ?? 0);
  const high = payloadSpec.max_count ?? Infinity;
  if (numbers.length < low || numbers.length > high) {
    throw new InputError(`숫자는 ${low}~${high}개여야 합니다(입력 ${numbers.length}개).`);
  }
  numbers.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
      throw new InputError(`${index}번째 값 ${JSON.stringify(value)}은(는) 0~${max} 정수가 아닙니다.`);
    }
  });

  const payload = Buffer.concat(numbers.map((value) => uint(value, size)));
  const fields = spec.header.fields.map((field) => {
    if (field.kind === "const") return { name: field.name, hex: field.value.toLowerCase(), value: field.value.toLowerCase() };
    if (field.kind === "type") return { name: field.name, hex: request.type.toLowerCase(), value: request.type.toLowerCase(), meaning: request.name };
    if (payload.length > 2 ** (8 * field.size) - 1) throw new InputError("payload가 length 필드 범위를 넘습니다.");
    return { name: field.name, hex: toHex(uint(payload.length, field.size)), value: payload.length };
  });
  numbers.forEach((value, index) => fields.push({ name: `value[${index}]`, hex: toHex(uint(value, size)), value }));
  const bytes = Buffer.from(fields.map((f) => f.hex).join(""), "hex");
  return { message: request.name, bytes, hex: toHex(bytes), fields };
}

const payloadSize = (message) => message.payload.fields.reduce((sum, field) => sum + INT_SIZE[field.kind], 0);

/** 헤더만 보고 이 응답이 명세에 맞는지, 프레임 전체 길이가 얼마인지 판단한다. */
export function parseResponseHeader(spec, bytes) {
  const header = spec.header;
  if (bytes.length < header.size) throw new RangeError(`헤더 ${header.size}바이트를 다 모으기 전에는 해석하지 않습니다(${bytes.length}바이트).`);
  let typeHex = null;
  let length = null;
  for (const field of header.fields) {
    const slice = bytes.subarray(field.offset, field.offset + field.size);
    if (field.kind === "const" && toHex(slice) !== field.value.toLowerCase()) {
      return { ok: false, reason: `${field.name}이(가) ${toHex(slice)}입니다(명세 ${field.value.toLowerCase()}).` };
    }
    if (field.kind === "type") typeHex = toHex(slice);
    if (field.kind === "length") length = slice.readUIntBE(0, field.size);
  }
  const message = spec.messages.response.find((m) => m.type.toLowerCase() === typeHex);
  if (!message) return { ok: false, reason: `명세에 없는 응답 type ${typeHex}입니다.` };
  const expected = payloadSize(message);
  if (length !== expected) return { ok: false, reason: `${message.name}의 length는 ${expected}여야 하는데 ${length}입니다.` };
  return { ok: true, type: typeHex, message: message.name, role: message.role ?? null, length, totalLength: header.size + length };
}

/** 프레임 하나(정확히 헤더+length 바이트)를 해석한다. */
export function decodeResponse(spec, bytes) {
  bytes = Buffer.from(bytes);
  if (bytes.length < spec.header.size) return { ok: false, reason: `헤더보다 짧은 응답입니다(${bytes.length}바이트).` };
  const head = parseResponseHeader(spec, bytes);
  if (!head.ok) return { ok: false, reason: head.reason };
  if (bytes.length !== head.totalLength) {
    return { ok: false, reason: `프레임 길이가 헤더(${head.totalLength}바이트)와 다릅니다(${bytes.length}바이트).` };
  }
  const message = spec.messages.response.find((m) => m.name === head.message);
  const fields = spec.header.fields.map((field) => {
    const slice = bytes.subarray(field.offset, field.offset + field.size);
    const hex = toHex(slice);
    if (field.kind === "length") return { name: field.name, hex, value: slice.readUIntBE(0, field.size) };
    if (field.kind === "type") return { name: field.name, hex, value: hex, meaning: message.name };
    return { name: field.name, hex, value: hex };
  });
  const values = {};
  const meanings = {};
  const parts = [];
  let at = spec.header.size;
  for (const field of message.payload.fields) {
    const size = INT_SIZE[field.kind];
    const slice = bytes.subarray(at, at + size);
    const value = slice.readUIntBE(0, size);
    at += size;
    values[field.name] = value;
    let meaning;
    if (field.values) {
      const key = toHex(slice);
      meaning = Object.entries(field.values).find(([code]) => code.toLowerCase() === key)?.[1] ?? null;
      meanings[field.name] = meaning;
      parts.push(`${field.name}=${value} (${meaning ?? "명세에 없는 코드"})`);
    } else {
      parts.push(`${field.name}=${value}`);
    }
    fields.push({ name: field.name, hex: toHex(slice), value, ...(meaning !== undefined ? { meaning } : {}) });
  }
  return { ok: true, message: message.name, role: message.role ?? null, values, meanings, fields, text: `${message.name}: ${parts.join(", ")}` };
}
