/**
 * engineering-mcp-link 使用示例。
 *
 * 场景：驱动本机已安装的 BIMBase 建模，然后写脚本批量布置构件。
 * 注意 Agent 全程看不到画面，只读取结构化数据。
 */

import { connectToServer, getActiveLinks, isServerConnected } from "./index.js";

export async function example(): Promise<void> {
  // 1. 连接：优先复用已启动的实例，没有则自动发现并启动
  const connected = await connectToServer("bimbase");
  if (connected !== true) {
    // 连接失败返回可读文案，不抛异常；直接转告用户
    console.error(connected);
    return;
  }

  // 2. 确认连接状态
  if (!isServerConnected("bimbase")) {
    console.error("连接状态不一致");
    return;
  }

  // 3. 取连接简报，追加到系统提示，让模型知道有哪些函数可用
  const link = getActiveLinks()["bimbase"];
  const briefing = link?.briefing() ?? "";

  // 4. 取能力快照，判断某能力是否存在（不用试错）
  const snapshot = link?.capabilitySnapshot();
  const hasModeling = snapshot?.categories.includes("建模") ?? false;

  console.log({ briefing, hasModeling });

  // 5. 指定工程目录连接（可选）
  await connectToServer("bimbase", {
    exePath: "D:/BIMBase/BIMBase.exe",
    projectPath: "D:/work/test.p3d",
  });
}
