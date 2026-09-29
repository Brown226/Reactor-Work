"""扫描件/图片 OCR（PP-OCR ONNX 最小管线）。

为什么不用 RapidOCR：其传递依赖 opencv-python(-headless) 单 wheel ~44MB，
会吃掉 file-tools OCR 栈的减重收益。这里只依赖 onnxruntime + numpy + Pillow +
（PDF）PyMuPDF，模型沿用 PP-OCRv5 mobile det/rec（Apache-2.0）。

对齐 file-tools `ocr_scan` 的语义：文本 + 平均置信度 + 逐行结果；不输出表格结构。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# PP-OCRv5 mobile 常用输入高度；rec 宽度按模型上限截断
DET_INPUT_SIZE = 736
REC_INPUT_HEIGHT = 48
REC_INPUT_WIDTH = 320
DET_THRESH = 0.3
DET_BOX_THRESH = 0.6
UNCLIP_RATIO = 1.5
MIN_SIDE = 3


@dataclass
class OcrLine:
    text: str
    confidence: float
    box: list[list[float]] = field(default_factory=list)


@dataclass
class OcrPageResult:
    text: str
    confidence: float
    lines: list[OcrLine]
    filtered_low_confidence: int = 0


class OcrEngineUnavailable(RuntimeError):
    """缺 onnxruntime / 模型 / 字典时抛出；调用方翻译为 ENGINE_UNAVAILABLE。"""


def _import_numpy():
    try:
        import numpy as np
        return np
    except ImportError as e:
        raise OcrEngineUnavailable("缺少 numpy（OCR 推理数组库）") from e


def _import_ort():
    try:
        import onnxruntime as ort
        return ort
    except ImportError as e:
        raise OcrEngineUnavailable("缺少 onnxruntime（OCR 推理引擎）") from e


def resolve_model_paths(models_dir: str | os.PathLike[str] | None = None) -> dict[str, Path]:
    """定位 det/rec ONNX 与字典。顺序：显式参数 > OCR_MODELS_DIR > 受管 office-engines 根。"""
    candidates: list[Path] = []
    if models_dir:
        candidates.append(Path(models_dir))
    env = os.environ.get("OCR_MODELS_DIR", "").strip()
    if env:
        candidates.append(Path(env))
    root = os.environ.get("ZCODE_SKILL_ENGINE_ROOT", "").strip()
    if root:
        candidates.append(Path(root) / "ocr-models")
        candidates.append(Path(root) / "python" / "ocr-models")

    files = {
        "det": "PP-OCRv5_mobile_det_infer.onnx",
        "rec": "PP-OCRv5_mobile_rec_infer.onnx",
        "dict": "ppocrv5_dict.txt",
    }
    for base in candidates:
        if all((base / name).is_file() for name in files.values()):
            return {k: base / name for k, name in files.items()}
    raise OcrEngineUnavailable(
        "未找到 OCR 模型（PP-OCRv5_mobile det/rec + 字典）。"
        "请设置 OCR_MODELS_DIR 或 ZCODE_SKILL_ENGINE_ROOT，或运行 office-engines 资产脚本。"
    )


def engine_status(models_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    status: dict[str, Any] = {"ok": False, "numpy": False, "onnxruntime": False, "models": False}
    try:
        _import_numpy()
        status["numpy"] = True
    except OcrEngineUnavailable:
        pass
    try:
        _import_ort()
        status["onnxruntime"] = True
    except OcrEngineUnavailable:
        pass
    try:
        paths = resolve_model_paths(models_dir)
        status["models"] = True
        status["model_files"] = {k: str(v) for k, v in paths.items()}
    except OcrEngineUnavailable as e:
        status["error"] = str(e)
    status["ok"] = bool(status["numpy"] and status["onnxruntime"] and status["models"])
    return status


class PpOcrEngine:
    """进程内单例：onnx 会话与字典只加载一次。"""

    def __init__(self, models_dir: str | os.PathLike[str] | None = None):
        np = _import_numpy()
        ort = _import_ort()
        self._np = np
        paths = resolve_model_paths(models_dir)
        so = ort.SessionOptions()
        so.log_severity_level = 3
        self._det = ort.InferenceSession(str(paths["det"]), so, providers=["CPUExecutionProvider"])
        self._rec = ort.InferenceSession(str(paths["rec"]), so, providers=["CPUExecutionProvider"])
        # 字典与类别一一对应（含尾部空行，对齐 paddleocr-js：split('\r?\n') 不 trim）。
        # 类别 0 为 CTC blank；截断到 rec 输出维，避免 off-by-one。
        raw = paths["dict"].read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
        self._chars = raw.split("\n")
        rec_out = self._rec.get_outputs()[0].shape
        num_classes = int(rec_out[-1]) if isinstance(rec_out[-1], int) and rec_out[-1] > 0 else None
        if num_classes and len(self._chars) < num_classes:
            self._chars.extend([""] * (num_classes - len(self._chars)))
        elif num_classes:
            self._chars = self._chars[:num_classes]

    # ── 预处理 ──────────────────────────────────────────────────────────
    def _normalize(self, img):
        np = self._np
        # PP-OCR 按 OpenCV BGR 训练；调用方给 RGB，这里转 BGR 再归一化
        arr = img[:, :, ::-1].astype(np.float32)
        arr = (arr / 255.0 - 0.5) / 0.5
        return arr.transpose(2, 0, 1)[None, ...]

    def _resize_norm(self, img, height: int, width: int):
        np = self._np
        h, w = img.shape[:2]
        # 保持高宽比缩放到 height=48，再右侧 pad 到 width（PP-OCR rec 惯例）
        new_w = min(width, max(8, int(w * height / h) if h > 0 else 8))
        resized = self._resize_image(img, new_w, height)
        canvas = np.zeros((height, width, 3), dtype=resized.dtype)
        canvas[:, :new_w, :] = resized
        return self._normalize(canvas)

    @staticmethod
    def _resize_image(img, new_w: int, new_h: int):
        np = _import_numpy()
        try:
            from PIL import Image
        except ImportError as e:
            raise OcrEngineUnavailable("缺少 Pillow") from e
        pil = Image.fromarray(img if img.dtype == "uint8" else img.astype("uint8"))
        pil = pil.resize((new_w, new_h), Image.BILINEAR)
        return np.asarray(pil)

    # ── 检测 ──────────────────────────────────────────────────────────
    def detect(self, img):
        np = self._np
        h, w = img.shape[:2]
        scale = DET_INPUT_SIZE / max(h, w)
        nh, nw = max(32, int(h * scale) // 32 * 32), max(32, int(w * scale) // 32 * 32)
        resized = self._resize_image(img, nw, nh)
        inp = self._normalize(resized)
        name = self._det.get_inputs()[0].name
        pred = self._det.run(None, {name: inp.astype(np.float32)})[0][0, 0]
        boxes = self._boxes_from_prob(pred, scale, (h, w))
        return boxes

    def _boxes_from_prob(self, prob, scale, orig_hw):
        np = self._np
        mask = prob > DET_THRESH
        labels, n = self._connected_components(mask)
        boxes = []
        oh, ow = orig_hw
        for i in range(1, n + 1):
            ys, xs = np.where(labels == i)
            if len(xs) == 0:
                continue
            x0, x1 = xs.min(), xs.max() + 1
            y0, y1 = ys.min(), ys.max() + 1
            if min(x1 - x0, y1 - y0) < MIN_SIDE:
                continue
            # 映射回原图
            bx0 = max(0, min(ow, x0 / scale))
            by0 = max(0, min(oh, y0 / scale))
            bx1 = max(0, min(ow, x1 / scale))
            by1 = max(0, min(oh, y1 / scale))
            region = prob[y0:y1, x0:x1]
            if float(region.mean()) < DET_BOX_THRESH:
                continue
            # DB 概率图只标字芯，unclip 等价外扩：高度至少扩到接近字高
            pad_x = 3.0
            pad_y = max(6.0, (y1 - y0) * 0.55)
            boxes.append([
                [bx0 - pad_x, by0 - pad_y],
                [bx1 + pad_x, by0 - pad_y],
                [bx1 + pad_x, by1 + pad_y],
                [bx0 - pad_x, by1 + pad_y],
            ])
        # 按阅读顺序：先上后下，再左到右
        boxes.sort(key=lambda b: (sum(p[1] for p in b) / 4.0, sum(p[0] for p in b) / 4.0))
        return boxes

    @staticmethod
    def _connected_components(mask):
        np = _import_numpy()
        h, w = mask.shape
        labels = np.zeros((h, w), dtype=np.int32)
        current = 0
        for y in range(h):
            for x in range(w):
                if not mask[y, x] or labels[y, x]:
                    continue
                current += 1
                # BFS
                stack = [(y, x)]
                labels[y, x] = current
                while stack:
                    cy, cx = stack.pop()
                    for ny, nx in (
                        (cy - 1, cx),
                        (cy + 1, cx),
                        (cy, cx - 1),
                        (cy, cx + 1),
                    ):
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                            labels[ny, nx] = current
                            stack.append((ny, nx))
        return labels, current

    # ── 识别 ──────────────────────────────────────────────────────────
    def recognize(self, crop):
        np = self._np
        inp = self._resize_norm(crop, REC_INPUT_HEIGHT, REC_INPUT_WIDTH)
        name = self._rec.get_inputs()[0].name
        preds = self._rec.run(None, {name: inp.astype(np.float32)})[0][0]
        # 模型输出已是概率；CTC 贪心：0 = blank，相邻去重，空字符跳过
        ids = preds.argmax(axis=1)
        chars: list[str] = []
        prev = -1
        for idx in ids:
            idx = int(idx)
            if idx != prev and idx != 0 and idx < len(self._chars):
                ch = self._chars[idx]
                if ch:
                    chars.append(ch)
            prev = idx
        text = "".join(chars).strip()
        mask = ids != 0
        conf = float(preds[mask, ids[mask]].mean()) if mask.any() else 0.0
        return text, conf

    def recognize_image_array(self, img) -> OcrPageResult:
        np = self._np
        if img.ndim == 2:
            img = np.stack([img] * 3, axis=-1)
        if img.shape[2] == 4:
            img = img[:, :, :3]
        boxes = self.detect(img)
        lines: list[OcrLine] = []
        filtered = 0
        confs: list[float] = []
        parts: list[str] = []
        for box in boxes:
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            x0, x1 = int(max(0, min(xs))), int(min(img.shape[1], max(xs)))
            y0, y1 = int(max(0, min(ys))), int(min(img.shape[0], max(ys)))
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            crop = img[y0:y1, x0:x1]
            text, conf = self.recognize(crop)
            if not text:
                continue
            if conf < 0.5:
                filtered += 1
                continue
            lines.append(OcrLine(text=text, confidence=round(conf, 4), box=box))
            confs.append(conf)
            parts.append(text)
        avg = sum(confs) / len(confs) if confs else 0.0
        return OcrPageResult(
            text="\n".join(parts),
            confidence=round(avg, 4),
            lines=lines,
            filtered_low_confidence=filtered,
        )


_engine: PpOcrEngine | None = None


def get_engine(models_dir: str | os.PathLike[str] | None = None) -> PpOcrEngine:
    global _engine
    if _engine is None:
        _engine = PpOcrEngine(models_dir)
    return _engine


def _load_image_rgb(path: Path):
    np = _import_numpy()
    try:
        from PIL import Image
    except ImportError as e:
        raise OcrEngineUnavailable("缺少 Pillow") from e
    with Image.open(path) as im:
        return np.asarray(im.convert("RGB"))


def _pdf_page_images(path: Path, max_pages: int, dpi: int):
    np = _import_numpy()
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        raise OcrEngineUnavailable("缺少 PyMuPDF（PDF 栅格化）") from e
    doc = fitz.open(str(path))
    try:
        total = doc.page_count
        limit = min(total, max_pages)
        for i in range(limit):
            page = doc.load_page(i)
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
            yield i, total, img
    finally:
        doc.close()


def recognize_image(path: str | os.PathLike[str], *, min_confidence: float = 0.5) -> dict[str, Any]:
    engine = get_engine()
    img = _load_image_rgb(Path(path))
    # min_confidence 预留在引擎层过滤；当前管线在 recognize_image_array 内按 0.5 过滤
    result = engine.recognize_image_array(img)
    return {
        "text": result.text,
        "confidence": result.confidence,
        "lines": [
            {"text": l.text, "confidence": l.confidence, "box": l.box} for l in result.lines
        ],
        "filtered_low_confidence": result.filtered_low_confidence,
        "min_confidence": min_confidence,
    }


def recognize_pdf(
    path: str | os.PathLike[str],
    *,
    max_pages: int = 20,
    dpi: int = 200,
) -> dict[str, Any]:
    engine = get_engine()
    page_texts: list[str] = []
    confs: list[float] = []
    pages = 0
    total = 0
    for i, total_pages, img in _pdf_page_images(Path(path), max_pages, dpi):
        result = engine.recognize_image_array(img)
        total = total_pages
        pages += 1
        if result.text.strip():
            page_texts.append(result.text.strip())
        if result.lines:
            confs.append(result.confidence)
    note = None
    if total > pages:
        note = f"共 {total} 页，仅识别前 {pages} 页"
    return {
        "text": "\n\n--- 页分隔 ---\n\n".join(page_texts),
        "confidence": sum(confs) / len(confs) if confs else 0.0,
        "pages": pages,
        "total_pages": total,
        "note": note,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="office_skill_lib OCR")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_status = sub.add_parser("status")
    p_status.add_argument("--models-dir")
    p_img = sub.add_parser("image")
    p_img.add_argument("path")
    p_img.add_argument("--models-dir")
    p_img.add_argument("--min-confidence", type=float, default=0.5)
    p_pdf = sub.add_parser("pdf")
    p_pdf.add_argument("path")
    p_pdf.add_argument("--models-dir")
    p_pdf.add_argument("--max-pages", type=int, default=20)
    p_pdf.add_argument("--dpi", type=int, default=200)
    args = parser.parse_args(argv)

    try:
        if args.cmd == "status":
            payload = engine_status(getattr(args, "models_dir", None))
        elif args.cmd == "image":
            if getattr(args, "models_dir", None):
                os.environ["OCR_MODELS_DIR"] = args.models_dir
            payload = recognize_image(args.path, min_confidence=args.min_confidence)
        else:
            if getattr(args, "models_dir", None):
                os.environ["OCR_MODELS_DIR"] = args.models_dir
            payload = recognize_pdf(args.path, max_pages=args.max_pages, dpi=args.dpi)
    except OcrEngineUnavailable as e:
        json.dump({"status": "failed", "error": "ENGINE_UNAVAILABLE", "message": str(e)}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    except Exception as e:  # noqa: BLE001 — CLI 边界统一出 JSON
        json.dump({"status": "failed", "error": type(e).__name__, "message": str(e)}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    json.dump({"status": "success", **payload}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
