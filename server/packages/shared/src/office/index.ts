/**
 * 办公 IR（W3-①）—— 统一文档中间表示的出口。
 *
 * 设计来源：LeAgent `docgen`（Apache-2.0）。一个 IR + N 渲染器：
 * 内容语义（表格列类型/数字格式/涨跌色/CJK 列宽）下沉到共享引擎，
 * 渲染器只负责绘制。
 */

export * from "./ir.js";
export * from "./tables.js";
