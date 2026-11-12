# 已完成-dwg-tools 与 ocr-tools 插件宿主模式启动失败修复

日期：2026-10-12

## 问题现象

桌面端「设置 → MCP 服务器」页中，官方内置插件三个文档类工具只有 `file-tools` 显示
「该插件 MCP 服务器已连接可用」，`dwg-tools`（图纸解析工具）与 `ocr-tools`（扫描件识别工具）
均显示「MCP 进程启动失败」。

## 根因（已实测确认）

官方插件的 MCP server 由 agent 子进程内的插件宿主运行，宿主命令为
`electron.exe zcode.cjs __zcode-plugin-host <plugin>/dist/mcp/server.js`
（`apps/zcode-cli/packages/cli/src/plugin-host-command.ts`）。宿主契约（同文件 49-52 行）：

```ts
const module = (await import(pathToFileURL(serverPath).href)) as HostedPluginModule;
if (typeof module.main !== "function") {
  throw new Error("Plugin server does not export main().");
}
await module.main();
```

即 **server.js 必须导出 `main()` 函数**。三个插件由 file-tools 拆出
（`docs/未完成-file-tools拆三插件方案.md`），但入口导出没有对齐：

| 插件 | dist/mcp/server.js 导出 | 宿主模式 |
| --- | --- | --- |
| file-tools | `createFileToolsMcpServer` + `main` | 可用 |
| dwg-tools | 仅 `createDwgToolsMcpServer` | **失败** |
| ocr-tools | 仅 `createOcrToolsMcpServer` | **失败** |

实测证据（用缓存目录中的真实 server.js 与真实宿主命令复现）：

```
file-tools：initialize 握手成功，serverInfo=file-tools/0.1.0
dwg-tools ：[exit] code=1，stderr = "Plugin host failed: Plugin server does not export main()."
```

附带隐患（本次一并修掉）：`ocr-tools/src/server.ts` 顶层无条件执行
`serveStdio(...)`，模块被 import 即有副作用；`dwg-tools/src/server.ts` 的 `isMain`
用文件名尾部匹配 `process.argv[1]`，而宿主恰好会把 `process.argv[1]` 置为 server.js 路径，
判定会误判为 true。两者都应在显式入口条件下才启动。

## 修复方案

`dwg-tools-plugin/src/server.ts` 与 `ocr-tools-plugin/src/server.ts` 对齐
`file-tools-plugin/src/server.ts` 的既有模式：

1. 导出 `async function main(): Promise<void>`：设置 `process.title`、把 `console.log/info/debug`
   改道 stderr（stdio MCP 的 stdout 是 JSON-RPC 通道）、`serveStdio` 起服务、
   stdin end/close 与 SIGINT/SIGTERM 时 shutdown（MCP SDK 的 stdio transport 不监听
   stdin end/close，父进程退出时收不到终点会沦为孤儿）；
2. 自启动判断改为 `isDirectMcpEntrypoint()`（realpath 全路径比较，兼容 symlink 安装目录），
   保留 `ZCODE_*_MCP_STDLIO=1` 环境变量开关的既有语义；
3. 移除 import 即启动的顶层副作用。

## 验收场景

1. 宿主命令实测：`electron.exe zcode.cjs __zcode-plugin-host <server.js>` 发 initialize
   握手，两个插件均返回 serverInfo，进程保活；
2. 单测：两个插件的 server 模块导出 `main` 函数（宿主契约防回归）；
3. 直接 `node dist/mcp/server.js` 的自启动形态行为不变。

## 验证结果

见提交记录。构建后需重新走插件 seed，使 `~/.reactor/cli/plugins/cache/` 下的
seed 副本同步为新 server.js（缓存中的 plugin.json 把 command 固定为本机
electron.exe 路径，属 seed 产物，随 seed 刷新）。
