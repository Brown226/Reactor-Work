# OCR 栈轻量化方案 · RapidOCR 下沉 office-engines

状态：方案待评审｜适用范围：file-tools `ocr_scan` + office-engines｜维护者：桌面工具组
参考：LeAgent `leagent[ocr]`（RapidOCR 默认 / PaddleOCR legacy，Apache-2.0）；
现状以 `docs/文件解析OCR-CAD-集成方案.md` 与 file-tools 资产树为准。

## 1. 背景与问题

`ocr_scan`（图片 / 扫描件 PDF → 文本）当前是一条 **Node 原生**链路：

```text
ocr_scan
  ├─ PDF → raster.ts（pdfjs-dist + @napi-rs/canvas）→ RGBA
  └─ 位图 → image-input.ts（jimp）→ RGBA
        └─ ocr-engine.ts（paddleocr-js + onnxruntime-node + PP-OCRv5 ONNX）
```

file-tools 资产树实测（win32-x64）：

| 子树 | 体积 | 用途 |
| --- | --- | --- |
| onnxruntime | 59.2 MB | ONNX 推理（Node 绑定，已裁到单平台） |
| ocr-models | 20.4 MB | PP-OCRv5 mobile det/rec + 字典 |
| canvas | 36.7 MB | PDF 栅格化（扫页给 OCR） |
| **OCR 小计** | **116.3 MB** | |
| anydoc | 7.9 MB | 读文档（不动） |
| dwg-sidecar | 35.3 MB | CAD（不动） |
| 合计 | 159.6 MB | |

痛点：

1. **体积**：OCR 一条能力吃掉 116MB，超过 anydoc + DWG 之和。
2. **双运行时**：文件读写创作已在 office-engines Python（143MB，含 PyMuPDF/pypdfium2），
   OCR 却另起 Node 原生栈；PDF 栅格化也有两套（PyMuPDF vs canvas+pdfjs）。
3. **稳定性**：`raster.ts` 注释记录 pdfjs 5.4 + @napi-rs/canvas 曾段错误，且要求锁 6.2.x。
4. **同代模型不同打包**：我们已是 PP-OCRv5 mobile **ONNX**；LeAgent 默认
   `rapidocr-onnxruntime`（模型打进 wheel）+ Python onnxruntime，同代模型合计约 **28MB**，
   是我们的 1/4。

### 1.1 LeAgent 可借点（只借思路，不借 Paddle）

| LeAgent 做法 | 评价 |
| --- | --- |
| 默认 RapidOCR（ONNX + wheel 内置模型），PaddlePaddle 降为 legacy extra | **借思路**（ONNX 轻量、模型跟包）；**不借实现**——RapidOCR 传递 `opencv-python` ~44MB，实测会吃掉减重收益 |
| `paddle` extra：paddlepaddle 单平台 wheel ~100MB+ | **不借**：比现状更重 |
| 图片 OCR 独立工具（置信度/box/过滤阈值） | 接口语义 `ocr_scan` 已有，不借 |

**实施定稿**：`office_skill_lib.ocr` 自研最小 PP-OCR ONNX 管线（onnxruntime + numpy + Pillow + PyMuPDF），复用现有 PP-OCRv5 mobile 模型。

## 2. 目标与非目标

**目标**

1. `ocr_scan` 对外契约不变（入参、出参、`ENGINE_UNAVAILABLE` 语义、离线可用）。
2. OCR 推理 + PDF 栅格化收敛到 **office-engines Python 单点**，file-tools 不再携带
   onnxruntime / ocr-models / canvas。
3. 安装包净减重 **约 85–90MB/平台**（见 §5）。
4. DWG、anydoc、审查引用锚点 **零改动**。

**非目标**

- 不换模型代数（仍 PP-OCRv5 mobile 级别）；不引入 PaddlePaddle / GPU 栈。
- 不改 `parse_document`；不做「OCR 结果喂审查锚点」——扫件本就不进字符偏移链路。
- 不为 OCR 去动 file-tools 的插件骨架与 MCP 注册面。

## 3. 产品规则与所有权

沿用 file-tools 分层（见 OCR-CAD 集成方案）：

| 规则 | 内容 |
| --- | --- |
| 唯一 owner | **扫描件/图片识字 = `ocr_scan`**。四件套 skill 不得自带 OCR；`pdf.py` 扫件场景仍走该工具 |
| 实现 owner | 推理与栅格化唯一实现落在 **office-engines Python**（`office_skill_lib.ocr`） |
| 工具面 | `ocr_scan` 仍是 file-tools MCP 工具；允许它变成「校验入参 → 调 Python 子进程/服务 → 包结果」的薄壳 |
| 失败语义 | Python 引擎缺失/模型缺失 → `ENGINE_UNAVAILABLE` 类可读错误，禁止静默空文本 |
| 降级 | 有文本层的 PDF 仍先走 `parse_document`/Read，**只有**无文本层或报 needsOcr 时才 `ocr_scan` |

进程形态二选一（实现期定，默认 A）：

| 方案 | 形态 | 取舍 |
| --- | --- | --- |
| **A（默认）** | file-tools MCP 内 spawn office-engines Python 短进程 | 崩溃隔离差于现在的 in-process，但与「确定性工具一次调用」一致；实现最简单 |
| B | 独立 `ocr` 常驻子进程（stdio） | 延迟低，多一层生命周期；仅当 A 的冷启动不可接受时再上 |

## 4. 接口契约

### 4.1 对外（不变）

`ocr_scan(file_path, max_pages?)` → `{ status, text, confidence, pages, note? }`  
文本仍 `wrapFileContent`；多页仍 `--- 页分隔 ---`；仍支持 png/jpg/jpeg/bmp/tif/tiff/webp/pdf。

### 4.2 对内（新增共享 Python 模块）

```python
# office_skill_lib.ocr —— 由 prepare-office-engines-assets 拷入 site-packages
def recognize_image(path: str, *, min_confidence: float = 0.5) -> OcrPageResult: ...
def recognize_pdf(path: str, *, max_pages: int = 20, dpi: int = 200) -> OcrPdfResult: ...
def engine_status() -> dict: ...  # rapidocr/onnx/模型路径是否可用，供 env_check 类诊断
```

| 字段 | 语义 |
| --- | --- |
| `OcrPageResult` | `text` / `confidence` / `lines[{text, confidence, box?}]` / `filtered_low_confidence` |
| `OcrPdfResult` | 页列表 + 总页数 + 平均置信度 + 「仅识别前 N 页」note |
| 栅格化 | **PyMuPDF**（已在 19 包闭包）`page.get_pixmap(dpi=...)` → RGBA；不再使用 canvas/pdfjs |
| 推理 | 自研最小 PP-OCR ONNX 管线：`onnxruntime` + `numpy` + Pillow（**不用 RapidOCR/OpenCV**） |

### 4.3 env / 资产

| 项 | 约定 |
| --- | --- |
| 引擎根 | 复用 `ZCODE_SKILL_ENGINE_ROOT` / `ZCODE_PYTHON_PATH`（office-engines 解析层已就绪） |
| 模型 | RapidOCR wheel **内置**；不再单独 stage `ocr-models/` |
| file-tools 资产 | 删除 `onnxruntime/`、`ocr-models/`、`canvas/` 三个子树的 staging 与 `SOURCES.json` 条目；保留 anydoc、dwg-sidecar |
| 许可证 | `rapidocr-onnxruntime`（Apache-2.0）、`onnxruntime`（MIT）写入 THIRD-PARTY；移除 canvas/onnxruntime-node 条目 |

## 5. 体积账（win32-x64，实施中修正）

**方案原稿按 RapidOCR 估算，实测 RapidOCR 传递依赖 `opencv-python(-headless)` 单 wheel ~44MB，会吃掉减重收益，已弃用。**  
改为 **onnxruntime + numpy 最小 PP-OCR 管线**（`office_skill_lib.ocr`），模型仍用 PP-OCRv5 mobile。

| 项 | 现状 | 目标 | Δ |
| --- | --- | --- | --- |
| file-tools onnxruntime-node | 59.2 | 0 | −59.2 |
| file-tools ocr-models | 20.4 | 0（迁 office-engines） | 0（挪窝） |
| file-tools canvas | 36.7 | **保留**（pdf-research 仍用 pdfjs+canvas） | 0 |
| office-engines +onnxruntime/numpy/flatbuffers/protobuf | 0 | ~27 | +27 |
| office-engines +ocr-models | 0 | ~20 | +20 |
| office-engines +office_skill_lib | 0 | <0.05 | ~0 |
| **净（不含模型挪窝）** | | | **≈ −32 MB** |

若后续把 pdf-research 的栅格也迁到 PyMuPDF，可再拿掉 canvas（−37MB），累计约 **−70MB**。  
file-tools 预期树：anydoc 8 + canvas 37 + dwg 35 ≈ **80MB**（原 159.6MB）。

## 6. 接线与改动面

```text
scripts/office-skill-lib/ocr.py            # 新增：recognize_image / recognize_pdf / engine_status
scripts/prepare-office-engines-assets.mjs  # PACKAGE_PINS += rapidocr-onnxruntime, onnxruntime（+numpy 若缺）
scripts/prepare-file-tools-assets.mjs      # 删除 onnxruntime / canvas / ocr-models staging 与模型下载
apps/zcode-cli/packages/file-tools-plugin/
  src/tools/ocr-scan.ts                    # 薄壳：校验路径 → 调 Python → 包装原 schema
  src/ocr-engine.ts / raster.ts / image-input.ts   # 退役（或 raster 仅留测试用垫片）
  src/assets.ts / native.ts                # 去掉 onnxruntime/canvas 解析分支
  assets/win32-x64/SOURCES.json            # 组件清单同步
  test/ocr-scan.test.ts                    # 改为打真实 Python 引擎的集成测
packages/services/src/runtime-tools/       # 确认 ZCODE_PYTHON_PATH 注入覆盖 MCP 子进程（已有则不动）
docs/文件解析OCR-CAD-集成方案.md           # §资产树与体积表更新
```

| 接线点 | 要求 |
| --- | --- |
| MCP → Python | 绝对路径传参；工作目录固定；超时（建议 60s/页级汇总 180s）；stderr 进 debug 日志 |
| 缺引擎 | 返回原 `ENGINE_UNAVAILABLE` 文案风格（指向 office-engines / IT 预置），不回退空结果 |
| 多页 | 保持 `max_pages` 默认 20、上限 50；超限 note 不变 |
| 性能 | 单页图片冷启动目标 < 3s；20 页 PDF 目标 < 60s（与现状同数量级即可，不追求更快） |

## 7. 验收场景

1. **图片单页**：png/jpg 中英混排样张，`ocr_scan` 非空文本；置信度 ∈ (0,1]；与现网
   paddleocr-js 同图对比，**字错率不劣化**（允许换行差异）。
2. **扫描件 PDF**：≥3 页扫页 PDF，页分隔正确、`pages` 正确、超 `max_pages` 时 note 正确；
   与现状对比正文可对齐。
3. **无 OCR 环境**：故意去掉 office-engines Python 或 rapidocr wheel，`ocr_scan` 返回
   可读 `ENGINE_UNAVAILABLE`，不写文件、不空成功。
4. **资产树**：`prepare-file-tools-assets` 产物中 **无** onnxruntime/canvas/ocr-models；
   `prepare-office-engines-assets` manifest 含 rapidocr/onnx 条目且 sha256 稳定。
5. **边界**：文本层 PDF 不强制走 OCR（parse_document 可读则仍可读）；不支持后缀仍拒绝；
   超大图/损坏图给可读错误。
6. **回归**：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed` 无新增违规；
   DWG / parse_document / docx_patch 测试全绿（证明未误伤）。
7. **体积门禁**：win32-x64 实测 file-tools 资产树 ≤ 50MB，OCR 闭环在 office-engines 侧 ≤ 35MB。

### 7.1 首轮实测记录（2026-09-29）

| 项 | 结果 |
| --- | --- |
| embeddable Python 3.12.8 冒烟 | ✅ numpy/onnxruntime/PyMuPDF/Pillow + `office_skill_lib.ocr` 全过 |
| 英文样张 `OCR Test 123` | `OCRTest123` conf 0.90（字典无 ASCII 空格，与 Node 同源） |
| 中文样张三行（审查意见/标准引用/承压设备） | 三行全中，均 conf 0.987–0.995 |
| 对照 paddleocr-js 同图 | **不劣化**：第 2 行本管线无多余字符（js 侧多打一个 `I`） |
| `ocr_scan` 薄壳 e2e | ✅；file-tools 48 测全过 |
| typecheck / lint / architecture | 0 error / 0 error（87 既有 warning）/ 0 新增违规 |

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| RapidOCR 与 paddleocr-js 排行/切行差异导致「看起来变了」 | 用固定扫页 fixture 做双端对照表；审查链路本就不依赖 OCR 文本做字符锚点，产品风险低 |
| 子进程冷启动慢 | 方案 A 先测；超 3s 再上 B 常驻进程 |
| Python 缺 numpy/onnx 运行库 | 闭包按 import 实测补齐（沿用四件套 19 包实测方法） |
| Windows 路径/杀软锁 onnx | 模型只读展开到 site-packages；错误信息带完整路径 |
| 有人误以为可以顺手砍 anydoc | 本方案 **明确不动** anydoc；读路径单点化另案（fork-spec §9） |

## 9. 实施顺序

| 步骤 | 内容 | 出口 |
| --- | --- | --- |
| P1 | `office_skill_lib/ocr.py` + 闭包钉版（rapidocr/onnx）+ 双端对照 fixture | 图片/PDF 识别结果表 |
| P2 | `ocr-scan.ts` 改薄壳，删 Node OCR 依赖；file-tools staging 去三子树 | 验收 1–3、6 |
| P3 | 资产脚本与 SOURCES/许可证清理；体积门禁 | 验收 4、7 |
| P4 | 文档同步（OCR-CAD 集成方案体积表）+ 内网断网冒烟 | 验收 5 |

P1–P3 一辑交付；P4 随发布。

## 10. 与既有文档关系

| 文档 | 关系 |
| --- | --- |
| `文件解析OCR-CAD-集成方案.md` | 被本文修订：OCR 资产树、体积、推理栈 |
| `内网办公四件套-fork-spec.md` | 无边界变化；office-engines 闭包 +2 包 |
| `办公公式与字体管线-借入方案.md` | 并行方案，共享 office-skill-lib 落盘方式 |
