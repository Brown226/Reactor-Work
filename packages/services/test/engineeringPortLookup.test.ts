import { describe, expect, it } from "vitest";

import {
  findListeningPortsByPid,
  findMcpPortByPid,
  isLoopbackAddress,
  parseLsof,
  parseNetTcpConnection,
  parsePosixSs,
  parseWindowsNetstat,
  rankCandidatePorts,
  waitForMcpPortByPid,
} from "../src/engineering/mcp-link/port-lookup.js";

// 端口反查是「按 PID 向运行实例要端口」，不解析厂商配置文件。
// 因此这里覆盖三类契约：各平台输出解析、候选排序、连通确认与轮询语义。
// 命令执行器与连通探测全部注入替身，测试不依赖本机是否装了 BIMBase。

describe("isLoopbackAddress", () => {
  it("识别 127.0.0.1 / ::1 / localhost 与 127 网段", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.1.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("[::1]")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
  });

  it("通配地址与外部地址不算回环，缺地址时返回 false", () => {
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("rankCandidatePorts", () => {
  it("回环优先、非特权端口优先、其余按端口号升序", () => {
    const ranked = rankCandidatePorts([
      { port: 8000, address: "0.0.0.0" },
      { port: 135, address: "127.0.0.1" },
      { port: 8001, address: "127.0.0.1" },
      { port: 9000 },
    ]);
    // 回环优先，其次非特权端口优先（MCP 服务不会是 135 这类系统端口），最后按端口号升序。
    expect(ranked.map((item) => item.port)).toEqual([8001, 135, 8000, 9000]);
  });

  it("同一端口只保留一条，并优先保留带地址的记录", () => {
    const ranked = rankCandidatePorts([{ port: 8000 }, { port: 8000, address: "127.0.0.1" }]);
    expect(ranked).toEqual([{ port: 8000, address: "127.0.0.1" }]);
  });

  it("丢弃非法端口但不丢弃合法候选", () => {
    const ranked = rankCandidatePorts([
      { port: 0 },
      { port: 70000 },
      { port: 8000, address: "127.0.0.1" },
    ]);
    expect(ranked.map((item) => item.port)).toEqual([8000]);
  });
});

describe("parseNetTcpConnection", () => {
  it("解析 PowerShell 返回的数组", () => {
    const output = JSON.stringify([
      { LocalAddress: "127.0.0.1", LocalPort: 8000 },
      { LocalAddress: "0.0.0.0", LocalPort: 9000 },
    ]);
    expect(parseNetTcpConnection(output)).toEqual([
      { port: 8000, address: "127.0.0.1" },
      { port: 9000, address: "0.0.0.0" },
    ]);
  });

  it("单条结果时 PowerShell 返回对象而非数组，同样要接受", () => {
    const output = JSON.stringify({ LocalAddress: "127.0.0.1", LocalPort: 8000 });
    expect(parseNetTcpConnection(output)).toEqual([{ port: 8000, address: "127.0.0.1" }]);
  });

  it("空输出与非法 JSON 返回空列表，不抛异常", () => {
    expect(parseNetTcpConnection("")).toEqual([]);
    expect(parseNetTcpConnection("   ")).toEqual([]);
    expect(parseNetTcpConnection("not json")).toEqual([]);
  });
});

describe("parseWindowsNetstat", () => {
  const output = [
    "",
    "活动连接",
    "",
    "  协议  本地地址          外部地址        状态           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900",
    "  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       4321",
    "  TCP    127.0.0.1:8001         0.0.0.0:0              LISTENING       4321",
    "  TCP    127.0.0.1:8002         127.0.0.1:51000        ESTABLISHED     4321",
    "  TCP    [::1]:8003             [::]:0                 LISTENING       4321",
    "  UDP    0.0.0.0:5353           *:*                                    4321",
    "",
  ].join("\r\n");

  it("只取目标 PID 的 TCP LISTENING 行", () => {
    expect(parseWindowsNetstat(output, 4321)).toEqual([
      { port: 8000, address: "127.0.0.1" },
      { port: 8001, address: "127.0.0.1" },
      { port: 8003, address: "[::1]" },
    ]);
  });

  it("其他 PID 与已建立连接不计入", () => {
    const ports = parseWindowsNetstat(output, 4321).map((item) => item.port);
    expect(ports).not.toContain(135);
    expect(ports).not.toContain(8002);
    expect(ports).not.toContain(5353);
  });

  it("无匹配 PID 时返回空列表", () => {
    expect(parseWindowsNetstat(output, 9999)).toEqual([]);
  });
});

describe("parsePosixSs", () => {
  const output = [
    'LISTEN 0 128 127.0.0.1:8000 0.0.0.0:* users:(("python",pid=4321,fd=7))',
    'LISTEN 0 128 0.0.0.0:9000 0.0.0.0:* users:(("node",pid=900,fd=21))',
    'LISTEN 0 128 127.0.0.1:8001 0.0.0.0:* users:(("python",pid=4321,fd=8))',
  ].join("\n");

  it("按 PID 过滤监听端口", () => {
    expect(parsePosixSs(output, 4321)).toEqual([
      { port: 8000, address: "127.0.0.1" },
      { port: 8001, address: "127.0.0.1" },
    ]);
  });

  it("PID 前缀相同但不同的进程不误匹配", () => {
    expect(parsePosixSs(output, 43)).toEqual([]);
    expect(parsePosixSs(output, 43210)).toEqual([]);
  });
});

describe("parseLsof", () => {
  const output = [
    "COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "python  4321 user    7u  IPv4 0x1234      0t0  TCP 127.0.0.1:8000 (LISTEN)",
    "python  4321 user    8u  IPv6 0x1235      0t0  TCP [::1]:8001 (LISTEN)",
    "python  4321 user    9u  IPv4 0x1236      0t0  TCP 127.0.0.1:51000->127.0.0.1:8000 (ESTABLISHED)",
  ].join("\n");

  it("只取监听态，忽略已建立连接与表头", () => {
    expect(parseLsof(output)).toEqual([
      { port: 8000, address: "127.0.0.1" },
      { port: 8001, address: "[::1]" },
    ]);
  });
});

describe("findListeningPortsByPid", () => {
  it("Windows 走 Get-NetTCPConnection", async () => {
    const calls: string[] = [];
    const ports = await findListeningPortsByPid(4321, {
      platform: "win32",
      run: async (command) => {
        calls.push(command);
        return JSON.stringify([{ LocalAddress: "127.0.0.1", LocalPort: 8000 }]);
      },
    });
    expect(calls).toEqual(["powershell"]);
    expect(ports).toEqual([{ port: 8000, address: "127.0.0.1" }]);
  });

  it("Get-NetTCPConnection 不可用时回退 netstat", async () => {
    const calls: string[] = [];
    const ports = await findListeningPortsByPid(4321, {
      platform: "win32",
      run: async (command) => {
        calls.push(command);
        if (command === "powershell") return "";
        return "  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       4321";
      },
    });
    expect(calls).toEqual(["powershell", "netstat"]);
    expect(ports).toEqual([{ port: 8000, address: "127.0.0.1" }]);
  });

  it("Linux 走 ss，ss 无结果时回退 lsof", async () => {
    const calls: string[] = [];
    const ports = await findListeningPortsByPid(4321, {
      platform: "linux",
      run: async (command) => {
        calls.push(command);
        if (command === "lsof") {
          return "python 4321 user 7u IPv4 0x1 0t0 TCP 127.0.0.1:8000 (LISTEN)";
        }
        return "";
      },
    });
    expect(calls).toEqual(["ss", "lsof"]);
    expect(ports).toEqual([{ port: 8000, address: "127.0.0.1" }]);
  });

  it("非整数或非正 PID 直接返回空列表，不执行命令", async () => {
    let executed = false;
    const ports = await findListeningPortsByPid(0, {
      platform: "win32",
      run: async () => {
        executed = true;
        return "";
      },
    });
    expect(ports).toEqual([]);
    expect(executed).toBe(false);
  });

  it("命令抛错时降级为空列表而不是向上抛", async () => {
    const ports = await findListeningPortsByPid(4321, {
      platform: "win32",
      run: async () => {
        throw new Error("powershell missing");
      },
    });
    expect(ports).toEqual([]);
  });
});

describe("findMcpPortByPid", () => {
  const winOutput = JSON.stringify([
    { LocalAddress: "0.0.0.0", LocalPort: 9000 },
    { LocalAddress: "127.0.0.1", LocalPort: 8001 },
    { LocalAddress: "127.0.0.1", LocalPort: 8000 },
  ]);

  it("按排序结果返回第一个可连通的端口", async () => {
    const probed: number[] = [];
    const port = await findMcpPortByPid(4321, {
      platform: "win32",
      run: async () => winOutput,
      probe: async (candidate) => {
        probed.push(candidate);
        return candidate === 8001;
      },
    });
    expect(port).toBe(8001);
    expect(probed).toEqual([8000, 8001]);
  });

  it("全部候选都连不通时返回 undefined，不猜端口", async () => {
    const port = await findMcpPortByPid(4321, {
      platform: "win32",
      run: async () => winOutput,
      probe: async () => false,
    });
    expect(port).toBeUndefined();
  });

  it("没有监听端口时不进行任何探测", async () => {
    let probes = 0;
    const port = await findMcpPortByPid(4321, {
      platform: "win32",
      run: async () => "",
      probe: async () => {
        probes += 1;
        return true;
      },
    });
    expect(port).toBeUndefined();
    expect(probes).toBe(0);
  });
});

describe("waitForMcpPortByPid", () => {
  it("冷启动时轮询到端口出现", async () => {
    let attempts = 0;
    const port = await waitForMcpPortByPid(4321, {
      platform: "win32",
      pollIntervalMs: 1,
      waitTimeoutMs: 2_000,
      run: async () => {
        attempts += 1;
        // 前两次还没开始监听，模拟软件仍在启动画面。
        if (attempts < 3) return "";
        return JSON.stringify([{ LocalAddress: "127.0.0.1", LocalPort: 8000 }]);
      },
      probe: async () => true,
    });
    expect(port).toBe(8000);
    expect(attempts).toBe(3);
  });

  it("超时后返回 undefined 而不是抛异常", async () => {
    const port = await waitForMcpPortByPid(4321, {
      platform: "win32",
      pollIntervalMs: 1,
      waitTimeoutMs: 30,
      run: async () => "",
      probe: async () => true,
    });
    expect(port).toBeUndefined();
  });
});
