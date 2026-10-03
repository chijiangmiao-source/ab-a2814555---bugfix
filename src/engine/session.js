'use strict';

// 多段连续解码会话：段与段之间复用并“提交”同一张动态表。
// 失败段在工作副本上抛错，绝不污染已提交状态；此前各段快照原样保留。

const { DynamicTable, decodeBlock, buildSnapshot, HPACKError } = require('./hpack');

const MAX_TOTAL_BYTES = 65536; // 全部段原始 HPACK 字节总量上限 64KiB
const MAX_CAPACITY = 4096; // 动态表容量协商上限
const MAX_SEGMENTS = 8;

class InputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

class SegmentedDecoder {
  constructor(maxCapacity = MAX_CAPACITY) {
    if (!Number.isInteger(maxCapacity) || maxCapacity < 0 || maxCapacity > MAX_CAPACITY) {
      throw new InputError(
        'CAPACITY_INVALID',
        `动态表容量上限必须是 0..${MAX_CAPACITY} 之间的整数`
      );
    }
    this.maxCapacity = maxCapacity;
    this.table = new DynamicTable(maxCapacity); // 已提交表状态
    this.results = []; // 仅含成功提交的段
    this.totalBytes = 0;
  }

  addBlock(raw) {
    const blockIndex = this.results.length + 1;
    if (blockIndex > MAX_SEGMENTS) {
      throw new InputError('TOO_MANY_SEGMENTS', `最多提交 ${MAX_SEGMENTS} 段`);
    }
    if (this.totalBytes + raw.length > MAX_TOTAL_BYTES) {
      throw new InputError(
        'INPUT_TOO_LARGE',
        `原始 HPACK 字节总量超过 ${MAX_TOTAL_BYTES} 字节（64KiB）上限`
      );
    }

    // 解码全程在工作副本上进行；只有完整成功才提交。
    const { work, fields, events } = decodeBlock(raw, this.table, this.maxCapacity);
    this.table = work;
    this.totalBytes += raw.length;

    const result = {
      block: blockIndex,
      rawLength: raw.length,
      fields,
      events,
      snapshot: buildSnapshot(this.table),
    };
    this.results.push(result);
    return result;
  }

  conclusion() {
    let totalFields = 0;
    const allFields = [];
    for (const r of this.results) {
      totalFields += r.fields.length;
      for (const f of r.fields) {
        allFields.push({
          block: r.block,
          offset: f.offset,
          name: f.name,
          value: f.value,
          nameHex: f.nameHex,
          valueHex: f.valueHex,
        });
      }
    }
    return {
      blocks: this.results.length,
      totalFields,
      totalBytes: this.totalBytes,
      finalSnapshot: buildSnapshot(this.table),
      allFields,
    };
  }
}

// 严格标准 Base64 校验（字母表正确、长度为 4 的倍数、填充仅出现在末尾）
function decodeBase64Strict(text) {
  const s = String(text).trim();
  if (s.length === 0) throw new InputError('BASE64_EMPTY', '存在空的 Base64 段');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new InputError('BASE64_INVALID', '存在不符合标准字母表/填充规则的 Base64 段');
  }
  const padIdx = s.indexOf('=');
  if (padIdx !== -1 && !/^=+$/.test(s.slice(padIdx))) {
    throw new InputError('BASE64_INVALID', 'Base64 填充字符 = 只能连续出现在末尾');
  }
  const raw = Buffer.from(s, 'base64');
  // 二次编码必须与规范形式一致（防止 Node 宽松解码器吞掉非法字符）
  if (raw.toString('base64') !== s) {
    throw new InputError('BASE64_INVALID', 'Base64 段无法规范化（含非法位序列）');
  }
  return raw;
}

module.exports = {
  SegmentedDecoder,
  decodeBase64Strict,
  InputError,
  HPACKError,
  MAX_TOTAL_BYTES,
  MAX_CAPACITY,
  MAX_SEGMENTS,
};
