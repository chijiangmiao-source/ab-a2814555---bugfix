'use strict';

// HPACK (RFC 7541) 连续块解码器：
// 变长整数 (5.1)、带/不带 Huffman 的字符串 (5.2)、索引/字面量表示 (6.1/6.2)、
// 动态表容量更新 (4.2)、动态表插入与驱逐 (4.1/4.4)。
// 段内解码在工作副本上进行，成功后才提交，失败不改变既有快照。

const { STATIC_TABLE, STATIC_ENTRY_OVERHEAD } = require('./static-table');
const { CODES, GROUPS, EOS_SYMBOL } = require('./huffman-table');

const STATIC_COUNT = STATIC_TABLE.length; // 61
const HUFF_LENGTHS = Object.keys(GROUPS)
  .map(Number)
  .sort((a, b) => a - b);
const HUFF_MIN = HUFF_LENGTHS[0];
const HUFF_MAX = HUFF_LENGTHS[HUFF_LENGTHS.length - 1];

class HPACKError extends Error {
  constructor(code, offset, message) {
    super(message);
    this.name = 'HPACKError';
    this.code = code;
    this.offset = offset; // 块内字节偏移（出错元素的起始字节）
  }
}

// --- RFC 7541 §5.1 变长整数 ---------------------------------------------------
function readInteger(buf, offset, prefixBits) {
  const start = offset;
  if (offset >= buf.length) {
    throw new HPACKError('TRUNCATED_INTEGER', start, '整数被截断：缺少首字节');
  }
  const prefixMax = (1 << prefixBits) - 1;
  let value = buf[offset] & prefixMax;
  offset += 1;
  if (value < prefixMax) return { value, offset };

  let shift = 0;
  for (;;) {
    if (offset >= buf.length) {
      throw new HPACKError('TRUNCATED_INTEGER', start, '整数被截断：缺少续字节');
    }
    const b = buf[offset];
    offset += 1;
    if (shift >= 32) {
      throw new HPACKError('INTEGER_OVERFLOW', start, '整数超过 32 位表示上限');
    }
    value += (b & 0x7f) * 2 ** shift;
    if (value > 0xffffffff) {
      throw new HPACKError('INTEGER_OVERFLOW', start, '整数超过 32 位表示上限');
    }
    if ((b & 0x80) === 0) return { value, offset };
    shift += 7;
  }
}

// --- Huffman 解码 (RFC 7541 §5.2 + 附录 B) -----------------------------------
// dataStart 为 Huffman 数据在整个 HPACK 块中的起始偏移，用于精确定位错误字节。
function decodeHuffman(src, dataStart = 0) {
  const out = [];
  let acc = 0;
  let bits = 0;

  for (let i = 0; i < src.length; i += 1) {
    acc = acc * 256 + src[i];
    bits += 8;

    while (bits >= HUFF_MIN) {
      let matched = false;
      for (const len of HUFF_LENGTHS) {
        if (len > bits) break;
        const prefix = Math.floor(acc / 2 ** (bits - len)) & (2 ** len - 1);
        const group = GROUPS[len];
        const delta = prefix - group[0];
        if (delta >= 0 && delta < group[1].length) {
          const sym = group[1][delta];
          if (sym === EOS_SYMBOL) {
            throw new HPACKError(
              'HUFFMAN_EOS',
              dataStart + i,
              'Huffman 字符串中出现 EOS 符号（非法）'
            );
          }
          out.push(sym);
          acc %= 2 ** (bits - len);
          bits -= len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        if (bits >= HUFF_MAX) {
          throw new HPACKError(
            'HUFFMAN_INVALID_CODE',
            dataStart + i,
            'Huffman 数据中存在无法识别的码字'
          );
        }
        break; // 码字尚未收齐，等待后续字节
      }
    }
  }

  if (bits > 7 || bits > 0) {
    // 填充问题定位到编码串最后一个字节（空串无填充，不进入此分支）
    const padOffset = dataStart + src.length - 1;
    if (bits > 7) {
      throw new HPACKError(
        'HUFFMAN_PADDING',
        padOffset,
        `末尾填充 ${bits} 位，超过 7 位上限`
      );
    }
    // 合法填充必须等于 EOS 码字（30 个 1）的最高若干位，即全 1
    if ((acc & (2 ** bits - 1)) !== 2 ** bits - 1) {
      throw new HPACKError(
        'HUFFMAN_PADDING',
        padOffset,
        '末尾填充与 EOS 码字最高位不一致（必须全为 1）'
      );
    }
  }
  return Buffer.from(out);
}

// --- RFC 7541 §5.2 字符串字面量 ----------------------------------------------
function readString(buf, offset) {
  const start = offset;
  if (offset >= buf.length) {
    throw new HPACKError('TRUNCATED_STRING', start, '字符串被截断：缺少标志字节');
  }
  const huffman = (buf[offset] & 0x80) === 0x80;
  const lenRes = readInteger(buf, offset, 7);
  const length = lenRes.value;
  let dataStart = lenRes.offset;
  if (dataStart + length > buf.length) {
    throw new HPACKError('TRUNCATED_STRING', start, '字符串被截断：声明长度超出块尾');
  }
  const raw = buf.subarray(dataStart, dataStart + length);
  const bytes = huffman ? decodeHuffman(raw, dataStart) : Buffer.from(raw);
  return { bytes, huffman, offset: dataStart + length, start };
}

// --- 动态表 -------------------------------------------------------------------
class DynamicTable {
  constructor(sizeLimit) {
    this.sizeLimit = sizeLimit; // 当前生效上限（可被容量更新调小/调大）
    this.size = 0;
    this.entries = []; // entries[0] 为最新插入项
    this.insertCount = 0; // 累计插入计数（用于绝对索引 61 + seq）
  }

  clone() {
    const copy = new DynamicTable(this.sizeLimit);
    copy.size = this.size;
    copy.entries = this.entries.slice();
    copy.insertCount = this.insertCount;
    return copy;
  }

  // 驱逐最旧条目直到 size <= target；驱逐记录按发生顺序追加到 events。
  // 记录必须携带驱逐发生瞬间的实际动态索引（最旧条目 = 61 + 当前存活条目数）、
  // 完整字段值与名称/值的原始字节（hex）及 UTF-8 有效性，保证审计可还原被驱逐条目。
  evictTo(target, events, cause, offset) {
    while (this.size > target) {
      const oldest = this.entries[this.entries.length - 1];
      const n = utf8Info(oldest.nameBytes);
      const v = utf8Info(oldest.valueBytes);
      events.push({
        type: 'eviction',
        cause,
        offset, // 触发本次驱逐的插入/容量更新在块内的字节偏移
        index: STATIC_COUNT + this.entries.length, // 驱逐瞬间的实际动态索引
        name: oldest.name,
        value: oldest.value,
        nameHex: n.hex,
        valueHex: v.hex,
        nameUtf8Valid: n.valid,
        valueUtf8Valid: v.valid,
        entrySize: oldest.size,
      });
      this.size -= oldest.size;
      this.entries.pop();
    }
  }

  resize(newLimit, offset, events) {
    const from = this.sizeLimit;
    this.sizeLimit = newLimit;
    if (this.size > newLimit) {
      this.evictTo(newLimit, events, 'resize', offset);
    }
    events.push({ type: 'resize', offset, from, to: newLimit });
  }

  insert(nameBytes, valueBytes, offset, events) {
    const name = Buffer.from(nameBytes);
    const value = Buffer.from(valueBytes);
    const entrySize = STATIC_ENTRY_OVERHEAD + name.length + value.length;

    // 依本工具验收口径：增量索引的新条目超过当前容量即报错（整段回滚）
    if (entrySize > this.sizeLimit) {
      throw new HPACKError(
        'FIELD_TOO_LARGE',
        offset,
        `条目尺寸 ${entrySize} 字节超过动态表容量上限 ${this.sizeLimit} 字节`
      );
    }

    this.insertCount += 1;
    this.evictTo(this.sizeLimit - entrySize, events, 'insert', offset);
    const entry = {
      seq: this.insertCount,
      nameBytes: name,
      valueBytes: value,
      name: name.toString('utf8'),
      value: value.toString('utf8'),
      size: entrySize,
    };
    this.entries.unshift(entry);
    this.size += entrySize;
    const n = utf8Info(name);
    const v = utf8Info(value);
    events.push({
      type: 'insert',
      offset,
      index: STATIC_COUNT + 1, // 插入后占据动态表最新位置（索引 62）
      name: entry.name,
      value: entry.value,
      nameHex: n.hex,
      valueHex: v.hex,
      nameUtf8Valid: n.valid,
      valueUtf8Valid: v.valid,
      entrySize,
    });
    return entry;
  }

  resolve(index) {
    if (index >= 1 && index <= STATIC_COUNT) {
      const e = STATIC_TABLE[index - 1];
      return {
        location: 'static',
        index,
        nameBytes: e.nameBytes,
        valueBytes: e.valueBytes,
        name: e.name,
        value: e.value,
      };
    }
    const pos = index - (STATIC_COUNT + 1);
    if (pos >= 0 && pos < this.entries.length) {
      const e = this.entries[pos];
      return {
        location: 'dynamic',
        index,
        nameBytes: e.nameBytes,
        valueBytes: e.valueBytes,
        name: e.name,
        value: e.value,
      };
    }
    return null;
  }
}

function utf8Info(bytes) {
  const text = bytes.toString('utf8');
  // 往返一致性用于发现非法 UTF-8 字节（显示层提示，不阻断解码）
  const valid = Buffer.from(text, 'utf8').equals(bytes);
  return { text, valid, hex: bytes.toString('hex') };
}

// 解码单个 HP 块；成功返回 {fields, events}，调用方负责提交工作副本。
function decodeBlock(block, table, maxCapacity) {
  const work = table.clone();
  const fields = [];
  const events = [];
  let offset = 0;
  let seenHeaderField = false;

  while (offset < block.length) {
    const start = offset;
    const b = block[offset];

    if (b & 0x80) {
      // 6.1 索引首部字段  1xxxxxxx
      seenHeaderField = true;
      const r = readInteger(block, offset, 7);
      const idx = r.value;
      const hit = idx === 0 ? null : work.resolve(idx);
      if (!hit) {
        throw new HPACKError('INDEX_OUT_OF_RANGE', start, `索引 ${idx} 越界（静态/动态表均无此项）`);
      }
      const n = utf8Info(hit.nameBytes);
      const v = utf8Info(hit.valueBytes);
      fields.push({
        kind: 'indexed',
        offset: start,
        name: n.text,
        value: v.text,
        nameHex: n.hex,
        valueHex: v.hex,
        nameUtf8Valid: n.valid,
        valueUtf8Valid: v.valid,
        source: { location: hit.location, index: idx },
        nameHuffman: null,
        valueHuffman: null,
      });
      offset = r.offset;
    } else if ((b & 0xc0) === 0x40) {
      // 6.2.1 带增量索引的字面量  01xxxxxx
      seenHeaderField = true;
      const r = readInteger(block, offset, 6);
      const idx = r.value;
      let nameBytes;
      let nameSource;
      let nameHuffman = null;
      if (idx === 0) {
        const ns = readString(block, r.offset);
        nameBytes = ns.bytes;
        nameHuffman = ns.huffman;
        nameSource = { location: 'literal', index: null };
        offset = ns.offset;
      } else {
        const hit = work.resolve(idx);
        if (!hit) {
          throw new HPACKError('INDEX_OUT_OF_RANGE', start, `名称索引 ${idx} 越界`);
        }
        nameBytes = hit.nameBytes;
        nameSource = { location: hit.location, index: idx };
        offset = r.offset;
      }
      const vs = readString(block, offset);
      const valueBytes = vs.bytes;
      work.insert(nameBytes, valueBytes, start, events);
      const n = utf8Info(nameBytes);
      const v = utf8Info(valueBytes);
      fields.push({
        kind: 'incremental',
        offset: start,
        name: n.text,
        value: v.text,
        nameHex: n.hex,
        valueHex: v.hex,
        nameUtf8Valid: n.valid,
        valueUtf8Valid: v.valid,
        source: nameSource,
        nameHuffman,
        valueHuffman: vs.huffman,
      });
      offset = vs.offset;
    } else if ((b & 0xe0) === 0x20) {
      // 4.2 动态表容量更新  001xxxxx —— 只允许出现在块首
      if (seenHeaderField) {
        throw new HPACKError(
          'MISPLACED_RESIZE',
          start,
          '容量更新必须位于块首（任何首部字段表示之前）'
        );
      }
      const r = readInteger(block, offset, 5);
      if (r.value > maxCapacity) {
        throw new HPACKError(
          'RESIZE_EXCEEDS_CAPACITY',
          start,
          `容量更新值 ${r.value} 超过协商上限 ${maxCapacity}`
        );
      }
      work.resize(r.value, start, events);
      offset = r.offset;
    } else {
      // 6.2.2 不索引 0000xxxx / 6.2.3 绝不索引 0001xxxx
      seenHeaderField = true;
      const neverIndexed = (b & 0xf0) === 0x10;
      const r = readInteger(block, offset, 4);
      const idx = r.value;
      let nameBytes;
      let nameSource;
      let nameHuffman = null;
      if (idx === 0) {
        const ns = readString(block, r.offset);
        nameBytes = ns.bytes;
        nameHuffman = ns.huffman;
        nameSource = { location: 'literal', index: null };
        offset = ns.offset;
      } else {
        const hit = work.resolve(idx);
        if (!hit) {
          throw new HPACKError('INDEX_OUT_OF_RANGE', start, `名称索引 ${idx} 越界`);
        }
        nameBytes = hit.nameBytes;
        nameSource = { location: hit.location, index: idx };
        offset = r.offset;
      }
      const vs = readString(block, offset);
      const n = utf8Info(nameBytes);
      const v = utf8Info(vs.bytes);
      fields.push({
        kind: neverIndexed ? 'never' : 'none',
        offset: start,
        name: n.text,
        value: v.text,
        nameHex: n.hex,
        valueHex: v.hex,
        nameUtf8Valid: n.valid,
        valueUtf8Valid: v.valid,
        source: nameSource,
        nameHuffman,
        valueHuffman: vs.huffman,
      });
      offset = vs.offset;
    }
  }

  return { work, fields, events };
}

function buildSnapshot(table) {
  return {
    maxSize: table.sizeLimit,
    size: table.size,
    insertCount: table.insertCount,
    // 快照条目保留名称/值的原始字节（hex）与 UTF-8 有效性：
    // 非 UTF-8 值在文本层都显示为替换字符，必须靠 hex 才能审计区分。
    entries: table.entries.map((e, i) => {
      const n = utf8Info(e.nameBytes);
      const v = utf8Info(e.valueBytes);
      return {
        index: STATIC_COUNT + 1 + i,
        name: e.name,
        value: e.value,
        nameHex: n.hex,
        valueHex: v.hex,
        nameUtf8Valid: n.valid,
        valueUtf8Valid: v.valid,
        entrySize: e.size,
        insertedAs: STATIC_COUNT + e.seq,
      };
    }),
  };
}

module.exports = {
  HPACKError,
  DynamicTable,
  decodeBlock,
  buildSnapshot,
  readInteger,
  readString,
  decodeHuffman,
  STATIC_COUNT,
};
