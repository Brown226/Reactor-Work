export { createHttpServer } from "./http.js";
// 桌面端知识库网关（独立模式）：只挂 /api/knowledge/owned/*，见该文件头部说明。
export {
  startKnowledgeGateway,
  type KnowledgeGatewayHandle,
  type StartKnowledgeGatewayOptions,
} from "./knowledge/standalone.js";
