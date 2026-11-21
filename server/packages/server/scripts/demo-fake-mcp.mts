// 演示用常驻假 MCP 上游（Streamable HTTP）：给活体服务器做端到端验证用。
// 启动：node --import tsx scripts/demo-fake-mcp.mts  （监听 127.0.0.1 随机端口并打印 /mcp 地址）
import { createServer, type ServerResponse } from "node:http";

const openStreams = new Set<ServerResponse>();
const server = createServer((request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(": ping\n\n");
    openStreams.add(response);
    response.on("close", () => openStreams.delete(response));
    return;
  }
  if (request.method === "DELETE") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const parsed = (() => {
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: unknown;
          method?: string;
          params?: Record<string, unknown>;
        };
      } catch {
        return null;
      }
    })();
    if (!parsed || typeof parsed.method !== "string") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid" } }));
      return;
    }
    const id = parsed.id ?? null;
    if (parsed.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "demo-session" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: (parsed.params?.protocolVersion as string | undefined) ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "demo-crm", version: "1.0.0" },
          },
        }),
      );
      return;
    }
    if (parsed.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    if (parsed.method === "tools/list") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "list_customers",
                description: "列出客户",
                annotations: { readOnlyHint: true },
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "update_customer",
                description: "更新客户资料",
                inputSchema: { type: "object", properties: { id: { type: "string" } } },
              },
              {
                name: "delete_customer",
                description: "删除客户",
                inputSchema: { type: "object", properties: { id: { type: "string" } } },
              },
            ],
          },
        }),
      );
      return;
    }
    if (parsed.method === "tools/call") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `demo-crm executed ${(parsed.params?.name as string) ?? ""}` }] },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }));
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  console.log(`DEMO_MCP_URL=http://127.0.0.1:${port}/mcp`);
});
