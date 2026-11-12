/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/constants/src/shared/sms.constant.ts
 * 许可：Apache-2.0（原文照搬，未改动）
 */
export const SmsScene = {
    LOGIN: 1,
    REGISTER: 2,
    BIND_MOBILE: 3,
    CHANGE_MOBILE: 4,
    FIND_PASSWORD: 5,
} as const;
export type SmsSceneType = (typeof SmsScene)[keyof typeof SmsScene];

export const SmsProvider = {
    ALIYUN: "aliyun",
    TENCENT: "tencent",
} as const;
export type SmsProviderType = (typeof SmsProvider)[keyof typeof SmsProvider];

/**
 * 场景级短信模板配置
 */
export interface SmsSceneTemplateConfig {
    enable?: boolean;
    templateId?: string;
    content?: string;
}

export interface AliyunSmsConfig {
    signName: string;
    appKey: string;
    secretKey: string;
    templateCode?: string;
    loginTemplateCode?: string;
    registerTemplateCode?: string;
    bindMobileTemplateCode?: string;
    changeMobileTemplateCode?: string;
    findPasswordTemplateCode?: string;
    sceneTemplates?: Partial<Record<SmsSceneType, SmsSceneTemplateConfig>>;
}

export interface TencentSmsConfig {
    signName: string;
    appId: string;
    secretId: string;
    secretKey: string;
    templateCode?: string;
    sceneTemplates?: Partial<Record<SmsSceneType, SmsSceneTemplateConfig>>;
}

export type SmsProviderData = AliyunSmsConfig | TencentSmsConfig;
