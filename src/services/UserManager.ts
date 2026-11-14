import * as fs from 'fs';
import * as path from 'path';

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

  // 专属网盘配置 (允许每个微信用户绑定自己的夸克 Cookie，未设置时继承全局默认)
  quarkCookie?: string;
  defaultPan?: 'quark' | 'aliyun' | 'uc' | '115';
  saveRootDir?: string; // 用户专属保存根目录，默认 /我的资源

  // 专属 DeepSeek API Key (允许每个微信用户使用自己的 Key，未设置时共享继承 Key 或全局系统 Key)
  deepseekApiKey?: string;
  deepseekModel?: string;

  // 影视追剧规划 / 订阅列表
  watchlist: {
    title: string;
    type: 'movie' | 'tv';
    category?: string;
    status: 'planned' | 'saving' | 'completed';
    addedAt: number;
    lastSavedUrl?: string;
    note?: string;
  }[];

  // 专属偏好设置
  preferences: {
    preferredQuality?: '4K' | '1080P' | '原盘' | 'any';
    autoSaveOnSelect?: boolean; // 命中序号时是否直接自动转存
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
      fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
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
      const existing = plan.watchlist.find((w) => w.title.toLowerCase() === title.toLowerCase());
      if (existing) {
        existing.status = 'completed';
        existing.lastSavedUrl = shareUrl;
      } else {
        plan.watchlist.push({
          title,
          type: 'movie',
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
    const exists = plan.watchlist.some((w) => w.title.toLowerCase() === title.toLowerCase());
    if (exists) {
      return { success: false, message: `《${title}》已经在您的影视追剧清单中了。` };
    }

    plan.watchlist.push({
      title,
      type: category.includes('剧') ? 'tv' : 'movie',
      category,
      status: 'planned',
      addedAt: Date.now(),
      note,
    });
    this.saveUserPlan(plan);
    return { success: true, message: `✅ 已将《${title}》加入您的专属追剧/收藏清单！` };
  }

  removeFromWatchlist(userId: string, title: string): boolean {
    const plan = this.getUserPlan(userId);
    const beforeLen = plan.watchlist.length;
    plan.watchlist = plan.watchlist.filter((w) => !w.title.includes(title));
    if (plan.watchlist.length !== beforeLen) {
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

  setUserPreferredQuality(userId: string, quality: '4K' | '1080P' | '原盘' | 'any'): void {
    const plan = this.getUserPlan(userId);
    if (!plan.preferences) {
      plan.preferences = { autoSaveOnSelect: true };
    }
    plan.preferences.preferredQuality = quality;
    this.saveUserPlan(plan);
  }

  getAllUsers(): UserPlan[] {
    return Array.from(this.memoryCache.values());
  }
}
