# 🛰️ 星载中继网关 · HPACK 连续头块复核台

地面审查员可按接收顺序粘贴 **1–8 段 Base64 编码的原始 HPACK 头块**，设置动态表容量上限，
逐段查看：

- 每个还原字段（名称 / 值 / 段内字节偏移 / 表示类型）
- 字段的**引用来源**：静态表 #n、动态表 #n（含跨段引用）或字面量
- 字面量是否经 **Huffman** 编码
- **插入 / 驱逐 / 容量更新**审计记录
- 每段解码结束时的**动态表快照**（容量上限、占用、累计插入、存活条目）

全部段在**同一张动态表**上连续解码（RFC 7541），用于发现压缩上下文错位导致的
遥测路由字段被“表面合法”地错误还原。非法块不会污染此前已提交的表状态。

## 规则覆盖（RFC 7541）

- §5.1 变长整数（5/6/7/4 位前缀，含续字节与溢出/截断检测）
- §5.2 字符串字面量（长度、原始 / Huffman）
- §B 静态 Huffman 码表：严格的末尾填充校验（≤7 位、必须等于 EOS 最高位）、EOS 符号检测
- §6.1 索引表示；§6.2.1 带增量索引字面量；§6.2.2 不索引；§6.2.3 绝不索引
- §4.1/§4.4 动态表插入与为腾位驱逐（含容量收缩驱逐）
- §4.2 动态表容量更新——**只允许出现在块首**（任何首部字段表示之后即报错）
- 限制：原始块总量 ≤ **64 KiB**；协商容量 ≤ **4096 字节**；段数 ≤ **8**

### 错误处理（均标注“块号 + 块内首个字节偏移”）

`TRUNCATED_INTEGER`（截断整数）、`TRUNCATED_STRING`（截断字符串）、
`INDEX_OUT_OF_RANGE`（越界索引，含索引 0）、`HUFFMAN_PADDING` / `HUFFMAN_EOS` /
`HUFFMAN_INVALID_CODE`（非法填充或 EOS）、`MISPLACED_RESIZE`（错误位置的容量更新）、
`RESIZE_EXCEEDS_CAPACITY`（容量更新超协商上限）、`FIELD_TOO_LARGE`（增量条目裸尺寸
32+名长+值长超过当前容量）。

失败块在**工作副本**上解码，任何插入/驱逐/容量变更都随异常整体丢弃；
已提交的各段快照原样保留，且响应不携带成功结论（页面同步清除旧结论）。

> 口径说明：RFC 7541 §4.4 允许“增量条目尺寸超过表容量时清空动态表但仍输出字段”。
  按本复核任务的验收口径，该情形直接判 `FIELD_TOO_LARGE` 并整段回滚，
  以避免单条目伪造挤空压缩上下文。

## 运行

需要 Node.js ≥ 20（应用本身**零第三方运行时依赖**，仅用内置模块）。

```bash
npm start                 # 默认 http://localhost:8080
PORT=9000 node src/server.js
```

- `GET /`          审查页面
- `GET /healthz`   健康检查（JSON，回传限额）
- `POST /api/decode` 请求体：
  ```json
  { "capacity": 4096,
    "segments": ["<第1段base64>", "<第2段base64>", "...共8槽，空槽可省略"] }
  ```
  成功返回 `200 { ok:true, results:[...], conclusion:{...} }`；
  块级规则错误返回 `422 { ok:false, error:{ block, code, offset, offsetHex, byte, message } }`；
  输入错误（Base64、容量、段数、总量）返回 `400`。

## Compose

```bash
docker compose up app --build         # 起服务，映射 8080
docker compose run --rm verify        # 验收入口（对 app 服务冒烟）
```

`verify` 服务执行：

1. 连续解码规则代码测试（`node --test test/`）
2. 页面构建检查（8 段输入、容量设置、清空按钮、渲染逻辑、内联脚本语法）
3. 对页面、健康路径与解码 API 的 HTTP/API 冒烟（含“后块引用前块插入字段”与
   “非法后续块不污染已提交表状态”两条验收主线）

完成后退出，退出码 `0` 全绿、非 `0` 有失败项。无 Docker 时也可直接 `npm run verify`
（会在随机端口本机拉起应用再冒烟）。

## 测试

```bash
npm test        # 35 项规则单测（含 RFC 7541 附录 C.4.1 权威向量）
npm run verify  # 测试 + 页面检查 + HTTP/API 冒烟
```

另外 `tools/gen-huffman.js` 可从 nghttp2（MIT）的 `nghttp2_hd_huffman_data.c`
重新生成 `src/engine/huffman-table.js`（RFC 7541 附录 B 码表）。
