import * as fs from 'fs';
import * as path from 'path';
import { UserManager } from './UserManager';
import { PushGateway } from './PushGateway';
import { SessionManager } from './SessionManager';
import { DoubanService, DoubanSubject } from './DoubanService';
import { UserProfileService } from './UserProfileService';
import { SerializedJsonStore } from '../utils/StorageQueue';
import { pickVariant, humanizeWithLlm } from '../utils/HumanTone';

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
    this.migrateLegacyPersonalAliases();
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

  private migrateLegacyPersonalAliases(): void {
    const entries = Object.values(this.state.personalAliases || {});
    if (entries.length === 0) return;

    let changed = false;
    for (const map of entries) {
      if (!map || typeof map !== 'object') continue;
      for (const [targetUserId, remark] of Object.entries(map)) {
        const clean = String(remark || '').replace(/[《》"'`\r\n]/g, '').trim();
        if (!targetUserId || !clean) continue;
        const plan = this.userManager.getUserPlan(targetUserId);
        if (!plan.alias || !plan.alias.trim()) {
          plan.alias = clean;
          this.userManager.saveUserPlan(plan);
        }
        changed = true;
      }
    }
    this.state.personalAliases = {};
    if (changed) {
      this.persist();
    }
  }

  /**
   * 获取指定用户的全员统一显示名称（全局唯一昵称 > 协议捕获名 > 默认编号“用户#N”）
   */
  public getDisplayName(targetUserId: string, _viewerUserId?: string): string {
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
      return {
        success: false,
        message: pickVariant(
          [
            '名字太长或空着呢，给我个 1~24 个字以内的称呼吧，比如直接说「我叫小明」~',
            '这名字长度不太对劲呀，换个 24 字以内的简短称呼试试？',
          ],
          `nick_err:${userId}`
        ),
      };
    }
    const plan = this.userManager.getUserPlan(userId);
    plan.alias = clean;
    this.userManager.saveUserPlan(plan);
    this.clearPersonalAliasForTarget(userId);
    return {
      success: true,
      message: pickVariant(
        [
          `记下来啦，以后我就喊你「${clean}」了，大伙儿看通讯录也都是这个名字~`,
          `行嘞「${clean}」！这名字好记，以后帮你递话我都这么叫`,
          `收到~ 从现在起你这边就叫「${clean}」啦，大家都看得到的`,
          `妥妥的，以后我就认准「${clean}」这个名儿了，传话也按这个来`,
        ],
        `nick_ok:${userId}`
      ),
    };
  }

  private clearPersonalAliasForTarget(targetUserId: string): void {
    let changed = false;
    for (const viewerId of Object.keys(this.state.personalAliases || {})) {
      if (this.state.personalAliases[viewerId] && targetUserId in this.state.personalAliases[viewerId]) {
        delete this.state.personalAliases[viewerId][targetUserId];
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  public setContactRemark(
    viewerUserId: string,
    targetQuery: string,
    remark: string
  ): { success: boolean; message: string } {
    const resolved = this.resolveRecipient(viewerUserId, targetQuery, true);
    if (resolved.status !== 'found' || !resolved.user) {
      return { success: false, message: resolved.errorMessage || '没翻到你想改名的那位朋友呢，发「通讯录」看下序号？' };
    }
    const clean = remark.replace(/[《》"'`\r\n]/g, '').trim();
    if (!clean || clean.length > 24) {
      return { success: false, message: '昵称写 1~24 个字以内就好，太长记不住啦~' };
    }
    const plan = this.userManager.getUserPlan(resolved.user.userId);
    plan.alias = clean;
    this.userManager.saveUserPlan(plan);
    this.clearPersonalAliasForTarget(resolved.user.userId);

    const oldName = resolved.user.displayName;
    return {
      success: true,
      message: pickVariant(
        [
          `搞定！已经把「${oldName}」改成「${clean}」了，现在大家看到的都统一叫「${clean}」~`,
          `行嘞，「${oldName}」这会儿已经换成「${clean}」啦，所有人两边都能对上号`,
          `记下啦，通讯录里把「${oldName}」改名叫「${clean}」了，以后找他直接喊这名就行`,
        ],
        `alias_ok:${viewerUserId}`
      ),
    };
  }

  public setDnd(userId: string, enabled: boolean): string {
    const set = new Set(this.state.dndUsers);
    if (enabled) set.add(userId);
    else set.delete(userId);
    this.state.dndUsers = Array.from(set);
    this.persist();

    return enabled
      ? pickVariant(
          [
            '好，先帮你把传话免打扰打开啦，这阵子没人能托我给你带话，想关了随时跟我说一声~',
            '收到，开启免打扰了，暂时帮你挡掉大家的传话，想恢复发 `/dnd off` 就行',
          ],
          `dnd_on:${userId}`
        )
      : pickVariant(
          [
            '好嘞，免打扰关掉啦，朋友们有啥话都能正常给你捎过来了~',
            '恢复啦！现在别人给你带话我又能帮你递过来了',
          ],
          `dnd_off:${userId}`
        );
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
      return '通讯录这会儿还是空的呢，等朋友也跟我聊过天就会自动出现在这儿啦~';
    }

    const lines = [`👥 认识的小伙伴都在这（共 ${list.length} 位）：`];
    list.forEach((u) => {
      const selfTag = u.isSelf ? '（我）' : '';
      const nameTag = u.hasCustomAlias ? u.displayName : `${u.displayName} · 还没起名`;
      lines.push(`${u.index}. ${nameTag}${selfTag}`);
    });
    lines.push('');
    lines.push('想改名直接说「我叫某某」或「把2号改名叫某某」就行，找谁带话也可以直接喊名字~');
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

    const baseOutbound = pickVariant(
      [
        `${recipientNameForTarget}，${senderNameForTarget} 刚才托我给你带句话：「${content}」\n有啥想回他的直接跟我说，我马上帮你捎回去~`,
        `嗨 ${recipientNameForTarget}，${senderNameForTarget} 刚找我让我转告你：「${content}」\n怎么回他直接打字发我就行！`,
        `${recipientNameForTarget} 在忙不？${senderNameForTarget} 刚让我跟你说一声：「${content}」\n想回话直接告诉我，我帮你传过去~`,
        `刚 ${senderNameForTarget} 递了句话让我转给 ${recipientNameForTarget}：「${content}」\n回他直接说「跟他说…」就行，我随叫随到`,
      ],
      `relay_out:${recipient.userId}`
    );

    const outboundText = await humanizeWithLlm(fromUserId, {
      actionDesc: `在微信上替「${senderNameForTarget}」向「${recipientNameForTarget}」传一句日常话（顺带一句自然引导说“想回他直接跟我说就行”）`,
      rawResult: baseOutbound,
      preserveExact: [recipientNameForTarget, senderNameForTarget, content],
    });

    const delivered = await PushGateway.getInstance().sendToUser(recipient.userId, outboundText);
    if (!delivered) {
      return {
        success: false,
        replyToSender: pickVariant(
          [
            `哎呀，刚才敲「${recipient.displayName}」微信没发过去（可能对方好久没跟我说过话了），过一会儿再试试？`,
            `唔，「${recipient.displayName}」那边暂时没连上微信，等会再喊我帮你捎过去吧~`,
          ],
          `relay_fail:${fromUserId}`
        ),
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
      ? `（顺便提一嘴，你还没起名字呢，对方现在看到你是「${senderNameForTarget}」，说句「叫我某某」我就能记住）`
      : '';

    return {
      success: true,
      replyToSender: pickVariant(
        [
          `好嘞，已经帮你在微信上跟「${recipient.displayName}」说了，等他回了我立刻喊你~${aliasTip}`,
          `搞定，原话已经给「${recipient.displayName}」捎过去啦！有回信我第一时间转给你${aliasTip}`,
          `放心吧，找「${recipient.displayName}」传过话了，坐等他回消息~${aliasTip}`,
          `已经帮您递给「${recipient.displayName}」咯，一有动静我马上告诉你！${aliasTip}`,
        ],
        `relay_ack:${fromUserId}`
      ),
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

    const baseReplyOutbound = pickVariant(
      [
        `${targetName}，${replierNameForTarget} 刚回你消息了：「${content}」\n还要接着聊就直接跟我说，我继续替你传过去~`,
        `有回音啦！${replierNameForTarget} 让我给 ${targetName} 回一句：「${content}」\n还想回话随时发我~`,
        `${targetName}，刚才 ${replierNameForTarget} 托我带回句话：「${content}」\n直接说「跟他说…」我再帮你递回去`,
      ],
      `reply_out:${pending.fromUserId}`
    );

    const outboundText = await humanizeWithLlm(replierUserId, {
      actionDesc: `把「${replierNameForTarget}」的回信自然地转达给「${targetName}」`,
      rawResult: baseReplyOutbound,
      preserveExact: [targetName, replierNameForTarget, content],
    });

    const delivered = await PushGateway.getInstance().sendToUser(pending.fromUserId, outboundText);
    if (!delivered) {
      return {
        success: false,
        replyToReplier: `哎呀，给「${pending.fromDisplayName}」回消息时没发出去，等会儿再试试吧~`,
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
      replyToReplier: pickVariant(
        [
          `妥了，原话已经替你传回给「${pending.fromDisplayName}」啦~`,
          `收到！刚帮你在微信上把这句回给「${pending.fromDisplayName}」了`,
          `好嘞，已转告「${pending.fromDisplayName}」，等他再回我就叫你`,
        ],
        `reply_ack:${replierUserId}`
      ),
    };
  }

  /**
   * 从当前用户会话或指定参数提取影视详情，并将结构化安利卡片分享给另一位微信用户
   */
  public async shareMovieToUser(
    fromUserId: string,
    targetQuery: string,
    options?: {
      movieTitle?: string;
      recommendReason?: string;
      selectionIndex?: number;
      skipNetworkLookup?: boolean;
    }
  ): Promise<{ success: boolean; replyToSender: string }> {
    const resolved = this.resolveRecipient(fromUserId, targetQuery, false);
    if (resolved.status !== 'found' || !resolved.user) {
      return { success: false, replyToSender: resolved.errorMessage || '没找到你想推荐给哪位朋友哦~' };
    }

    const recipient = resolved.user;
    if (this.isDndEnabled(recipient.userId)) {
      return {
        success: false,
        replyToSender: `对方（${recipient.displayName}）当前开启了传话免打扰，暂时无法推送影视分享哦~`,
      };
    }

    const sessionMgr = SessionManager.getInstance();
    const hotSess = sessionMgr.getHot(fromUserId);
    const searchSess = sessionMgr.getSearch(fromUserId);

    let title = (options?.movieTitle || '').replace(/[《》]/g, '').trim();
    let matchedSubject: DoubanSubject | undefined;

    if (options?.selectionIndex && hotSess?.items && hotSess.items[options.selectionIndex - 1]) {
      matchedSubject = hotSess.items[options.selectionIndex - 1];
      if (!title) title = matchedSubject.title;
    }

    if (!title) {
      title = sessionMgr.getRecentTargetTitle(fromUserId) || '';
    }

    if (!title) {
      return {
        success: false,
        replyToSender:
          '我还没知道你想分享哪部电影或剧集呢 😅\n你可以直接说「把《片名》推荐给 ' +
          recipient.displayName +
          '」，或者先让我给你推荐一部好片再分享哦！',
      };
    }

    if (!matchedSubject && hotSess?.items) {
      const lowerTitle = title.toLowerCase();
      matchedSubject = hotSess.items.find(
        (s) => s.title.toLowerCase() === lowerTitle || s.title.toLowerCase().includes(lowerTitle)
      );
    }

    let year = matchedSubject?.year;
    let rate = matchedSubject?.rate;
    let types = matchedSubject?.types;
    let shortComment = matchedSubject?.shortComment;
    let mediaType: 'movie' | 'tv' | undefined = hotSess?.type;

    if (!year && !rate && !options?.skipNetworkLookup) {
      try {
        const meta = await Promise.race([
          new DoubanService().getMovieMeta(title),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2200)),
        ]);
        if (meta) {
          year = meta.year || year;
          if (!title && meta.title) title = meta.title;
        }
      } catch {}
    }

    let sharedResourceUrl: string | undefined;
    if (searchSess?.items && searchSess.items.length > 0) {
      const lowerTitle = title.toLowerCase();
      const kwMatch =
        searchSess.keyword.toLowerCase().includes(lowerTitle) ||
        lowerTitle.includes(searchSess.keyword.toLowerCase());
      const resHit = kwMatch
        ? searchSess.items.find((i) => i.panType === 'quark') || searchSess.items[0]
        : searchSess.items.find((i) => i.title.toLowerCase().includes(lowerTitle));
      if (resHit?.shareUrl) {
        sharedResourceUrl = resHit.shareUrl;
      }
    }

    const senderNameForTarget = this.getDisplayName(fromUserId, recipient.userId);
    const recipientNameForTarget = this.getDisplayName(recipient.userId, recipient.userId);
    const note = (options?.recommendReason || '').trim();

    const yearPart = year ? ` (${year})` : '';
    const ratePart = rate ? ` · ⭐ ${rate}分` : '';
    const intro = pickVariant(
      [
        `🎬 ${recipientNameForTarget}，${senderNameForTarget} 刚让我给你安利一部片：`,
        `嗨 ${recipientNameForTarget}，${senderNameForTarget} 觉得这部超不错，非让我推给你看看：`,
        `${recipientNameForTarget}，刚收到 ${senderNameForTarget} 的好片投喂👇`,
      ],
      `share_intro:${recipient.userId}`
    );
    const cardLines = [
      intro,
      '',
      `**📽️ 《${title}》**${yearPart}${ratePart}`,
    ];
    if (types && types.length > 0) {
      cardLines.push(`标签：${types.slice(0, 4).join(' · ')}`);
    }
    if (shortComment) {
      cardLines.push(`> ${shortComment.slice(0, 80)}`);
    }
    if (note) {
      cardLines.push(`${senderNameForTarget} 说：「${note}」`);
    }
    if (sharedResourceUrl) {
      cardLines.push(`网盘直达：${sharedResourceUrl}`);
    }
    cardLines.push('');
    cardLines.push(`👉 想看回 **「存一下」** 或 **「搜一下」** 帮你存好；要回 ${senderNameForTarget} 话直接说就行~`);

    const delivered = await PushGateway.getInstance().sendToUser(recipient.userId, cardLines.join('\n'));
    if (!delivered) {
      return {
        success: false,
        replyToSender: `哎呀，想把《${title}》递给「${recipient.displayName}」但暂时没连上微信，等会儿再试试？`,
      };
    }

    // 为接收方写入双重上下文：1) 快捷搜存待确认影视；2) 跨用户回复传话目标
    sessionMgr.setLastMentionedTitle(recipient.userId, title);
    sessionMgr.setPendingImageSearch(recipient.userId, {
      standardTitle: title,
      aliases: [],
      year,
      mediaType,
      overview: shortComment || note || undefined,
    });

    this.state.pendingReplies[recipient.userId] = {
      fromUserId,
      fromDisplayName: senderNameForTarget,
      originalMessage: `给你安利了《${title}》${note ? `（${note}）` : ''}`,
      timestamp: Date.now(),
    };
    this.state.history.push({
      id: `share_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromUserId,
      toUserId: recipient.userId,
      message: `[分享影片] 《${title}》${note ? ` - ${note}` : ''}`,
      timestamp: Date.now(),
      delivered: true,
    });
    if (this.state.history.length > 100) {
      this.state.history = this.state.history.slice(-100);
    }
    this.persist();

    // 异步记录用户的分享偏好行为，用于增强个人观影画像
    UserProfileService.getInstance()
      .recordImplicitBehavior(fromUserId, title, 'share', {
        genres: types,
        year,
        skipLookup: true,
      })
      .catch(() => {});

    const senderPlan = this.userManager.getUserPlan(fromUserId);
    const aliasTip = !senderPlan.alias
      ? `（对了，你还没起名字，他现在看到的是「${senderNameForTarget}」，说一句「叫我某某」就能改啦）`
      : '';

    return {
      success: true,
      replyToSender: pickVariant(
        [
          `好嘞，已经把《${title}》推荐给「${recipient.displayName}」了！他要看直接回复我就能存~${aliasTip}`,
          `搞定，《${title}》安利卡片已经给「${recipient.displayName}」发过去啦，看看他喜不喜欢~${aliasTip}`,
          `推过去啦！《${title}》已送达「${recipient.displayName}」，他有回话我再来告诉你${aliasTip}`,
        ],
        `share_ack:${fromUserId}`
      ),
    };
  }
}
