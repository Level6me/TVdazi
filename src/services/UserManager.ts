import * as fs from 'fs';
import * as path from 'path';
import { SerializedJsonStore } from '../utils/StorageQueue';

export interface UserPlan {
  // 基础身份
  userId: string;
  alias?: string;
  createdAt: number;
  updatedAt: number;

  // 邀请关系与 DeepSeek Key 共享来源
  invitedBy?: string; // 谁邀请了此用户
  inheritedApiKey?: string; // 继承自邀请人的 API Key
  shareMode?: 'shared' | 'standalone'; // 继承共享还是自理独立

  // 专属网盘配置 (允许每个微信用户绑定自己的网盘凭证，未设置时继承全局默认)
  quarkCookie?: string;
  aliyunToken?: string;
  pan115Cookie?: string;
  defaultPan?: 'quark' | 'aliyun' | 'uc' | '115';
  saveRootDir?: string; // 用户专属保存根目录，默认 /我的资源
  webhookUrl?: string; // 媒体库刷新 Webhook (Alist / Emby / Jellyfin)

  // 专属 DeepSeek API Key (允许每个微信用户使用自己的 Key，未设置时共享继承 Key 或全局系统 Key)
  deepseekApiKey?: string;
  deepseekModel?: string;

  // 影视追剧规划 / 订阅列表
  watchlist: {
    title: string;
    type: 'movie' | 'tv';
    category?: string;
    status: 'planned' | 'saving' | 'completed';
    currentEpisode?: number;
    addedAt: number;
    lastSavedUrl?: string;
    note?: string;
  }[];

  // 专属偏好设置
  preferences: {
    preferredQuality?: string;
    autoSaveOnSelect?: boolean; // 命中序号时是否直接自动转存
  };

  // 个人观影画像（显式偏好 + 时间衰减隐式行为）
  tasteProfile?: {
    explicitLikes: {
      genres: string[];
      regions: string[];
      directors: string[];
      actors: string[];
      favoriteSeeds: string[];
    };
    explicitDislikes: {
      genres: string[];
      titles: string[];
    };
    implicitEvents: Array<{
      title: string;
      action: 'save' | 'share' | 'search' | 'skip';
      genres: string[];
      region?: string;
      directors?: string[];
      actors?: string[];
      decade?: string;
      timestamp: number;
    }>;
    updatedAt: number;
  };

  // 历史转存与搜索统计
  stats: {
    totalSearches: number;
    totalSaves: number;
    lastActiveAt: number;
  };
}

export interface PendingInvite {
  inviterUserId: string;
  shareApiKey: boolean; // 是否共享邀请人的 DeepSeek Key
  inviterApiKey?: string;
  createdAt: number;
}

export class UserManager {
  private static instance: UserManager;
  private usersDir: string;
  private memoryCache: Map<string, UserPlan> = new Map();
  // 正在进行的分享状态（等待用户选择“共享”还是“独立”）
  private pendingSharePrompts: Map<string, { inviterUserId: string; createdAt: number }> = new Map();
  // 已生成的待核销邀请池 (qrcode -> PendingInvite)
  private pendingInvites: Map<string, PendingInvite> = new Map();

  constructor() {
    this.usersDir = path.resolve(__dirname, '../../data/users');
    this.ensureDir();
    this.loadAll();
  }

  static getInstance(): UserManager {
    if (!UserManager.instance) {
      UserManager.instance = new UserManager();
    }
    return UserManager.instance;
  }

  private ensureDir() {
    if (!fs.existsSync(this.usersDir)) {
      fs.mkdirSync(this.usersDir, { recursive: true });
    }
  }

  private getSafeFilename(userId: string): string {
    const safe = Buffer.from(userId).toString('hex');
    return path.join(this.usersDir, `${safe}.json`);
  }

  private loadAll() {
    try {
      const files = fs.readdirSync(this.usersDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const content = fs.readFileSync(path.join(this.usersDir, file), 'utf-8');
            const data: UserPlan = JSON.parse(content);
            if (data && data.userId) {
              this.memoryCache.set(data.userId, data);
            }
          } catch {}
        }
      }
    } catch {}
  }

  /**
   * 设置用户的待决分享对话状态（询问是否共享 API Key）
   */
  setPendingSharePrompt(userId: string) {
    this.pendingSharePrompts.set(userId, { inviterUserId: userId, createdAt: Date.now() });
  }

  getPendingSharePrompt(userId: string): boolean {
    const p = this.pendingSharePrompts.get(userId);
    if (!p) return false;
    // 5分钟有效期
    if (Date.now() - p.createdAt > 300000) {
      this.pendingSharePrompts.delete(userId);
      return false;
    }
    return true;
  }

  clearPendingSharePrompt(userId: string) {
    this.pendingSharePrompts.delete(userId);
  }

  /**
   * 注册邀请凭据与共享 Key 策略
   */
  registerInvite(qrcode: string, inviterUserId: string, shareApiKey: boolean) {
    const inviterPlan = this.getUserPlan(inviterUserId);
    const activeKey = inviterPlan.deepseekApiKey || inviterPlan.inheritedApiKey || process.env.DEEPSEEK_API_KEY || '';

    this.pendingInvites.set(qrcode, {
      inviterUserId,
      shareApiKey,
      inviterApiKey: shareApiKey ? activeKey : undefined,
      createdAt: Date.now(),
    });
  }

  /**
   * 当新用户或扫码用户绑定完成时，关联邀请人与 Key 继承
   */
  applyInvite(newUserId: string, qrcode: string): boolean {
    const invite = this.pendingInvites.get(qrcode);
    if (!invite) return false;

    const newPlan = this.getUserPlan(newUserId);
    newPlan.invitedBy = invite.inviterUserId;

    if (invite.shareApiKey && invite.inviterApiKey) {
      newPlan.inheritedApiKey = invite.inviterApiKey;
      newPlan.shareMode = 'shared';
    } else {
      newPlan.shareMode = 'standalone';
    }

    this.saveUserPlan(newPlan);
    this.pendingInvites.delete(qrcode);
    return true;
  }

  /**
   * 获取或初始化用户的独立规划数据
   */
  getUserPlan(userId: string): UserPlan {
    let plan = this.memoryCache.get(userId);
    if (!plan) {
      plan = {
        userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        saveRootDir: process.env.DEFAULT_SAVE_DIR || '/我的资源',
        watchlist: [],
        preferences: {
          preferredQuality: 'any',
          autoSaveOnSelect: true,
        },
        stats: {
          totalSearches: 0,
          totalSaves: 0,
          lastActiveAt: Date.now(),
        },
      };
      this.saveUserPlan(plan);
    }
    return plan;
  }

  /**
   * 保存更新用户数据
   */
  saveUserPlan(plan: UserPlan): void {
    plan.updatedAt = Date.now();
    this.memoryCache.set(plan.userId, plan);
    try {
      const filePath = this.getSafeFilename(plan.userId);
      SerializedJsonStore.enqueueWrite(filePath, plan).catch((err: any) => {
        console.error(`[UserManager] 保存用户 ${plan.userId} 数据失败:`, err.message);
      });
    } catch (err: any) {
      console.error(`[UserManager] 保存用户 ${plan.userId} 数据失败:`, err.message);
    }
  }

  recordSearch(userId: string) {
    const plan = this.getUserPlan(userId);
    plan.stats.totalSearches += 1;
    plan.stats.lastActiveAt = Date.now();
    this.saveUserPlan(plan);
  }

  recordSave(userId: string, title?: string, shareUrl?: string, category?: string) {
    const plan = this.getUserPlan(userId);
    plan.stats.totalSaves += 1;
    plan.stats.lastActiveAt = Date.now();

    if (title) {
      const cleanTitle = title.replace(/[《》]/g, '').trim();
      const existing = plan.watchlist.find((w) => w.title.toLowerCase() === cleanTitle.toLowerCase());
      const inferredType: 'movie' | 'tv' =
        category && /剧|动漫|综艺|纪录片/.test(category) ? 'tv' : 'movie';
      if (existing) {
        existing.status = 'completed';
        existing.lastSavedUrl = shareUrl;
        if (category) existing.category = category;
      } else {
        plan.watchlist.push({
          title: cleanTitle,
          type: inferredType,
          category,
          status: 'completed',
          addedAt: Date.now(),
          lastSavedUrl: shareUrl,
        });
      }
    }
    this.saveUserPlan(plan);
  }

  addToWatchlist(userId: string, title: string, category: string = '剧集', note: string = ''): { success: boolean; message: string } {
    const plan = this.getUserPlan(userId);
    const cleanTitle = title.replace(/[《》]/g, '').trim();
    const exists = plan.watchlist.some((w) => w.title.toLowerCase() === cleanTitle.toLowerCase());
    if (exists) {
      return { success: false, message: `《${cleanTitle}》已经在您的影视追剧清单中了。` };
    }

    plan.watchlist.push({
      title: cleanTitle,
      type: /剧|动漫|综艺|纪录片/.test(category) ? 'tv' : 'movie',
      category,
      status: 'planned',
      addedAt: Date.now(),
      note,
    });
    this.saveUserPlan(plan);
    return { success: true, message: `✅ 已将《${cleanTitle}》加入您的专属追剧/收藏清单！` };
  }

  removeFromWatchlist(userId: string, title: string): boolean {
    const plan = this.getUserPlan(userId);
    const cleanTitle = title.replace(/[《》]/g, '').trim().toLowerCase();
    if (!cleanTitle) return false;

    const exactIdx = plan.watchlist.findIndex((w) => w.title.trim().toLowerCase() === cleanTitle);
    if (exactIdx !== -1) {
      plan.watchlist.splice(exactIdx, 1);
      this.saveUserPlan(plan);
      return true;
    }

    // 无精确匹配时，仅当存在唯一模糊命中项才移除，避免删《庆余年》误删《庆余年2》
    const partialMatches = plan.watchlist.filter((w) => w.title.toLowerCase().includes(cleanTitle));
    if (partialMatches.length === 1) {
      plan.watchlist = plan.watchlist.filter((w) => w !== partialMatches[0]);
      this.saveUserPlan(plan);
      return true;
    }
    return false;
  }

  setUserQuarkCookie(userId: string, cookie: string): void {
    const plan = this.getUserPlan(userId);
    plan.quarkCookie = cookie.trim();
    this.saveUserPlan(plan);
  }

  setUserAliyunToken(userId: string, token: string): void {
    const plan = this.getUserPlan(userId);
    const clean = token.trim();
    if (!clean || ['reset', 'clear', '清除'].includes(clean.toLowerCase())) {
      delete plan.aliyunToken;
    } else {
      plan.aliyunToken = clean;
    }
    this.saveUserPlan(plan);
  }

  setUser115Cookie(userId: string, cookie: string): void {
    const plan = this.getUserPlan(userId);
    const clean = cookie.trim();
    if (!clean || ['reset', 'clear', '清除'].includes(clean.toLowerCase())) {
      delete plan.pan115Cookie;
    } else {
      plan.pan115Cookie = clean;
    }
    this.saveUserPlan(plan);
  }

  setUserWebhookUrl(userId: string, url: string): void {
    const plan = this.getUserPlan(userId);
    const clean = url.trim();
    if (!clean || ['reset', 'clear', '清除', 'off'].includes(clean.toLowerCase())) {
      delete plan.webhookUrl;
    } else {
      plan.webhookUrl = clean;
    }
    this.saveUserPlan(plan);
  }

  importToWatchlist(
    userId: string,
    titles: string[],
    category: string = '剧集'
  ): { added: string[]; skipped: string[] } {
    const plan = this.getUserPlan(userId);
    const added: string[] = [];
    const skipped: string[] = [];

    for (const rawTitle of titles) {
      const cleanTitle = rawTitle.replace(/[《》]/g, '').trim();
      if (!cleanTitle || cleanTitle.length < 1) continue;
      const exists = plan.watchlist.some((w) => w.title.toLowerCase() === cleanTitle.toLowerCase());
      if (exists) {
        skipped.push(cleanTitle);
        continue;
      }
      plan.watchlist.push({
        title: cleanTitle,
        type: /电影/.test(category) ? 'movie' : 'tv',
        category,
        status: 'planned',
        addedAt: Date.now(),
      });
      added.push(cleanTitle);
    }

    if (added.length > 0) {
      this.saveUserPlan(plan);
    }
    return { added, skipped };
  }

  updateWatchlistStatus(
    userId: string,
    title: string,
    status: 'planned' | 'saving' | 'completed',
    currentEpisode?: number
  ): boolean {
    const plan = this.getUserPlan(userId);
    const clean = title.replace(/[《》]/g, '').trim().toLowerCase();
    const item = plan.watchlist.find((w) => w.title.trim().toLowerCase() === clean);
    if (!item) return false;
    item.status = status;
    if (currentEpisode !== undefined && Number.isFinite(currentEpisode)) {
      item.currentEpisode = currentEpisode;
    }
    this.saveUserPlan(plan);
    return true;
  }

  setUserDeepSeekKey(userId: string, apiKey: string): void {
    const plan = this.getUserPlan(userId);
    const clean = apiKey.trim();
    if (clean === 'reset' || clean === 'clear' || clean === '重置' || clean === '恢复' || !clean) {
      delete plan.deepseekApiKey;
      delete plan.inheritedApiKey;
      delete plan.shareMode;
    } else {
      plan.deepseekApiKey = clean;
      delete plan.inheritedApiKey;
      plan.shareMode = 'standalone';
    }
    this.saveUserPlan(plan);
  }

  setUserRootDir(userId: string, rootDir: string): void {
    const plan = this.getUserPlan(userId);
    plan.saveRootDir = rootDir.trim();
    this.saveUserPlan(plan);
  }

  setUserPreferredQuality(userId: string, quality: string): void {
    const plan = this.getUserPlan(userId);
    if (!plan.preferences) {
      plan.preferences = { autoSaveOnSelect: true };
    }
    plan.preferences.preferredQuality = quality.trim() || 'any';
    this.saveUserPlan(plan);
  }

  getAllUsers(): UserPlan[] {
    return Array.from(this.memoryCache.values());
  }
}
