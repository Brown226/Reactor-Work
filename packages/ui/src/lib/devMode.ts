/**
 * 开发者模式：连点版本号 7 下解锁/反锁的开关与手势。
 *
 * ## 为什么要有这个东西
 *
 * 「本地模型配置」与"自选模型"是一条**绕过治理链路**的旁路：企业会话下模型清单本该由服务端目录
 * 决定，本地那份配置一敞开，白名单就没有意义。它不该在日常界面被随手点到，但调试时又要够快
 * ——于是借用安卓手势：连点版本号 7 下。语义与验收场景见 `docs/model-governance-and-dev-mode.md`。
 *
 * ## 为什么是独立的小 store 而不是全局 store
 *
 * 这是**纯本地的调试开关**：不进用户配置、不上报、也不与其它窗口同步（与原项目 Reactor-Desktop
 * 的 `prefs` 口径一致），因此不值得并进承载会话与鉴权的全局 store（那份 store 也不该出现调试开关）。
 * 形态参考同目录的 `workflowRunAckStore.ts`：模块级状态 + `useSyncExternalStore` 订阅。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

/** 解锁/反锁所需的连点次数（对齐安卓开发者选项）。 */
export const DEV_TAP_TARGET = 7;

/** 相邻两次点击的最大间隔；超过即重新计数——不设窗口的话，隔半天点一下也会累加。 */
export const DEV_TAP_WINDOW_MS = 1500;

/** 结果提示停留时长。 */
const HINT_MS = 2600;

const DEV_MODE_STORAGE_KEY = "zcode-dev-mode-unlocked";

/** 解锁/反锁的结果提示（`null` = 不显示）。文案交给调用方本地化。 */
export type DevTapHint = "unlocked" | "locked" | null;

let devModeUnlocked = readSafeLocalStorage(DEV_MODE_STORAGE_KEY) === "true";
const listeners = new Set<() => void>();

export function isDevModeUnlocked(): boolean {
  return devModeUnlocked;
}

export function setDevModeUnlocked(unlocked: boolean): void {
  if (devModeUnlocked === unlocked) {
    return;
  }
  devModeUnlocked = unlocked;
  // 默认**锁着**：开发者模式是显式动作才能进的状态，绝不自开。
  writeSafeLocalStorage(DEV_MODE_STORAGE_KEY, unlocked ? "true" : "false");
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 响应式读取解锁状态（任意入口切换后，所有消费点一起刷新）。 */
export function useDevModeUnlocked(): boolean {
  return useSyncExternalStore(subscribe, isDevModeUnlocked, isDevModeUnlocked);
}

export interface DevTap {
  /** 版本号上的 `onClick` 直接接它 */
  onTap: () => void;
  /** 解锁/反锁的结果提示；连点途中**不给**进度提示 */
  hint: DevTapHint;
}

/**
 * 版本号连点计数。
 *
 * 每个 `useDevTap()` 实例有自己的计数（侧栏点 4 下 + 关于页点 3 下 = **不解锁**）：混着点最后
 * 自己也说不清点了哪，而"在一个地方连续点 7 下"是唯一能自我验证的操作。
 *
 * 连点途中的"再点 N 下"进度提示**不显示**——隐藏入口的进度条等于把后门画在门上；只有真正
 * 切换了状态才提示结果。
 */
export function useDevTap(): DevTap {
  const [hint, setHint] = useState<DevTapHint>(null);
  const tapsRef = useRef(0);
  const lastAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const onTap = useCallback(() => {
    const now = Date.now();
    if (now - lastAtRef.current > DEV_TAP_WINDOW_MS) tapsRef.current = 0;
    lastAtRef.current = now;
    tapsRef.current += 1;
    if (tapsRef.current < DEV_TAP_TARGET) return;

    tapsRef.current = 0;
    const next = !isDevModeUnlocked();
    setDevModeUnlocked(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setHint(next ? "unlocked" : "locked");
    timerRef.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);

  return { onTap, hint };
}
