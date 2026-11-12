import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "web-session-smoke-"));
const port = 3131;
const child = spawn(process.execPath, ["packages/server/dist/entry-http.js"], {
  env: {
    ...process.env,
    REACTOR_WEB_SESSION_AUTH: "1",
    REACTOR_IDENTITY_URL: "http://127.0.0.1:1",
    REACTOR_WEB_DATA_ROOT: root,
    REACTOR_WEB_SESSION_DB: join(root, "sessions.sqlite"),
    PORT: String(port),
    HOST: "127.0.0.1",
    ZCODE_SERVER_HOST: "127.0.0.1",
    ZCODE_SERVER_AUTH_TOKEN: "",
    ZCODE_WEB_STATIC_ROOT: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

async function waitForServer() {
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/server-info`);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server not ready\n${stderr}`);
}

try {
  await waitForServer();
  const info = await (await fetch(`http://127.0.0.1:${port}/api/server-info`)).json();
  const session = await fetch(`http://127.0.0.1:${port}/api/auth/session`);
  const workspace = await fetch(`http://127.0.0.1:${port}/api/user-workspace`);
  console.log(
    JSON.stringify(
      {
        authRequired: info.authRequired,
        workspaces: info.workspaces,
        sessionStatus: session.status,
        workspaceStatus: workspace.status,
      },
      null,
      2,
    ),
  );
  if (session.status !== 401 || workspace.status !== 401) {
    process.exitCode = 1;
  }
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 上 SQLite 句柄可能稍晚释放。
  }
}
