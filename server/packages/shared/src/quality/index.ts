/**
 * 质量门禁（W4-③）—— 出口。
 *
 * 设计来源：LeAgent `context/artifact_error_tracker.py` 的**机制**（产物校验 → 修复指令 →
 * 同 turn 收敛），但**不抄其业务文案**（见调研报告 §5.8：那是一大段面向具体工具的英文指令）。
 *
 * 纯函数层放在 shared：前端也能用同一套规则给用户提示「这份文档有 X 个问题」，
 * 而不是前端/后端各写一份判断。
 */

export * from "./types.js";
export * from "./checks.js";
