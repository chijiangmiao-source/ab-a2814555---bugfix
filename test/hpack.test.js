'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  readInteger,
  decodeHuffman,
  DynamicTable,
  decodeBlock,
  buildSnapshot,
  HPACKError,
  STATIC_COUNT,
} = require('../src/engine/hpack');
const {
  SegmentedDecoder,
  decodeBase64Strict,
  MAX_CAPACITY,
  MAX_TOTAL_BYTES,
} = require('../src/engine/session');
const { CODES } = require('../src/engine/huffman-table');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// 用引擎码表做 Huffman 编码，仅供测试构造数据/交叉验证
function huffEncode(text) {
  const bits = [];
  for (const ch of Buffer.from(text, 'utf8')) {
    const [code, nbits] = CODES[ch];
    for (let i = nbits - 1; i >= 0; i -= 1) bits.push((code >> i) & 1);
  }
  while (bits.length % 8 !== 0) bits.push(1); // EOS 最高位填充
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < out.length; i += 1) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}

function expectError(fn, code) {
  assert.throws(
    fn,
    (e) => e instanceof HPACKError && e.code === code,
    `expected HPACKError ${code}`
  );
}

// --- 变长整数 (RFC 7541 §5.1 示例) -------------------------------------------
test('变长整数：5 位前缀单字节', () => {
  assert.deepEqual(readInteger(hex('0a'), 0, 5), { value: 10, offset: 1 });
});

test('变长整数：5 位前缀多字节 1337', () => {
  // RFC 7541 §5.1 示例: 31 + (26 + 10*128) = 1337
  const r = readInteger(hex('1f9a0a'), 0, 5);
  assert.equal(r.value, 1337);
  assert.equal(r.offset, 3);
});

test('变长整数：7 位前缀 62 (0xbe 低 7 位)', () => {
  const r = readInteger(hex('be'), 0, 7);
  assert.equal(r.value, 62);
});

test('变长整数：截断的续字节报错且偏移为首字节', () => {
  expectError(() => readInteger(hex('3f'), 0, 5), 'TRUNCATED_INTEGER');
  try {
    readInteger(hex('3f'), 0, 5);
  } catch (e) {
    assert.equal(e.offset, 0);
  }
});

test('变长整数：超过 32 位的整数报溢出错误', () => {
  // 前缀满 + 5 个带续位字节 + 终止字节，数值远超 2^32
  expectError(() => readInteger(hex('3f 8080 8080 8001'), 0, 5), 'INTEGER_OVERFLOW');
});

// --- Huffman -------------------------------------------------------------------
test('Huffman：RFC C.4.1 中 www.example.com 的编码可正确解码', () => {
  const enc = hex('f1e3c2e5f23a6ba0ab90f4ff');
  assert.deepEqual(decodeHuffman(enc, 0), Buffer.from('www.example.com'));
});

test('Huffman：编码结果与 RFC 字节级一致（双向交叉验证）', () => {
  assert.deepEqual(huffEncode('www.example.com'), hex('f1e3c2e5f23a6ba0ab90f4ff'));
  assert.deepEqual(huffEncode('no-cache'), hex('a8eb10649cbf'));
});

test('Huffman：短码 + 全 1 填充合法', () => {
  // '0' = 00000，填充 111 => 0x07
  assert.deepEqual(decodeHuffman(hex('07'), 0), Buffer.from('0'));
});

test('Huffman：填充为全 0 非法', () => {
  expectError(() => decodeHuffman(hex('00'), 0), 'HUFFMAN_PADDING');
});

test('Huffman：填充超过 7 位非法', () => {
  // '0' 的 5 位码后再制造 11 位尾随 1
  expectError(() => decodeHuffman(hex('07ff'), 0), 'HUFFMAN_PADDING');
});

test('Huffman：出现 EOS 符号必须报错', () => {
  // 30 个 1 (EOS) + 2 位填充 11 = 4 字节 0xff
  expectError(() => decodeHuffman(hex('ffffffff'), 0), 'HUFFMAN_EOS');
});

// --- RFC C.4.1 整向量 -----------------------------------------------------------
test('RFC C.4.1：首请求解码，动态表留下 :authority 条目', () => {
  const block = hex('8286 8441 8cf1 e3c2 e5f2 3a6b a0ab 90f4 ff');
  const table = new DynamicTable(4096);
  const { fields, events, work } = decodeBlock(block, table, 4096);
  assert.deepEqual(
    fields.map((f) => [f.name, f.value]),
    [
      [':method', 'GET'],
      [':scheme', 'http'],
      [':path', '/'],
      [':authority', 'www.example.com'],
    ]
  );
  assert.equal(fields[0].source.location, 'static');
  assert.equal(fields[3].source.location, 'static'); // 名称引用静态表 1
  assert.equal(fields[3].valueHuffman, true);
  const snap = buildSnapshot(work);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].index, 62);
  assert.equal(snap.entries[0].name, ':authority');
  assert.equal(snap.entries[0].value, 'www.example.com');
  assert.equal(snap.size, 57);
  assert.equal(events[0].type, 'insert');
  assert.equal(events[0].entrySize, 57);
});

// --- 连续块：后块引用前块插入项 --------------------------------------------------
test('连续块：第二段用动态索引 62 引用第一段插入的 foo: bar', () => {
  const sd = new SegmentedDecoder(4096);
  sd.addBlock(hex('40 03 666f6f 03 626172')); // 增量索引字面量 foo: bar
  const r2 = sd.addBlock(hex('be')); // 索引 62
  assert.deepEqual(
    r2.fields.map((f) => [f.name, f.value, f.source.location, f.source.index]),
    [['foo', 'bar', 'dynamic', 62]]
  );
  const c = sd.conclusion();
  assert.equal(c.blocks, 2);
  assert.equal(c.totalFields, 2);
  assert.equal(c.finalSnapshot.entries.length, 1);
});

test('连续块：第三段继续引用第二段插入的新条目（62 始终指向最新）', () => {
  const sd = new SegmentedDecoder(4096);
  sd.addBlock(hex('40 03 666f6f 03 626172')); // 插入 foo=bar
  sd.addBlock(hex('40 03 62617a 03 717578')); // 插入 baz=qux -> 占据 62，foo 变 63
  const r3 = sd.addBlock(hex('bf')); // 索引 63 => foo: bar
  assert.deepEqual(r3.fields[0].name, 'foo');
  assert.deepEqual(r3.fields[0].value, 'bar');
  assert.equal(r3.fields[0].source.index, 63);
});

// --- 各类错误 -------------------------------------------------------------------
test('错误：动态索引越界', () => {
  const table = new DynamicTable(4096);
  expectError(() => decodeBlock(hex('be'), table, 4096), 'INDEX_OUT_OF_RANGE');
});

test('错误：字面量名称索引越界', () => {
  const table = new DynamicTable(4096);
  // 0x40 + 名称索引 62（空表）+ 任意值串
  expectError(() => decodeBlock(hex('7e03 626172'), table, 4096), 'INDEX_OUT_OF_RANGE');
});

test('错误：截断的字符串体', () => {
  const table = new DynamicTable(4096);
  expectError(() => decodeBlock(hex('40 03 6162 03 78'), table, 4096), 'TRUNCATED_STRING');
});

test('错误：块首之后的容量更新非法，偏移指向该字节', () => {
  const table = new DynamicTable(4096);
  try {
    decodeBlock(hex('82 20'), table, 4096);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, 'MISPLACED_RESIZE');
    assert.equal(e.offset, 1);
  }
});

test('错误：容量更新超过协商上限', () => {
  const table = new DynamicTable(4096);
  // 5 位前缀编码 4097 = 31 + 98 + 31*128 -> 3f e2 1f
  expectError(() => decodeBlock(hex('3f e2 1f'), table, 4096), 'RESIZE_EXCEEDS_CAPACITY');
});

test('错误：增量索引条目超过当前容量', () => {
  const table = new DynamicTable(100);
  // 名称 30 字节 + 值 40 字节 + 32 = 102 > 100
  const big = Buffer.concat([
    hex('40 1e'),
    Buffer.alloc(30, 0x61),
    hex('28'),
    Buffer.alloc(40, 0x62),
  ]);
  expectError(() => decodeBlock(big, table, 100), 'FIELD_TOO_LARGE');
});

test('错误：越界索引偏移为块内字节偏移（非全局）', () => {
  const table = new DynamicTable(4096);
  const block = hex('82 86 fe'); // 两个合法索引 + 7 位整数 126 越界
  try {
    decodeBlock(block, table, 4096);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, 'INDEX_OUT_OF_RANGE');
    assert.equal(e.offset, 2);
  }
});

// --- 回滚：失败块不改变此前快照 --------------------------------------------------
test('回滚：失败块不改变已提交表状态，后续好块仍可解码', () => {
  const sd = new SegmentedDecoder(4096);
  sd.addBlock(hex('40 03 666f6f 03 626172')); // foo=bar 插入成功
  const before = JSON.stringify(buildSnapshot(sd.table));

  // 块内先插入 xx（工作副本中 foo 移至 63），再引用越界索引 64 -> 整段失败回滚
  assert.throws(() => sd.addBlock(hex('40 02 7878 c0')));
  // 非法块期间发生的插入必须整体回滚
  assert.equal(JSON.stringify(buildSnapshot(sd.table)), before);

  const r3 = sd.addBlock(hex('be')); // 仍引用 foo: bar
  assert.equal(r3.fields[0].name, 'foo');
  assert.equal(sd.results.length, 2); // 只有两次成功
});

test('回滚：块中段失败，先发生的驱逐/插入全部撤销', () => {
  const table = new DynamicTable(70);
  table.insert(Buffer.from('k1'), Buffer.from('v1'), 0, []); // 36
  const sizeBefore = table.size;
  // 插入一个 34 字节条目（会驱逐 k1），随后引用越界索引 -> 整段回滚
  const block = Buffer.concat([
    hex('40 01 41 01 42'), // A=B => 34 字节，触发驱逐
    hex('ff'), // 索引 127 越界
  ]);
  assert.throws(() => decodeBlock(block, table, 70));
  assert.equal(table.size, sizeBefore);
  assert.equal(table.entries.length, 1);
  assert.equal(table.entries[0].name, 'k1');
});

// --- 容量更新与驱逐 -------------------------------------------------------------
test('容量更新：块首合法更新容量，且跨段持续生效', () => {
  const sd = new SegmentedDecoder(4096);
  sd.addBlock(hex('3f c5 00')); // 容量置为 100
  assert.equal(sd.table.sizeLimit, 100);
  const r2 = sd.addBlock(hex('40 01 41 01 42')); // A=B, 34 字节
  assert.equal(sd.table.size, 34);
  assert.equal(r2.snapshot.maxSize, 100);
});

test('驱逐：超大条目插入产生驱逐记录并反映到段末快照', () => {
  const table = new DynamicTable(80);
  const events = [];
  table.insert(Buffer.from('k1'), Buffer.from('v1'), 0, events); // 36
  table.insert(Buffer.from('k22222222'), Buffer.from('v22222222'), 1, events); // 32+9+9=50
  assert.equal(table.entries.length, 1);
  assert.equal(table.entries[0].name, 'k22222222');
  const ev = events.find((e) => e.type === 'eviction');
  assert.ok(ev, '应有驱逐记录');
  assert.equal(ev.name, 'k1');
});

test('容量调小立即驱逐最旧条目并记录 resize/eviction', () => {
  const table = new DynamicTable(4096);
  const events = [];
  table.insert(Buffer.from('k1'), Buffer.from('v1'), 0, events);
  table.resize(0, 1, events);
  assert.equal(table.size, 0);
  assert.equal(table.entries.length, 0);
  assert.equal(events.at(-1).type, 'resize');
  assert.ok(events.some((e) => e.type === 'eviction'));
});

// --- 审计回归：驱逐记录与快照必须可区分、可还原 ----------------------------------
test('回归：容量 68 连续三段增量解码，驱逐记录报告实际索引 #63 并携带值与原始字节', () => {
  const sd = new SegmentedDecoder(68);
  sd.addBlock(hex('40 01 78 01 61')); // x:a（34B）→ #62
  const r2 = sd.addBlock(hex('40 01 78 01 62')); // x:b（34B）→ #62，x:a 移至 #63

  // 处理第三项前的表状态：x:b 在 #62，较旧的 x:a 在 #63
  assert.deepEqual(
    r2.snapshot.entries.map((e) => [e.index, e.name, e.value]),
    [
      [62, 'x', 'b'],
      [63, 'x', 'a'],
    ]
  );

  const r3 = sd.addBlock(hex('40 01 78 01 63')); // 插入 x:c（34B）→ 驱逐 x:a
  const ev = r3.events.find((e) => e.type === 'eviction');
  assert.ok(ev, '插入 x:c 必须触发一次驱逐');
  assert.equal(ev.cause, 'insert');
  assert.equal(ev.offset, 0); // 由块内偏移 0 的增量字段触发
  assert.equal(ev.index, 63); // 驱逐发生瞬间的实际动态索引（修复前误报为 #62）
  assert.equal(ev.name, 'x');
  assert.equal(ev.value, 'a'); // 完整字段值：被驱逐的是 x:a，而非 #62 的 x:b
  assert.equal(ev.nameHex, '78'); // 原始字节表示
  assert.equal(ev.valueHex, '61');
  assert.equal(ev.nameUtf8Valid, true);
  assert.equal(ev.valueUtf8Valid, true);
  assert.equal(ev.entrySize, 34);

  // 段末快照：x:c 占据 #62，x:b 移至 #63，x:a 已离场
  assert.deepEqual(
    r3.snapshot.entries.map((e) => [e.index, e.value]),
    [
      [62, 'c'],
      [63, 'b'],
    ]
  );
});

test('回归：两个非 UTF-8 原始值（0x80/0x81）在第二段快照中可按 hex 明确区分', () => {
  const sd = new SegmentedDecoder(4096);
  sd.addBlock(hex('40 01 78 01 80')); // x: <0x80>
  const r2 = sd.addBlock(hex('40 01 78 01 81')); // x: <0x81>

  // 文本层两个值都只能是替换字符 U+FFFD —— 快照必须携带 hex 与 UTF-8 有效性
  const [newer, older] = r2.snapshot.entries;
  assert.equal(r2.snapshot.entries.length, 2);
  assert.equal(newer.value, '�');
  assert.equal(older.value, '�');

  assert.equal(newer.index, 62);
  assert.equal(newer.nameHex, '78');
  assert.equal(newer.valueHex, '81');
  assert.equal(newer.valueUtf8Valid, false);
  assert.equal(older.index, 63);
  assert.equal(older.nameHex, '78');
  assert.equal(older.valueHex, '80');
  assert.equal(older.valueUtf8Valid, false);
  assert.notEqual(newer.valueHex, older.valueHex, '两个不同原始值在快照中必须可区分');

  // 插入事件同样携带原始字节证据
  const ins = r2.events.find((e) => e.type === 'insert');
  assert.equal(ins.valueHex, '81');
  assert.equal(ins.valueUtf8Valid, false);
});

test('回归：被驱逐的非 UTF-8 条目在驱逐记录中保留完整值与原始字节', () => {
  const sd = new SegmentedDecoder(34); // 容量恰容纳一个 34B 条目
  sd.addBlock(hex('40 01 78 01 80')); // x: <0x80> → #62
  const r2 = sd.addBlock(hex('40 01 78 01 81')); // x: <0x81> → 驱逐前者
  const ev = r2.events.find((e) => e.type === 'eviction');
  assert.ok(ev, '第二项插入必须驱逐第一项');
  assert.equal(ev.index, 62); // 表中唯一条目，驱逐时位于 #62
  assert.equal(ev.valueHex, '80'); // 被驱逐的是 0x80 一项，可与新插入的 0x81 区分
  assert.equal(ev.valueUtf8Valid, false);
  assert.equal(ev.nameHex, '78');
  assert.equal(r2.snapshot.entries.length, 1);
  assert.equal(r2.snapshot.entries[0].valueHex, '81');
});

// --- 不索引 / 绝不索引 -----------------------------------------------------------
test('不索引(0000)与绝不索引(0001)字面量不入表', () => {
  const table = new DynamicTable(4096);
  const r = decodeBlock(
    hex('00 03 666f6f 03 626172  10 03 62617a 03 717578  82'),
    table,
    4096
  );
  assert.equal(r.fields[0].kind, 'none');
  assert.equal(r.fields[1].kind, 'never');
  assert.equal(r.fields[2].kind, 'indexed');
  assert.equal(r.work.entries.length, 0);
});

test('不索引字面量可引用静态表名称', () => {
  const table = new DynamicTable(4096);
  // 0000 + 4 位前缀整数 15（前缀满 15 需续字节 0x00），随后值串长度 1 "x"
  const r = decodeBlock(hex('0f 00 01 78'), table, 4096);
  assert.equal(r.fields[0].name, 'accept-charset');
  assert.equal(r.fields[0].value, 'x');
});

// --- Huffman 字符串在完整块中的错误定位 ------------------------------------------
test('错误：非法 Huffman 填充，偏移指向数据末字节', () => {
  const table = new DynamicTable(4096);
  try {
    // 40 03 "foo" 81 <00>：值串 H=1 len=1，数据字节 0x00 位于偏移 6
    decodeBlock(hex('40 03 666f6f 81 00'), table, 4096);
    assert.fail();
  } catch (e) {
    assert.equal(e.code, 'HUFFMAN_PADDING');
    assert.equal(e.offset, 6);
  }
});

test('错误：Huffman EOS 定位到完成该符号的数据字节', () => {
  const table = new DynamicTable(4096);
  try {
    // 40 03 "foo" 84 ff ff ff ff：数据占偏移 6..9，EOS 在第 4 个数据字节(偏移9)完成
    decodeBlock(hex('40 03 666f6f 84 ffffffff'), table, 4096);
    assert.fail();
  } catch (e) {
    assert.equal(e.code, 'HUFFMAN_EOS');
    assert.equal(e.offset, 9);
  }
});

// --- 空块 -----------------------------------------------------------------------
test('空块：无字段且表状态不变', () => {
  const table = new DynamicTable(4096);
  const r = decodeBlock(Buffer.alloc(0), table, 4096);
  assert.equal(r.fields.length, 0);
  assert.equal(r.work.entries.length, 0);
});

// --- 会话/输入约束 ---------------------------------------------------------------
test('会话：Base64 严格校验拒绝非法字符与错误填充', () => {
  assert.deepEqual(decodeBase64Strict('AAAA'), Buffer.from([0, 0, 0]));
  assert.throws(() => decodeBase64Strict('AAA')); // 长度非 4 倍数
  assert.throws(() => decodeBase64Strict('AA!A'));
  assert.throws(() => decodeBase64Strict('A=AA'));
  assert.throws(() => decodeBase64Strict('   '));
});

test('会话：后块 Base64 内容引用前块插入项（端到端）', () => {
  const sd = new SegmentedDecoder(4096);
  sd.addBlock(decodeBase64Strict(Buffer.from(hex('40 03 666f6f 03 626172')).toString('base64')));
  const r = sd.addBlock(decodeBase64Strict('vg==')); // 0xbe
  assert.equal(r.fields[0].name, 'foo');
});

test('会话：容量上限 4096、段数 8、总量 64KiB 约束', () => {
  assert.throws(() => new SegmentedDecoder(4097));
  assert.throws(() => new SegmentedDecoder(-1));
  const sd = new SegmentedDecoder(MAX_CAPACITY);
  assert.throws(() => {
    for (let i = 0; i < 9; i += 1) sd.addBlock(hex('82'));
  });
  const big = new SegmentedDecoder(MAX_CAPACITY);
  assert.throws(() => big.addBlock(Buffer.alloc(MAX_TOTAL_BYTES + 1)));
});

test('会话：失败段不增加成功结论，此前快照保留', () => {
  const sd = new SegmentedDecoder(4096);
  sd.addBlock(hex('40 03 666f6f 03 626172'));
  assert.throws(() => sd.addBlock(hex('ff'))); // 索引 127 越界
  const c = sd.conclusion();
  assert.equal(c.blocks, 1);
  assert.equal(sd.results[0].snapshot.entries[0].name, 'foo');
});

test('静态表 61 项完整且索引常量正确', () => {
  assert.equal(STATIC_COUNT, 61);
  const t = new DynamicTable(4096);
  assert.equal(t.resolve(1).name, ':authority');
  assert.equal(t.resolve(2).value, 'GET');
  assert.equal(t.resolve(61).name, 'www-authenticate');
  assert.equal(t.resolve(62), null);
});

test('容量更新：块首可连续多次更新，记录顺序正确', () => {
  const sd = new SegmentedDecoder(4096);
  const r = sd.addBlock(hex('3f c5 00  3f 06')); // 先置 100，再置 37
  assert.equal(sd.table.sizeLimit, 37);
  const resizes = r.events.filter((e) => e.type === 'resize');
  assert.deepEqual(resizes.map((e) => [e.from, e.to]), [[4096, 100], [100, 37]]);
});

test('容量更新：字面量字段之后出现容量更新按 MISPLACED_RESIZE 处理', () => {
  const table = new DynamicTable(4096);
  // 不索引字面量 name="" value=""（00 00 00），随后 0x20
  try {
    decodeBlock(hex('00 00 00 20'), table, 4096);
    assert.fail();
  } catch (e) {
    assert.equal(e.code, 'MISPLACED_RESIZE');
    assert.equal(e.offset, 3);
  }
});

test('字面量：名称与值均可 Huffman 编码并正确入表', () => {
  const sd = new SegmentedDecoder(4096);
  // 0x40 + H名字串("ab") + H值串("0")
  const nameH = huffEncode('ab');
  const valH = huffEncode('0');
  const block = Buffer.concat([
    Buffer.from([0x40, 0x80 | nameH.length]), nameH,
    Buffer.from([0x80 | valH.length]), valH,
  ]);
  const r = sd.addBlock(block);
  assert.equal(r.fields[0].name, 'ab');
  assert.equal(r.fields[0].value, '0');
  assert.equal(r.fields[0].nameHuffman, true);
  assert.equal(sd.table.entries[0].name, 'ab');
});

test('回滚：失败块中的块首容量更新也一并撤销', () => {
  const sd = new SegmentedDecoder(4096);
  sd.addBlock(hex('40 03 666f6f 03 626172')); // foo=bar，容量仍 4096
  const before = sd.table.sizeLimit;
  assert.throws(() => sd.addBlock(hex('3f c5 00 ff'))); // 容量置100后索引127越界
  assert.equal(sd.table.sizeLimit, before);
  assert.equal(sd.results.length, 1);
});

test('Huffman：空 Huffman 串合法（编码后 0 字节）', () => {
  const table = new DynamicTable(4096);
  // 不索引字面量，空名称空值，H 位分别置位、长度 0
  const r = decodeBlock(hex('00 80 80'), table, 4096);
  assert.equal(r.fields[0].name, '');
  assert.equal(r.fields[0].value, '');
});
