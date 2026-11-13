// [Reactor 本地定制] 上游此文件 re-export `@deepseek-ai/dsh-client-ui-primitives`（dsh 私有包）。
// Reactor 没有这个包：所有调用方已改为直接 import `../adapters/primitives.js`，
// 本文件仅为「上游整目录覆盖后不立刻炸」保留一个转发壳。
export { FishLogo, MarkdownText, writeClipboard } from '../../adapters/primitives.js'
