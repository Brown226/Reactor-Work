interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  copyright: string;
  optimizationLine: string;
  versionLabel: string;
  okButtonLabel: string;
  /** 版本号连点解锁/反锁的结果提示文案（main 侧按 locale 提供）。 */
  devModeUnlockedHint: string;
  devModeLockedHint: string;
  /** 结果提示停留时长，与 `DEV_TAP_HINT_MS`（@zcode/shared）同源。 */
  devModeHintMs: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 280px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      /* 标记自带白色底板，深色主题下也自成对比，无需再套深色壳。 */
      .app-icon {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .app-logo {
        width: 48px;
        height: auto;
        display: block;
      }

      .title {
        margin: 20px 0 0;
        font-size: 13.5px;
        line-height: 1.18;
        font-weight: 700;
        letter-spacing: 0;
      }

      /* 版本号是开发者模式的手势入口（连点 7 下，见 docs/model-governance-and-dev-mode.md）。
         外观保持纯文本，不自我暴露；no-drag 保证点击不被窗口拖拽区吃掉。 */
      .version-tap {
        padding: 0;
        border: 0;
        background: none;
        font: inherit;
        color: inherit;
        cursor: default;
        text-align: inherit;
        -webkit-app-region: no-drag;
      }

      .dev-mode-hint {
        margin-top: 10px;
        font-size: 11px;
        line-height: 1.3;
        color: #303033;
      }

      .meta {
        margin-top: 28px;
        display: flex;
        flex-direction: column;
        gap: 17px;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }


      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }

        .dev-mode-hint {
          color: #e2e2e2;
        }
      }
    </style>
  </head>
  <body>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          <div class="app-icon" aria-hidden="true">
            <img
              class="app-logo"
              src="data:image/png;base64,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"
              alt=""
              aria-hidden="true"
            />
          </div>
          <h1 id="about-title" class="title">
            <button
              type="button"
              class="version-tap"
              title="${escapeHtml(`${input.applicationName} ${input.versionLabel} ${input.appVersion}`)}"
            >
              ${escapeHtml(input.applicationName)}<br />
              ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
            </button>
          </h1>
          <div class="meta">
            ${input.optimizationLine ? `<div>${escapeHtml(input.optimizationLine)}</div>` : ""}
            <div>${escapeHtml(input.copyright)}</div>
          </div>
          <div class="dev-mode-hint" role="status" hidden></div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      const closeWindow = () => window.close();
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });

      // 版本号连点入口：页面只上报原始点击，计数/判期/取反都在 main（aboutDevModeTap.ts），
      // 这里只负责展示 main 推送回来的结果提示。
      const aboutBridge = window.reactorAbout;
      const hintElement = document.querySelector(".dev-mode-hint");
      const unlockedHint = ${JSON.stringify(input.devModeUnlockedHint)};
      const lockedHint = ${JSON.stringify(input.devModeLockedHint)};
      let hintTimer = 0;
      const showHint = (unlocked) => {
        if (!hintElement) return;
        hintElement.textContent = unlocked ? unlockedHint : lockedHint;
        hintElement.hidden = false;
        window.clearTimeout(hintTimer);
        hintTimer = window.setTimeout(() => {
          hintElement.hidden = true;
        }, ${input.devModeHintMs});
      };
      aboutBridge?.onDevModeUnlockChanged?.((state) => showHint(state.unlocked));
      document
        .querySelector(".version-tap")
        ?.addEventListener("click", () => aboutBridge?.reportVersionTap());
    </script>
  </body>
</html>`;
}
