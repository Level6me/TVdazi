import OpenAI from 'openai';
import { UserManager } from '../services/UserManager';

export interface LlmClientResolution {
  client: OpenAI;
  model: string;
  visionModel: string;
  hasValidKey: boolean;
  isCustom: boolean;
}

/**
 * 统一的大模型客户端与配置工厂，保证各服务 baseURL、默认模型及用户级 Key 继承策略一致
 */
export class LlmClientFactory {
  private static globalClients: Map<string, OpenAI> = new Map();

  public static getGlobalBaseUrl(): string {
    return (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').trim();
  }

  public static getGlobalApiKey(): string {
    return (process.env.DEEPSEEK_API_KEY || '').trim();
  }

  public static getDefaultModel(): string {
    return (process.env.DEEPSEEK_MODEL || 'deepseek-flash').trim();
  }

  public static getVisionModel(): string {
    // 视觉识图固定优先使用多模态专用环境变量或原生多模态模型 deepseek-flash，避免误继承纯文本模型（如 deepseek-v4-pro）
    return (process.env.DEEPSEEK_VISION_MODEL || 'deepseek-flash').trim();
  }

  private static getOrCreateGlobalClient(apiKey: string, baseURL: string, timeoutMs: number): OpenAI {
    const cacheKey = `${baseURL}::${apiKey}::${timeoutMs}`;
    let client = this.globalClients.get(cacheKey);
    if (!client) {
      client = new OpenAI({
        apiKey: apiKey || 'dummy_key',
        baseURL,
        timeout: timeoutMs,
      });
      if (this.globalClients.size >= 20) {
        const oldest = this.globalClients.keys().next().value;
        if (oldest) this.globalClients.delete(oldest);
      }
      this.globalClients.set(cacheKey, client);
    }
    return client;
  }

  public static getClientForUser(userId?: string, timeoutMs: number = 12000): LlmClientResolution {
    const baseURL = this.getGlobalBaseUrl();
    const defaultModel = this.getDefaultModel();
    const visionModel = this.getVisionModel();

    if (userId) {
      const userPlan = UserManager.getInstance().getUserPlan(userId);
      const customKey = (userPlan.deepseekApiKey?.trim() || userPlan.inheritedApiKey?.trim() || '').trim();
      if (customKey) {
        return {
          client: this.getOrCreateGlobalClient(customKey, baseURL, timeoutMs),
          model: (userPlan.deepseekModel || defaultModel).trim(),
          visionModel,
          hasValidKey: true,
          isCustom: true,
        };
      }
    }

    const globalKey = this.getGlobalApiKey();
    return {
      client: this.getOrCreateGlobalClient(globalKey, baseURL, timeoutMs),
      model: defaultModel,
      visionModel,
      hasValidKey: globalKey.length > 0,
      isCustom: false,
    };
  }
}
