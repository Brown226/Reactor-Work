/**
 * [本地定制] qrcode-generator 的替身 —— 接到 Reactor 已装的 `qrcode`。
 *
 * DS-Bot 的 IM 扫码页用 `qrcode-generator` 的同步 API 画 SVG path：
 *   const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
 *   qr.getModuleCount(); qr.isDark(y, x)
 *
 * Reactor 没有这个包但有 `qrcode`（同样 Apache/MIT 许可）。这里用它的
 * `create()` 同步 API 构造同形状对象，保持调用方一行不改。
 */
import QRCode from "qrcode";

/** 与上游 `qrcode(typeNumber, errorCorrectionLevel)` 同签名。 */
export default function qrcode(_typeNumber, errorCorrectionLevel = "M") {
  let matrix = null;
  const level = String(errorCorrectionLevel).toUpperCase();

  return {
    addData(text) {
      // 上游支持多次 addData 拼段落；这里同样累积，最后一次 make 统一编码。
      matrix = matrix === null ? { text: String(text) } : { text: `${matrix.text}${text}` };
    },
    make() {
      if (matrix === null) throw new Error("qrcode: addData() must be called before make()");
      const qr = QRCode.create(matrix.text, {
        errorCorrectionLevel: ["L", "M", "Q", "H"].includes(level) ? level : "M",
      });
      const { size, data } = qr.modules;
      matrix = { size, data };
    },
    getModuleCount() {
      if (matrix?.size === undefined) throw new Error("qrcode: make() must be called first");
      return matrix.size;
    },
    isDark(row, col) {
      if (matrix?.data === undefined) throw new Error("qrcode: make() must be called first");
      // qrcode 的 modules.data 是 Uint8Array，按 row * size + col 索引。
      return matrix.data[row * matrix.size + col] === 1;
    },
  };
}
