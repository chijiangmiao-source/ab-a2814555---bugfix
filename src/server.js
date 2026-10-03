'use strict';

// 复核台 HTTP 服务（仅用 Node 内置模块）：
//   GET  /          审查页面
//   GET  /healthz   健康检查
//   POST /api/decode 连续解码 1..8 段 Base64 HPACK 块
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  SegmentedDecoder,
  decodeBase64Strict,
  InputError,
  HPACKError,
  MAX_TOTAL_BYTES,
  MAX_CAPACITY,
  MAX_SEGMENTS,
} = require('./engine/session');

const PAGE = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8');
const MAX_BODY_BYTES = 128 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new InputError('BODY_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function runDecode(capacityInput, rawSegments) {
  let capacity = capacityInput === undefined || capacityInput === null ? MAX_CAPACITY : capacityInput;
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > MAX_CAPACITY) {
    throw new InputError('CAPACITY_INVALID', `动态表容量上限必须是 0..${MAX_CAPACITY} 之间的整数`);
  }
  if (!Array.isArray(rawSegments) || rawSegments.length === 0 || rawSegments.length > MAX_SEGMENTS) {
    throw new InputError('SEGMENTS_INVALID', `需要 1..${MAX_SEGMENTS} 个 Base64 段`);
  }

  // 先整体校验 Base64 并过滤空槽（输入侧错误不携带块偏移，统一 400）
  const blocks = rawSegments.map((seg, i) => {
    if (typeof seg !== 'string') {
      throw new InputError('SEGMENTS_INVALID', `第 ${i + 1} 段不是字符串`);
    }
    const trimmed = seg.trim();
    if (trimmed.length === 0) return null;
    return decodeBase64Strict(trimmed);
  });
  const present = blocks.filter((b) => b !== null);
  if (present.length === 0) {
    throw new InputError('SEGMENTS_INVALID', '至少需要一个非空 Base64 段');
  }

  const decoder = new SegmentedDecoder(capacity);
  const presentSlots = blocks
    .map((b, i) => ({ slot: i + 1, block: b }))
    .filter((x) => x.block !== null);

  for (const { slot, block } of presentSlots) {
    // 槽位号即用户视角的“按接收顺序第几段”（空槽不是块，保持编号可对照）
    try {
      const r = decoder.addBlock(block);
      r.slot = slot;
    } catch (e) {
      if (e instanceof HPACKError) {
        return {
          ok: false,
          capacity,
          processedBytes: decoder.totalBytes,
          results: decoder.results,
          error: {
            block: slot,
            code: e.code,
            offset: e.offset,
            offsetHex: `0x${e.offset.toString(16)}`,
            byte: e.offset < block.length ? `0x${block[e.offset].toString(16).padStart(2, '0')}` : null,
            blockLength: block.length,
            message: e.message,
          },
          conclusion: null,
        };
      }
      throw e; // 总量超限等会话级错误 -> 400
    }
  }

  const conclusion = decoder.conclusion();
  // 将结论中的内部块序号替换为用户槽位号
  const slotByInternal = new Map(decoder.results.map((r, i) => [i + 1, r.slot]));
  conclusion.allFields.forEach((f) => {
    f.block = slotByInternal.get(f.block);
  });
  return {
    ok: true,
    capacity,
    processedBytes: decoder.totalBytes,
    results: decoder.results,
    error: null,
    conclusion,
  };
}

async function handleApiDecode(req, res) {
  let parsed;
  try {
    const body = await readBody(req);
    parsed = JSON.parse(body.toString('utf8') || '{}');
  } catch (e) {
    if (e instanceof InputError) {
      sendJson(res, 413, { ok: false, error: { code: e.code, message: e.message } });
    } else {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
    }
    return;
  }

  try {
    const out = runDecode(parsed.capacity, parsed.segments);
    sendJson(res, out.ok ? 200 : 422, out);
  } catch (e) {
    if (e instanceof InputError) {
      sendJson(res, 400, { ok: false, error: { code: e.code, message: e.message } });
    } else {
      sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: '服务内部错误' } });
    }
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'hpack-relay-reviewer',
        limits: { maxCapacity: MAX_CAPACITY, maxTotalBytes: MAX_TOTAL_BYTES, maxSegments: MAX_SEGMENTS },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/decode') {
      handleApiDecode(req, res);
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '路径不存在' } });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  server.listen(port, () => {
    console.log(`HPACK 复核台已启动: http://0.0.0.0:${port} (健康检查 /healthz)`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, runDecode };
