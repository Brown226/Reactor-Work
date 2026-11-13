/**
 * [本地定制] 剪贴板写入 —— DS-Bot 视图的 writeClipboard。
 *
 * 上游实现（dsh 的）是「navigator.clipboard 可用就用，否则退回 execCommand」。
 * Reactor 跑在手机上时 navigator.clipboard 在没有安全上下文（非 HTTPS / 非
 * localhost）会缺席，所以两路都要留。返回值契约：Promise<boolean>。
 */
export function writeClipboard(text) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value).then(
      () => true,
      () => fallbackWrite(value),
    );
  }
  return Promise.resolve(fallbackWrite(value));
}

function fallbackWrite(value) {
  if (typeof document === "undefined") return false;
  try {
    const area = document.createElement("textarea");
    area.value = value;
    // 固定在视口外，避免聚焦时页面跳动（iOS 会滚动到光标）。
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.setAttribute("readonly", "");
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
