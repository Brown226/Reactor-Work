/**
 * 类型声明：EvoFlow 搬迁过来的 .jsx 页面组件。
 *
 * 这些文件是 EvoFlow 既有实现（JSX，无 TS 类型），本次只做接口适配不重写；
 * 用 d.ts 提供最小类型面，让调用方（index.tsx）有类型可依。
 * 后续若重写为 .tsx，删除本文件即可。
 */
import type { JSX } from "react";

export default function Component(): JSX.Element;
