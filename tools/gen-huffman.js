#!/usr/bin/env node
// 从 nghttp2 (MIT) 的 nghttp2_hd_huffman_data.c 生成 RFC 7541 附录 B Huffman 码表。
// 用法: node tools/gen-huffman.js <nghttp2_hd_huffman_data.c> <输出文件>
'use strict';

const fs = require('fs');

const [, , srcPath, outPath] = process.argv;
if (!srcPath || !outPath) {
  console.error('usage: node tools/gen-huffman.js <input.c> <output.js>');
  process.exit(2);
}

const src = fs.readFileSync(srcPath, 'utf8');
const start = src.indexOf('huff_sym_table[]');
if (start < 0) throw new Error('huff_sym_table not found');
const body = src.slice(start, src.indexOf('};', start));

const pairs = [...body.matchAll(/\{\s*(\d+)\s*,\s*(0x[0-9A-Fa-f]+)U?\s*\}/g)]
  .map((m) => [Number(m[1]), Number(m[2]) >>> 0]);

if (pairs.length !== 257) {
  throw new Error(`expected 257 huffman symbols (incl. EOS), got ${pairs.length}`);
}

const codes = pairs.map(([nbits, left], sym) => {
  // nghttp2 的码字左对齐到 32 位，还原为右对齐的规范码
  const code = nbits === 32 ? left : left >>> (32 - nbits);
  return [code, nbits, sym];
});

// 按码长分组：规范 Huffman 码同组内符号升序排列、码字连续（符号 id 可与其他码长交错）
const groups = new Map();
for (const [code, nbits, sym] of codes) {
  let g = groups.get(nbits);
  if (!g) groups.set(nbits, (g = { nbits, firstCode: code, symbols: [] }));
  if (g.symbols.length > 0 && sym <= g.symbols[g.symbols.length - 1]) {
    throw new Error(`symbols not ascending at length ${nbits}, symbol ${sym}`);
  }
  if (g.firstCode + g.symbols.length !== code) {
    throw new Error(`non-contiguous code at length ${nbits}, symbol ${sym}`);
  }
  g.symbols.push(sym);
}

const groupLines = [...groups.values()]
  .sort((a, b) => a.nbits - b.nbits)
  .map((g) => `  ${g.nbits}: [${g.firstCode}, [${g.symbols.join(',')}]],`)
  .join('\n');

const codeLines = codes
  .map(([code, nbits], i) => `[${code},${nbits}]${i < 256 ? ',' : ''}`)
  .join(' ');

const out = `// 此文件由 tools/gen-huffman.js 自动生成，数据源：nghttp2 lib/nghttp2_hd_huffman_data.c
// 码表版权归 nghttp2 作者所有 (MIT License)；码字定义同 RFC 7541 附录 B。
// 每条 CODES[i] = [右对齐码字, 码长]，共 257 项，256 为 EOS。
'use strict';

const CODES = [
${codeLines}
];

// GROUPS[码长] = [该长度首个码字, 按顺序的符号 id 列表]，供规范码逐位解码。
const GROUPS = {
${groupLines}
};

const EOS_SYMBOL = 256;
const MAX_BITS = 30;

module.exports = { CODES, GROUPS, EOS_SYMBOL, MAX_BITS };
`;

fs.writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${codes.length} symbols, ${groups.size} distinct lengths`);
