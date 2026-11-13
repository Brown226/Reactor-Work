# vendor/ds-bot-client

DS-Bot 的浏览器端视图代码，来源 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot) v0.3.2，
Apache-2.0（见 `LICENSE-ds-bot.txt`）。

- `ds-bot-client/`：原样拷贝自上游 `ds-bot/src/client/`（96 个文件，24k 行）。**不要就地修改**，
  上游升级时整目录覆盖即可；Reactor 侧的适配只发生在 `../adapters/` 和宿主 RPC 层。
- `ds-bot-app.css`：自上游 `app/ui/src/app.css`（窗口外壳样式）。

## 与上游的差异

只有一处：所有 `import ... from './dsh-primitives.js'` 由 `../adapters/primitives.js` 顶替
（见 `vite.config` 的 `botPrimitivesAlias` 插件）。上游桌面壳用同样手法解耦 dsh 私有包，
只是它把 45 行实现放在 `app/ui/src/primitives.js`。
