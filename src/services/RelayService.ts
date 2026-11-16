import * as fs from 'fs';
import * as path from 'path';
import { UserManager } from './UserManager';
import { PushGateway } from './PushGateway';
import { SerializedJsonStore } from '../utils/StorageQueue';

export interface ActiveWechatContact {
  userId: string;
  botId: string;
  firstSeenAt: number;
  lastActiveAt: number;
  capturedName?: string;
}

export interface PendingRelayReply {
  fromUserId: string;
  fromDisplayName: string;
  originalMessage: string;
  timestamp: number;
}

export interface RelayHistoryItem {
  id: string;
  fromUserId: string;
  toUserId: string;
  message: string;
  timestamp: number;
  delivered: boolean;
}

interface RelayPersistedState {
  contacts: ActiveWechatContact[];
  pendingReplies: Record<string, PendingRelayReply>;
  personalAliases: Record<string, Record<string, string>>; // viewerId -> { targetUserId: customRemark }
  dndUsers: string[];
  history: RelayHistoryItem[];
}

/**
 * 多用户通讯录与跨用户传话引擎
 * - 以 data/user_routes.json 及运行时微信消息流为权威活跃微信用户源
 * - 持久化记忆用户昵称、个人备注与待回复传话上下文（支持 A -> B -> A 多轮接力对话）
 */
export class RelayService {
  private static instance: RelayService;
  private stateFilePath: string;
  private routesFilePath: string;
  private state: RelayPersistedState;
  private userManager: UserManager;
  private static readonly REPLY_TTL_MS = 24 * 60 * 60 * 1000;

  private constructor(statePath?: string, routesPath?: string) {
    const dataDir = path.resolve(process.cwd(), 'data');
    this.stateFilePath = statePath || path.join(dataDir, 'relay_state.json');
    this.routesFilePath = routesPath || path.join(dataDir, 'user_routes.json');
    this.userManager = UserManager.getInstance();
    this.state = {
      contacts: [],
      pendingReplies: {},
      personalAliases: {},
      dndUsers: [],
      history: [],
    };
    this.loadState();
    this.syncFromUserRoutes();
  }

  static getInstance(): RelayService {
    if (!RelayService.instance) {
      RelayService.instance = new RelayService();
    }
    return RelayService.instance;
  }

  /**
   * 仅供单元测试创建隔离的持久化实例，避免污染生产通讯录
   */
  static createIsolatedForTest(statePath: string, routesPath: string): RelayService {
    return new RelayService(statePath, routesPath);
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          this.state = {
            contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
            pendingReplies: parsed.pendingReplies || {},
            personalAliases: parsed.personalAliases || {},
            dndUsers: Array.isArray(parsed.dndUsers) ? parsed.dndUsers : [],
            history: Array.isArray(parsed.history) ? parsed.history : [],
          };
        }
      }
    } catch {
      // ignore corrupted state
    }
  }

  private persist(): void {
    SerializedJsonStore.enqueueWrite(this.stateFilePath, this.state).catch(() => {});
  }

  /**
   * 启动时从 data/user_routes.json 自动同步已记录过的真实微信用户，确保服务重启不丢失用户感知
   */
  public syncFromUserRoutes(): void {
    try {
      if (!fs.existsSync(this.routesFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.routesFilePath, 'utf-8'));
      if (!raw || typeof raw !== 'object') return;
      let changed = false;
      for (const [userId, route] of Object.entries<any>(raw)) {
        if (!userId || !route?.botId) continue;
        const existing = this.state.contacts.find((c) => c.userId === userId);
        const ts = Number(route.updatedAt || Date.now());
        if (!existing) {
          this.state.contacts.push({
            userId,
            botId: String(route.botId),
            firstSeenAt: ts,
            lastActiveAt: ts,
          });
          changed = true;
        } else if (ts > existing.lastActiveAt) {
          existing.lastActiveAt = ts;
          existing.botId = String(route.botId);
          changed = true;
        }
      }
      if (changed) {
        this.persist();
      }
    } catch {
      // ignore
    }
  }

  /**
   * 微信收到消息时自动登记/刷新活跃用户通讯录
   */
  public registerActiveUser(userId: string, botId: string, capturedName?: string): void {
    if (!userId) return;
    const now = Date.now();
    let contact = this.state.contacts.find((c) => c.userId === userId);
    if (!contact) {
      contact = {
        userId,
        botId,
        firstSeenAt: now,
        lastActiveAt: now,
        capturedName: capturedName?.trim() || undefined,
      };
      this.state.contacts.push(contact);
    } else {
      contact.botId = botId || contact.botId;
      contact.lastActiveAt = now;
      if (capturedName && capturedName.trim()) {
        contact.capturedName = capturedName.trim();
      }
    }

    // 若协议层捕获到了真实微信昵称且用户尚未自设昵称，自动记忆
    if (capturedName && capturedName.trim()) {
      const plan = this.userManager.getUserPlan(userId);
      if (!plan.alias) {
        plan.alias = capturedName.trim();
        this.userManager.saveUserPlan(plan);
      }
    }

    this.persist();
  }

  public maskUserId(userId: string): string {
    if (!userId) return '未知用户';
    const clean = userId.replace(/@im\.wechat$/i, '');
    if (clean.length <= 10) return clean;
    return `${clean.slice(0, 4)}..${clean.slice(-4)}`;
  }

  /**
   * 获取指定用户的对外显示名称（优先级：对方个人备注 > 用户自设昵称 > 协议捕获名 > 默认编号“用户#N”）
   */
  public getDisplayName(targetUserId: string, viewerUserId?: string): string {
    if (viewerUserId && this.state.personalAliases[viewerUserId]?.[targetUserId]) {
      return this.state.personalAliases[viewerUserId][targetUserId];
    }
    const plan = this.userManager.getUserPlan(targetUserId);
    if (plan.alias && plan.alias.trim()) {
      return plan.alias.trim();
    }
    const contact = this.state.contacts.find((c) => c.userId === targetUserId);
    if (contact?.capturedName) {
      return contact.capturedName;
    }
    const idx = this.state.contacts.findIndex((c) => c.userId === targetUserId);
    return idx >= 0 ? `用户${idx + 1}` : this.maskUserId(targetUserId);
  }

  public setMyNickname(userId: string, nickname: string): { success: boolean; message: string } {
    const clean = nickname.replace(/[《》"'`\r\n]/g, '').trim();
    if (!clean || clean.length > 24) {
      return { success: false, message: '昵称长度请在 1~24 个字符以内哦，例如：`/name 小明`' };
    }
    const plan = this.userManager.getUserPlan(userId);
    plan.alias = clean;
    this.userManager.saveUserPlan(plan);
    return {
      success: true,
      message: `好嘞，我记住你叫「${clean}」啦！以后有朋友找你或帮你传话时都会这样称呼你~`,
    };
  }

  public setContactRemark(
    viewerUserId: string,
    targetQuery: string,
    remark: string
  ): { success: boolean; message: string } {
    const resolved = this.resolveRecipient(viewerUserId, targetQuery, true);
    if (resolved.status !== 'found' || !resolved.user) {
      return { success: false, message: resolved.errorMessage || '没找到你想备注的这位用户呢~' };
    }
    const clean = remark.replace(/[《》"'`\r\n]/g, '').trim();
    if (!clean || clean.length > 24) {
      return { success: false, message: '备注名请在 1~24 个字符以内哦~' };
    }
    if (!this.state.personalAliases[viewerUserId]) {
      this.state.personalAliases[viewerUserId] = {};
    }
    this.state.personalAliases[viewerUserId][resolved.user.userId] = clean;
    this.persist();
    return {
      success: true,
      message: `👌 记好啦！以后在你这边，「${resolved.user.displayName}」就对应备注为「${clean}」，直接说找「${clean}」就行！`,
    };
  }

  public setDnd(userId: string, enabled: boolean): string {
    const set = new Set(this.state.dndUsers);
    if (enabled) set.add(userId);
    else set.delete(userId);
    this.state.dndUsers = Array.from(set);
    this.persist();
    return enabled
      ? '🔕 已为你开启传话免打扰，其他人暂时无法通过我给你传话啦（发送 `/dnd off` 可恢复）。'
      : '🔔 已关闭传话免打扰，现在可以正常接收大家托我带的话啦~';
  }

  public isDndEnabled(userId: string): boolean {
    return this.state.dndUsers.includes(userId);
  }

  /**
   * 列出当前服务中已知的全部微信用户
   */
  public getDirectory(viewerUserId?: string): Array<{
    index: number;
    userId: string;
    displayName: string;
    maskedId: string;
    hasCustomAlias: boolean;
    isSelf: boolean;
    lastActiveAt: number;
    botId: string;
  }> {
    this.syncFromUserRoutes();
    return this.state.contacts.map((c, idx) => {
      const plan = this.userManager.getUserPlan(c.userId);
      return {
        index: idx + 1,
        userId: c.userId,
        displayName: this.getDisplayName(c.userId, viewerUserId),
        maskedId: this.maskUserId(c.userId),
        hasCustomAlias: Boolean(plan.alias || c.capturedName),
        isSelf: viewerUserId === c.userId,
        lastActiveAt: c.lastActiveAt,
        botId: c.botId,
      };
    });
  }

  public renderDirectoryText(viewerUserId: string): string {
    const list = this.getDirectory(viewerUserId);
    if (list.length === 0) {
      return '当前还没有记录到已接入的微信用户呢~ 大家先和我发一条消息后就会自动出现在通讯录里啦！';
    }

    const lines = [
      `👥 【当前服务已接入 ${list.length} 位微信用户】`,
      '----------------------------------------',
    ];
    list.forEach((u) => {
      const selfTag = u.isSelf ? ' (我)' : '';
      const nameTag = u.hasCustomAlias ? u.displayName : `${u.displayName} [未设昵称]`;
      lines.push(`${u.index}. ${nameTag}${selfTag} · 标识: ${u.maskedId}`);
    });
    lines.push('----------------------------------------');
    lines.push('💡 玩法提示：');
    lines.push('• 登记自己名字：直接发「我叫小明」或 `/name 小明`');
    lines.push('• 给别人起备注：发 `/alias 2 小红`（以后就能直接说“帮我问下小红...”）');
    lines.push('• 隔空传话：发「你问一下小红最近有什么好看的电影」或 `/say 2 在吗`');
    return lines.join('\n');
  }

  /**
   * 解析目标收件人（支持序号如 "2"/"用户2"、精确昵称、个人备注、脱敏 ID、模糊包含）
   */
  public resolveRecipient(
    senderUserId: string,
    targetQuery: string,
    allowSelf: boolean = false
  ): {
    status: 'found' | 'not_found' | 'ambiguous';
    user?: { index: number; userId: string; displayName: string };
    candidates?: Array<{ index: number; userId: string; displayName: string }>;
    errorMessage?: string;
  } {
    const q = (targetQuery || '').replace(/^[@#]/, '').trim();
    const list = this.getDirectory(senderUserId);
    if (list.length === 0) {
      return { status: 'not_found', errorMessage: '当前通讯录里还没有任何微信用户哦~' };
    }

    const pool = allowSelf ? list : list.filter((u) => u.userId !== senderUserId);
    if (pool.length === 0) {
      return {
        status: 'not_found',
        errorMessage: '目前通讯录里只有你一位用户呢，先让朋友也给我发条消息或扫码加入后再传话吧~',
      };
    }

    if (!q) {
      // 若除自己外仅有一位其他用户，且用户说“问一下对方/他”，可提示或确认
      return {
        status: 'ambiguous',
        candidates: pool,
        errorMessage: `你想把话带给哪位朋友呀？当前共有 ${pool.length} 位可选联系人：\n${pool
          .map((u) => `• ${u.index}. ${u.displayName} (${u.maskedId})`)
          .join('\n')}`,
      };
    }

    const qLower = q.toLowerCase();

    // 1. 按序号匹配（如 "2"、"用户2"、"#2"、"第2位"）
    const numMatch = q.match(/^(?:用户|第)?\s*(\d+)\s*(?:号|位)?$/i);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10);
      const hit = list.find((u) => u.index === idx);
      if (hit) {
        if (!allowSelf && hit.userId === senderUserId) {
          return { status: 'not_found', errorMessage: '哈哈，这是你自己呀，不能自己给自己传话哦~' };
        }
        return { status: 'found', user: { index: hit.index, userId: hit.userId, displayName: hit.displayName } };
      }
    }

    // 2. 精确匹配个人备注 / 昵称 / 真实 userId / 脱敏前缀
    const exactMatches = pool.filter((u) => {
      const personalRemark = this.state.personalAliases[senderUserId]?.[u.userId]?.toLowerCase();
      const planAlias = this.userManager.getUserPlan(u.userId).alias?.toLowerCase();
      return (
        u.displayName.toLowerCase() === qLower ||
        personalRemark === qLower ||
        planAlias === qLower ||
        u.userId.toLowerCase() === qLower ||
        u.maskedId.toLowerCase() === qLower
      );
    });
    if (exactMatches.length === 1) {
      const u = exactMatches[0];
      return { status: 'found', user: { index: u.index, userId: u.userId, displayName: u.displayName } };
    }
    if (exactMatches.length > 1) {
      return {
        status: 'ambiguous',
        candidates: exactMatches,
        errorMessage: `有好几位朋友都叫「${q}」呢，请用序号区分一下：\n${exactMatches
          .map((u) => `• ${u.index}. ${u.displayName} (${u.maskedId})`)
          .join('\n')}`,
      };
    }

    // 3. 模糊包含匹配（例如昵称包含关键词）
    const partialMatches = pool.filter((u) => {
      const personalRemark = this.state.personalAliases[senderUserId]?.[u.userId]?.toLowerCase() || '';
      const planAlias = this.userManager.getUserPlan(u.userId).alias?.toLowerCase() || '';
      return (
        u.displayName.toLowerCase().includes(qLower) ||
        personalRemark.includes(qLower) ||
        planAlias.includes(qLower)
      );
    });
    if (partialMatches.length === 1) {
      const u = partialMatches[0];
      return { status: 'found', user: { index: u.index, userId: u.userId, displayName: u.displayName } };
    }
    if (partialMatches.length > 1) {
      return {
        status: 'ambiguous',
        candidates: partialMatches,
        errorMessage: `匹配到多个名字含「${q}」的朋友，请告诉我是哪一位（回复序号即可）：\n${partialMatches
          .map((u) => `• ${u.index}. ${u.displayName} (${u.maskedId})`)
          .join('\n')}`,
      };
    }

    return {
      status: 'not_found',
      errorMessage: [
        `通讯录里还没找到叫「${q}」的朋友哦 😅`,
        '📋 当前可选联系人：',
        ...pool.map((u) => `• ${u.index}. ${u.displayName} (${u.maskedId})`),
        '💡 如果对方还没设置名字，对方可以发「我叫xxx」，或者你发 `/alias 序号 名字` 给他记个备注就能直接传话啦！',
      ].join('\n'),
    };
  }

  public getPendingReply(userId: string): PendingRelayReply | null {
    const entry = this.state.pendingReplies[userId];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > RelayService.REPLY_TTL_MS) {
      delete this.state.pendingReplies[userId];
      this.persist();
      return null;
    }
    return entry;
  }

  /**
   * 执行 A -> B 跨用户传话
   */
  public async sendRelayMessage(
    fromUserId: string,
    targetQuery: string,
    rawMessage: string
  ): Promise<{ success: boolean; replyToSender: string }> {
    const content = (rawMessage || '').trim();
    if (!content) {
      return { success: false, replyToSender: '你想托我带什么话呀？把内容也告诉我吧~' };
    }

    const resolved = this.resolveRecipient(fromUserId, targetQuery, false);
    if (resolved.status !== 'found' || !resolved.user) {
      return { success: false, replyToSender: resolved.errorMessage || '没找到目标收件人哦~' };
    }

    const recipient = resolved.user;
    if (this.isDndEnabled(recipient.userId)) {
      return {
        success: false,
        replyToSender: `对方（${recipient.displayName}）当前开启了传话免打扰，暂时无法转达哦~`,
      };
    }

    const senderNameForTarget = this.getDisplayName(fromUserId, recipient.userId);
    const recipientNameForTarget = this.getDisplayName(recipient.userId, recipient.userId);

    const outboundText = [
      `💬 ${recipientNameForTarget}，${senderNameForTarget} 托我给你带句话：`,
      `「${content}」`,
      '----------------------------------------',
      `💡 想回复的话，直接跟我说「跟他说 ...」或「/reply ...」我就会帮你原话带回去哦！`,
    ].join('\n');

    const delivered = await PushGateway.getInstance().sendToUser(recipient.userId, outboundText);
    if (!delivered) {
      return {
        success: false,
        replyToSender: `哎呀，给「${recipient.displayName}」发消息时微信通道暂时没响应（可能尚未绑定推送或对方会话已过期），请稍后再试一次~`,
      };
    }

    // 记录 B 的待回复上下文，方便 B 直接说“你跟他说...”时精准回传给 A
    this.state.pendingReplies[recipient.userId] = {
      fromUserId,
      fromDisplayName: senderNameForTarget,
      originalMessage: content,
      timestamp: Date.now(),
    };
    this.state.history.push({
      id: `relay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromUserId,
      toUserId: recipient.userId,
      message: content,
      timestamp: Date.now(),
      delivered: true,
    });
    if (this.state.history.length > 100) {
      this.state.history = this.state.history.slice(-100);
    }
    this.persist();

    const senderPlan = this.userManager.getUserPlan(fromUserId);
    const aliasTip = !senderPlan.alias
      ? `\n💡 小提示：你还没设置自己的名字，现在对方看到的是「${senderNameForTarget}」；随时对我说「我叫你的名字」我就记住啦！`
      : '';

    return {
      success: true,
      replyToSender: `📨 已帮你把话带给「${recipient.displayName}」啦！等对方回复后我第一时间转达给你~${aliasTip}`,
    };
  }

  /**
   * 回复最近给自己传话的人（B -> A 闭环）
   */
  public async replyToLastSender(
    replierUserId: string,
    rawMessage: string
  ): Promise<{ success: boolean; replyToReplier: string }> {
    const content = (rawMessage || '').trim();
    if (!content) {
      return { success: false, replyToReplier: '你想让我帮你说什么呀？把内容告诉我即可~' };
    }

    const pending = this.getPendingReply(replierUserId);
    if (!pending) {
      return {
        success: false,
        replyToReplier: '最近还没有人给你传过话呢，或者之前的传话已经超过 24 小时啦。你可以发 `/users` 看看有哪些朋友，直接指定名字传话哦！',
      };
    }

    if (this.isDndEnabled(pending.fromUserId)) {
      return {
        success: false,
        replyToReplier: `对方（${pending.fromDisplayName}）当前开启了免打扰，暂时无法回传消息。`,
      };
    }

    const replierNameForTarget = this.getDisplayName(replierUserId, pending.fromUserId);
    const targetName = this.getDisplayName(pending.fromUserId, pending.fromUserId);

    const outboundText = [
      `📩 ${targetName}，${replierNameForTarget} 回复你啦：`,
      `「${content}」`,
      '----------------------------------------',
      `💡 还可以继续对我说「跟他说 ...」接着聊哦！`,
    ].join('\n');

    const delivered = await PushGateway.getInstance().sendToUser(pending.fromUserId, outboundText);
    if (!delivered) {
      return {
        success: false,
        replyToReplier: `哎呀，把回复发给「${pending.fromDisplayName}」时通道异常，请稍后再试~`,
      };
    }

    // 支持 A <-> B 连续接力：把 A 的待回复对象更新为 B
    this.state.pendingReplies[pending.fromUserId] = {
      fromUserId: replierUserId,
      fromDisplayName: replierNameForTarget,
      originalMessage: content,
      timestamp: Date.now(),
    };
    this.state.history.push({
      id: `relay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromUserId: replierUserId,
      toUserId: pending.fromUserId,
      message: content,
      timestamp: Date.now(),
      delivered: true,
    });
    if (this.state.history.length > 100) {
      this.state.history = this.state.history.slice(-100);
    }
    this.persist();

    return {
      success: true,
      replyToReplier: `✅ 收到！已帮你把话转达给「${pending.fromDisplayName}」啦~`,
    };
  }
}
