import { createLogger } from '../utils/Logger';

const log = createLogger('PushGateway');

export type UserPushSender = (userId: string, text: string) => Promise<boolean>;

/**
 * 全局主动消息推送网关（解耦 WeixinBot 与业务服务，支持多用户传话、定时任务统一推送）
 */
export class PushGateway {
  private static instance: PushGateway;
  private sender: UserPushSender | null = null;

  private constructor() {}

  static getInstance(): PushGateway {
    if (!PushGateway.instance) {
      PushGateway.instance = new PushGateway();
    }
    return PushGateway.instance;
  }

  registerSender(fn: UserPushSender): void {
    this.sender = fn;
    log.info('全局主动推送通道已注册');
  }

  isReady(): boolean {
    return this.sender !== null;
  }

  async sendToUser(userId: string, text: string): Promise<boolean> {
    if (!this.sender) {
      log.warn(`主动推送失败：尚未注册微信发送通道 (目标: ${userId})`);
      return false;
    }
    try {
      return await this.sender(userId, text);
    } catch (err: any) {
      log.error(`向 ${userId} 主动推送异常: ${err?.message || err}`);
      return false;
    }
  }
}
