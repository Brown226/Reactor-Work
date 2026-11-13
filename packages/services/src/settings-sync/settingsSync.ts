import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncImportResult,
  SettingsSyncProgressEvent,
  SettingsSyncFirstRunPromptState,
  SettingsSyncSelection,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISettingsSyncService {
  getClaudeAgentsFileMigrationStatus(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<SettingsSyncClaudeAgentsFileMigrationStatus>;
  copyClaudeAgentsFileToZcodeAgentsFile(request?: {
    workspacePath?: string;
    workspaceIdentity?: string;
    overwrite?: boolean;
  }): Promise<SettingsSyncClaudeAgentsFileCopyResult>;
  detect(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    categories?: SettingsSyncSelection["category"][];
    intent?: "firstRun" | "manualImport";
  }): Promise<SettingsSyncDiscoveryResult>;
  importSelected(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    selections: SettingsSyncSelection[];
    onProgress?: (event: SettingsSyncProgressEvent) => void;
  }): Promise<SettingsSyncImportResult>;
  /** 读取首启迁移提示的消费状态（用户在引导里点过开始/跳过即视为已处理）。 */
  getFirstRunPromptState(): Promise<SettingsSyncFirstRunPromptState>;
  /** 标记首启迁移提示已处理，避免下次启动重复弹出。 */
  markFirstRunPromptHandled(): Promise<void>;
}

export const ISettingsSyncService = createServiceDescriptor<ISettingsSyncService>(
  ServiceChannels.SettingsSync,
);
