'use strict';

// 验收入口（可由 docker compose run verify 或直接 node verify.js 执行）：
//   1) 连续解码规则代码测试（node --test）
//   2) 页面构建检查
//   3) 对页面、健康路径与解码 API 实施 HTTP/API 冒烟（含跨段引用与失败回滚验收主线）
// 全部通过退出码 0，任一失败退出码 1。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('./src/server');

let failures = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
}

function step(title) {
  console.log(`\n=== ${title} ===`);
}

async function request(base, method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj));
    const u = new URL(urlPath, base);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        method,
        path: u.pathname + u.search,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(base, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await request(base, 'GET', '/healthz');
      if (r.status === 200) return true;
    } catch { /* 服务尚未起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  // --- 1. 规则代码测试 -------------------------------------------------------
  step('1/3 连续解码规则代码测试 (node --test test/)');
  const t = spawnSync(process.execPath, ['--test', path.join(__dirname, 'test')], {
    cwd: __dirname,
    encoding: 'utf8',
  });
  const m = (t.stdout + t.stderr).match(/# (pass|fail|tests) (\d+)/g);
  console.log((m || ['（未能解析统计）']).join('\n'));
  check('全部单元测试通过', t.status === 0, `退出码 ${t.status}`);

  // --- 2. 页面构建检查 -------------------------------------------------------
  step('2/3 页面构建检查');
  const htmlPath = path.join(__dirname, 'src', 'web', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  check('页面文件存在且非空', html.length > 2000, `${html.length} 字节`);
  check('含 8 个段输入区生成逻辑', /const SEG_COUNT = 8/.test(html) && /i <= SEG_COUNT/.test(html));
  check('段输入按接收顺序标注', /按接收顺序 · 第/.test(html));
  check('含容量上限输入', /动态表容量/.test(html) && /id="cap"/.test(html));
  check('含清空草稿按钮', /btnClearDraft/.test(html));
  check('含清空草稿和结论按钮', /btnClearAll/.test(html));
  check('含字段/来源/插入驱逐/快照渲染逻辑',
    /renderFields/.test(html) && /renderEvents/.test(html) && /renderSnapshot/.test(html));
  check('页面事件/快照/结论渲染携带 hex 与 UTF-8 有效性证据',
    /nameHex/.test(html) && /valueHex/.test(html) && /非UTF-8/.test(html));
  check('错误展示含块内字节偏移', /段内字节偏移/.test(html) && /offsetHex/.test(html));
  // 关键 JS 不能有明显语法错误：提取最后一个 <script> 块用 new Function 解析
  const scriptBody = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</' + 'script>'));
  let scriptOk = true;
  try {
    new Function(scriptBody); // 仅解析，不执行（依赖 DOM）
  } catch (e) {
    scriptOk = false;
    console.log('    脚本语法错误：' + e.message);
  }
  check('内嵌脚本语法有效', scriptOk);

  // --- 3. HTTP / API 冒烟 ----------------------------------------------------
  step('3/3 HTTP / API 冒烟');
  const target = process.env.TARGET_URL;
  let server = null;
  let base;
  if (target) {
    // Compose 模式：对已启动的 app 服务做外部冒烟
    base = target;
    console.log(`    目标服务：${base}（等待健康检查就绪）`);
    const ready = await waitFor(base);
    check('目标服务健康检查就绪', ready);
    if (!ready) {
      console.log(`\n❌ 验收失败 ${failures + 1} 项`);
      process.exit(1);
    }
  } else {
    // 本机模式：在随机端口拉起应用实例
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  try {
    // 3a. 页面
    const home = await request(base, 'GET', '/');
    check('GET / → 200', home.status === 200, `实际 ${home.status}`);
    check('Content-Type 为 text/html; charset=utf-8', /^text\/html/.test(home.headers['content-type'] || ''));
    check('页面含复核台标题与解码按钮', home.raw.includes('HPACK') && home.raw.includes('btnDecode'));

    // 3b. 健康路径
    const hz = await request(base, 'GET', '/healthz');
    check('GET /healthz → 200', hz.status === 200, `实际 ${hz.status}`);
    let hzJson = null;
    try { hzJson = JSON.parse(hz.raw); } catch { /* 下面检查会失败 */ }
    check('健康检查 JSON status=ok 且回传限额',
      !!hzJson && hzJson.status === 'ok' && hzJson.limits.maxCapacity === 4096 &&
      hzJson.limits.maxTotalBytes === 65536 && hzJson.limits.maxSegments === 8);

    // 3c. API 验收主线 A：后块引用前块插入字段
    const cross = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      segments: ['QBF4LXRlbGVtZXRyeS1yb3V0ZYdA0rDYTSw7', 'vg=='],
    });
    check('跨段引用请求 → 200', cross.status === 200, `实际 ${cross.status}`);
    const crossJson = JSON.parse(cross.raw);
    check('两段全部成功并给出成功结论', crossJson.ok === true && crossJson.conclusion && crossJson.conclusion.blocks === 2);
    const seg2 = crossJson.results && crossJson.results[1];
    check('第二段字段来自动态表 #62（前块插入项）',
      !!seg2 && seg2.fields[0] && seg2.fields[0].source.location === 'dynamic' &&
      seg2.fields[0].source.index === 62 && seg2.fields[0].name === 'x-telemetry-route');
    check('段1 记录含一次插入，段2 无插入/驱逐',
      crossJson.results[0].events.some((e) => e.type === 'insert') &&
      seg2.events.length === 0);

    // 3d. API 验收主线 B：非法后续块不污染已提交表状态、无成功结论
    const bad = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      segments: ['QBF4LXRlbGVtZXRyeS1yb3V0ZYdA0rDYTSw7', 'QAJ4eAF4wA=='],
    });
    check('含非法后续块的请求 → 422', bad.status === 422, `实际 ${bad.status}`);
    const badJson = JSON.parse(bad.raw);
    check('失败定位为第 2 段、块内偏移 0x6、越界索引',
      !badJson.ok && badJson.error.block === 2 && badJson.error.offset === 6 &&
      badJson.error.code === 'INDEX_OUT_OF_RANGE');
    check('失败响应不携带成功结论', badJson.conclusion === null);
    check('仅提交第 1 段且其段末快照保留插入字段',
      badJson.results.length === 1 && badJson.results[0].snapshot.entries.length === 1 &&
      badJson.results[0].snapshot.entries[0].name === 'x-telemetry-route');

    // 3e. 截断整数错误定位 + 坏 Base64 / 坏容量的 400
    const trunc = await request(base, 'POST', '/api/decode', { capacity: 4096, segments: ['P/8='] });
    // 0x3f 容量更新前缀满且无续字节 -> TRUNCATED_INTEGER at 0
    const truncJson = JSON.parse(trunc.raw);
    check('截断整数 → 422 且偏移 0x0',
      trunc.status === 422 && truncJson.error.code === 'TRUNCATED_INTEGER' && truncJson.error.offset === 0);

    const badB64 = await request(base, 'POST', '/api/decode', { capacity: 4096, segments: ['@@@'] });
    check('非法 Base64 → 400', badB64.status === 400 && JSON.parse(badB64.raw).error.code === 'BASE64_INVALID');
    const badCap = await request(base, 'POST', '/api/decode', { capacity: 9999, segments: ['vg=='] });
    check('容量超 4096 → 400', badCap.status === 400 && JSON.parse(badCap.raw).error.code === 'CAPACITY_INVALID');

    // 3f. 失败后服务依然健康（无状态污染跨请求）
    const hz2 = await request(base, 'GET', '/healthz');
    check('冒烟后健康路径仍 200', hz2.status === 200);
    const unknown = await request(base, 'GET', '/nope');
    check('未知路径 → 404 JSON', unknown.status === 404);

    // 3g. 审计可辨识性主线一：容量 68 连续三段 x:a/x:b/x:c（各 34 B），
    //     第三段插入 x:c 驱逐 x:a —— 驱逐记录须给出实际动态索引 #63 与完整值/hex
    const b64 = (...bytes) => Buffer.from(bytes).toString('base64');
    const evict = await request(base, 'POST', '/api/decode', {
      capacity: 68,
      segments: [
        b64(0x40, 0x01, 0x78, 0x01, 0x61), // x:a
        b64(0x40, 0x01, 0x78, 0x01, 0x62), // x:b
        b64(0x40, 0x01, 0x78, 0x01, 0x63), // x:c → 驱逐 x:a
      ],
    });
    check('容量 68 三段连续解码 → 200', evict.status === 200, `实际 ${evict.status}`);
    const evictJson = JSON.parse(evict.raw);
    const evictEv = evictJson.results && evictJson.results[2] &&
      evictJson.results[2].events.find((e) => e.type === 'eviction');
    check('驱逐记录给出驱逐发生时的实际动态索引 #63',
      !!evictEv && evictEv.index === 63,
      evictEv ? `实际 index=${evictEv.index}` : '缺少驱逐记录');
    check('驱逐记录携带完整字段值与原始字节 hex（x: a / 名 0x78 / 值 0x61）',
      !!evictEv && evictEv.name === 'x' && evictEv.value === 'a' &&
      evictEv.nameHex === '78' && evictEv.valueHex === '61' && evictEv.entrySize === 34);
    const evictSnap = evictJson.results && evictJson.results[2] && evictJson.results[2].snapshot;
    check('第三段快照：x:c 在 #62、x:b 在 #63，条目均带 hex 证据',
      !!evictSnap && evictSnap.entries.length === 2 &&
      evictSnap.entries[0].index === 62 && evictSnap.entries[0].value === 'c' &&
      evictSnap.entries[0].valueHex === '63' &&
      evictSnap.entries[1].index === 63 && evictSnap.entries[1].value === 'b' &&
      evictSnap.entries[1].valueHex === '62');

    // 3h. 审计可辨识性主线二：同名字段原始值 0x80 与 0x81（均非 UTF-8），
    //     第二段快照与成功结论须能以 hex 明确区分，不得混为同一替换字符
    const bin = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      segments: [
        b64(0x40, 0x01, 0x78, 0x01, 0x80), // x: <0x80>
        b64(0x40, 0x01, 0x78, 0x01, 0x81), // x: <0x81>
      ],
    });
    check('非 UTF-8 双段连续解码 → 200', bin.status === 200, `实际 ${bin.status}`);
    const binJson = JSON.parse(bin.raw);
    const binSnap = binJson.results && binJson.results[1] && binJson.results[1].snapshot;
    check('第二段快照以 hex 区分 0x80 与 0x81 且标注 UTF-8 无效',
      !!binSnap && binSnap.entries.length === 2 &&
      binSnap.entries[0].valueHex === '81' && binSnap.entries[1].valueHex === '80' &&
      binSnap.entries[0].valueUtf8Valid === false && binSnap.entries[1].valueUtf8Valid === false);
    check('成功结论字段清单同样携带可区分的 hex 证据',
      !!binJson.conclusion && binJson.conclusion.allFields.length === 2 &&
      binJson.conclusion.allFields[0].valueHex === '80' &&
      binJson.conclusion.allFields[1].valueHex === '81' &&
      binJson.conclusion.allFields[0].valueUtf8Valid === false &&
      binJson.conclusion.allFields[1].valueUtf8Valid === false);
  } finally {
    if (server) await new Promise((r) => server.close(r));
  }

  console.log(`\n${failures === 0 ? '✅ 验收全部通过' : `❌ 验收失败 ${failures} 项`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exit(1);
});
