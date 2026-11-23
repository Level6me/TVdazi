import { CloudResource } from '../types';
import { DoubanSubject } from './DoubanService';
import { FileTypeSummary, QuarkFileNode } from './QuarkOrganizer';

export interface RecentSavedSession {
  title?: string;
  targetPath: string;
  targetDirFid: string;
  topItems: QuarkFileNode[];
  allInspectedItems: QuarkFileNode[];
  archiveFiles: QuarkFileNode[];
  fakeArchiveFiles: Array<{ node: QuarkFileNode; restoredName: string; realExt: string; fakeExt: string }>;
  fileTypeSummary: FileTypeSummary;
  awaitingUnarchiveConfirm: boolean;
  savedAt: number;
}

export interface NetdiskListingSession {
  source: 'list' | 'search' | 'archives' | 'recent_saved';
  pathOrQuery: string;
  dirFid?: string;
  items: QuarkFileNode[];
  updatedAt: number;
}

export interface SearchSession {
  keyword: string;
  items: CloudResource[];
  page: number;
  pageSize: number;
  updatedAt: number;
}

export interface HotSession {
  type: 'movie' | 'tv';
  tag?: string;
  query?: string;
  items: DoubanSubject[];
  page: number;
  pageSize: number;
  updatedAt: number;
  mode?: 'recommend' | 'chart';
  chartHeading?: string;
  showWishOrDate?: boolean;
  chartHint?: string;
}

export interface PendingImageSearch {
  standardTitle: string;
  originalTitle?: string;
  englishTitle?: string;
  aliases: string[];
  year?: string;
  mediaType?: 'movie' | 'tv';
  overview?: string;
  updatedAt: number;
}

export class SessionManager {
  private static instance: SessionManager;
  private static readonly SESSION_TTL_MS = 30 * 60 * 1000; // 30分钟会话超时，避免隔天回复数字误转存
  private searchSessions: Map<string, SearchSession> = new Map();
  private hotSessions: Map<string, HotSession> = new Map();
  private lastActiveSessionType: Map<string, 'search' | 'hot'> = new Map();
  private lastMentionedTitles: Map<string, { title: string; updatedAt: number }> = new Map();
  private pendingImageSearches: Map<string, PendingImageSearch> = new Map();
  private recentSavedSessions: Map<string, RecentSavedSession> = new Map();
  private netdiskListings: Map<string, NetdiskListingSession> = new Map();

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  private isExpired(updatedAt: number): boolean {
    return Date.now() - updatedAt > SessionManager.SESSION_TTL_MS;
  }

  private setBounded<T>(map: Map<string, T>, key: string, value: T, limit: number = 300): void {
    if (!map.has(key) && map.size >= limit) {
      const oldestKey = map.keys().next().value;
      if (oldestKey) map.delete(oldestKey);
    }
    map.set(key, value);
  }

  setSearch(userId: string, keyword: string, items: CloudResource[], pageSize: number = 20): SearchSession {
    const session: SearchSession = {
      keyword,
      items,
      page: 1,
      pageSize,
      updatedAt: Date.now(),
    };
    this.setBounded(this.searchSessions, userId, session);
    this.setBounded(this.lastActiveSessionType, userId, 'search');
    return session;
  }

  getSearch(userId: string): SearchSession | undefined {
    const sess = this.searchSessions.get(userId);
    if (!sess) return undefined;
    if (this.isExpired(sess.updatedAt)) {
      this.searchSessions.delete(userId);
      if (this.lastActiveSessionType.get(userId) === 'search') {
        this.lastActiveSessionType.delete(userId);
      }
      return undefined;
    }
    return sess;
  }

  setHot(
    userId: string,
    type: 'movie' | 'tv',
    items: DoubanSubject[],
    tag: string = '热门',
    page: number = 1,
    pageSize: number = 10,
    query?: string,
    extra?: {
      mode?: 'recommend' | 'chart';
      chartHeading?: string;
      showWishOrDate?: boolean;
      chartHint?: string;
    }
  ): HotSession {
    const session: HotSession = {
      type,
      tag,
      query,
      items,
      page,
      pageSize,
      updatedAt: Date.now(),
      mode: extra?.mode || 'recommend',
      chartHeading: extra?.chartHeading,
      showWishOrDate: extra?.showWishOrDate,
      chartHint: extra?.chartHint,
    };
    this.setBounded(this.hotSessions, userId, session);
    this.setBounded(this.lastActiveSessionType, userId, 'hot');
    return session;
  }

  /**
   * 获取指定页码的热门/豆瓣榜单列表切片（用于「还有吗 / 下一页」本地真分页）
   */
  getHotPage(userId: string, targetPage?: number): {
    items: DoubanSubject[];
    page: number;
    pageSize: number;
    totalPages: number;
    startIdx: number;
    total: number;
    session: HotSession;
  } | null {
    const session = this.getHot(userId);
    if (!session || session.items.length === 0) return null;

    const total = session.items.length;
    const pageSize = Math.max(1, session.pageSize || 10);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    let page = targetPage !== undefined ? targetPage : session.page || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    session.page = page;
    session.updatedAt = Date.now();

    const startIdx = (page - 1) * pageSize;
    return {
      items: session.items.slice(startIdx, startIdx + pageSize),
      page,
      pageSize,
      totalPages,
      startIdx,
      total,
      session,
    };
  }

  getHot(userId: string): HotSession | undefined {
    const sess = this.hotSessions.get(userId);
    if (!sess) return undefined;
    if (this.isExpired(sess.updatedAt)) {
      this.hotSessions.delete(userId);
      if (this.lastActiveSessionType.get(userId) === 'hot') {
        this.lastActiveSessionType.delete(userId);
      }
      return undefined;
    }
    return sess;
  }

  getLastActiveType(userId: string): 'search' | 'hot' | null {
    const active = this.lastActiveSessionType.get(userId) || null;
    if (active === 'search' && !this.getSearch(userId)) {
      return this.getHot(userId) ? 'hot' : null;
    }
    if (active === 'hot' && !this.getHot(userId)) {
      return this.getSearch(userId) ? 'search' : null;
    }
    return active;
  }

  /**
   * 记录最近一次对话中提及或推荐的具体影视片名（供“半小时后转存到网盘”等延时操作提取上下文）
   */
  setLastMentionedTitle(userId: string, title: string): void {
    const clean = title.replace(/[《》\s]/g, '').trim();
    if (!clean) return;
    this.setBounded(this.lastMentionedTitles, userId, {
      title: title.replace(/[《》]/g, '').trim(),
      updatedAt: Date.now(),
    });
  }

  /**
   * 获取用户最近一次交互中最相关的影视片名（按时间最新优先比较搜索、推荐与闲聊提及）
   */
  getRecentTargetTitle(userId: string): string | undefined {
    const candidates: Array<{ title: string; updatedAt: number }> = [];
    const searchSess = this.getSearch(userId);
    if (searchSess?.keyword) {
      candidates.push({ title: searchSess.keyword, updatedAt: searchSess.updatedAt });
    }
    const hotSess = this.getHot(userId);
    if (hotSess?.items && hotSess.items.length > 0) {
      candidates.push({ title: hotSess.items[0].title, updatedAt: hotSess.updatedAt });
    }
    const mentioned = this.lastMentionedTitles.get(userId);
    if (mentioned?.title && !this.isExpired(mentioned.updatedAt)) {
      candidates.push(mentioned);
    }
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    return candidates[0].title;
  }

  setPendingImageSearch(userId: string, info: Omit<PendingImageSearch, 'updatedAt'>): PendingImageSearch {
    const entry: PendingImageSearch = {
      ...info,
      updatedAt: Date.now(),
    };
    this.setBounded(this.pendingImageSearches, userId, entry);
    return entry;
  }

  getPendingImageSearch(userId: string): PendingImageSearch | undefined {
    const entry = this.pendingImageSearches.get(userId);
    if (!entry) return undefined;
    if (this.isExpired(entry.updatedAt)) {
      this.pendingImageSearches.delete(userId);
      return undefined;
    }
    return entry;
  }

  clearPendingImageSearch(userId: string): void {
    this.pendingImageSearches.delete(userId);
  }

  /**
   * 记录最近一次成功转存到网盘的资源与文件类型详情（供“解压刚转存的 / 删掉刚存的 / 重命名刚存的”直接衔接）
   */
  setRecentSaved(userId: string, info: Omit<RecentSavedSession, 'savedAt'>): RecentSavedSession {
    const entry: RecentSavedSession = {
      ...info,
      savedAt: Date.now(),
    };
    this.setBounded(this.recentSavedSessions, userId, entry);
    if (info.allInspectedItems.length > 0 || info.topItems.length > 0) {
      const listingItems = info.allInspectedItems.length > 0 ? info.allInspectedItems : info.topItems;
      this.setNetdiskListing(userId, {
        source: 'recent_saved',
        pathOrQuery: info.targetPath,
        dirFid: info.targetDirFid,
        items: listingItems,
      });
    }
    return entry;
  }

  getRecentSaved(userId: string): RecentSavedSession | undefined {
    const entry = this.recentSavedSessions.get(userId);
    if (!entry) return undefined;
    // 转存记录保留 2 小时，方便用户稍后再让 AI 解压或管理刚存的文件
    if (Date.now() - entry.savedAt > 2 * 60 * 60 * 1000) {
      this.recentSavedSessions.delete(userId);
      return undefined;
    }
    return entry;
  }

  clearAwaitingUnarchive(userId: string): void {
    const entry = this.recentSavedSessions.get(userId);
    if (entry) {
      entry.awaitingUnarchiveConfirm = false;
    }
  }

  /**
   * 记录最近一次展示给用户的网盘文件列表（供“把第2个删了 / 解压第1个 / 重命名第3个”按序号精准操作）
   */
  setNetdiskListing(userId: string, info: Omit<NetdiskListingSession, 'updatedAt'>): NetdiskListingSession {
    const entry: NetdiskListingSession = {
      ...info,
      updatedAt: Date.now(),
    };
    this.setBounded(this.netdiskListings, userId, entry);
    return entry;
  }

  getNetdiskListing(userId: string): NetdiskListingSession | undefined {
    const entry = this.netdiskListings.get(userId);
    if (!entry) return undefined;
    if (this.isExpired(entry.updatedAt)) {
      this.netdiskListings.delete(userId);
      return undefined;
    }
    return entry;
  }

  /**
   * 获取指定页码的搜索结果
   */
  getSearchPage(userId: string, targetPage?: number): {
    items: CloudResource[];
    page: number;
    pageSize: number;
    totalPages: number;
    startIdx: number;
    total: number;
    keyword: string;
  } | null {
    const session = this.searchSessions.get(userId);
    if (!session || session.items.length === 0) return null;

    const total = session.items.length;
    const totalPages = Math.max(1, Math.ceil(total / session.pageSize));
    let page = targetPage !== undefined ? targetPage : session.page;

    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    session.page = page;

    const startIdx = (page - 1) * session.pageSize;
    const items = session.items.slice(startIdx, startIdx + session.pageSize);

    return {
      items,
      page,
      pageSize: session.pageSize,
      totalPages,
      startIdx,
      total,
      keyword: session.keyword,
    };
  }

  /**
   * 清除用户当前的找片与热门会话状态
   */
  clearSession(userId: string): void {
    this.searchSessions.delete(userId);
    this.hotSessions.delete(userId);
    this.lastActiveSessionType.delete(userId);
  }

  /**
   * 判断是否为退出或取消指令
   */
  static isCancelCommand(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    return [
      '取消',
      '退出',
      '算了',
      '不要了',
      '不用了',
      '不存了',
      '不选了',
      '撤销',
      '返回',
      '关闭',
      '/cancel',
      '/quit',
      '/exit',
      'cancel',
      'quit',
      'exit',
    ].includes(trimmed);
  }

  /**
   * 解析数字/序号选择（同时区分“当前页/本页相对序号”与“列表全局序号”）
   * 支持: "第2个", "我要第2个", "本页第1个", "当前第2个", "这页1", "2", "第二个"
   */
  static parseSelection(text: string): { index: number; isPageRelative: boolean } | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // 中文数字转换
    const cnMap: { [key: string]: number } = {
      '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
    };

    if (
      ['转存', '存', '就要这部', '就要这个', '看这部', '就看这个', '就这部', '存这部', '存这个', '要这部'].includes(
        trimmed
      )
    ) {
      return { index: 1, isPageRelative: true };
    }

    const relMatch = trimmed.match(
      /^(?:我要|我要存|帮我存|存|选|要|保存|查看|看|转存)?\s*(?:本页|当前页|当前|这一页|这页|当页)(?:的)?\s*(?:第)?\s*([0-9]{1,3}|[一二两三四五六七八九十])\s*(?:个|条|部|集)?$/
    );
    if (relMatch && relMatch[1]) {
      const val = relMatch[1];
      const idx = /^[0-9]+$/.test(val) ? parseInt(val, 10) : cnMap[val];
      if (idx) return { index: idx, isPageRelative: true };
    }

    const match = trimmed.match(
      /^(?:我要|我要存|帮我存|存|选|要|保存|查看|看|转存)?\s*(?:第)?\s*([0-9]{1,3}|[一二两三四五六七八九十])\s*(?:个|条|部|集)?$/
    );

    if (match && match[1]) {
      const val = match[1];
      if (/^[0-9]+$/.test(val)) {
        return { index: parseInt(val, 10), isPageRelative: false };
      }
      if (cnMap[val]) {
        return { index: cnMap[val], isPageRelative: false };
      }
    }
    return null;
  }

  /**
   * 解析数字/序号选择
   * 支持: "第2个", "我要第2个", "存第2个", "2", "第二个", "选2", "看第1个"
   */
  static parseNumberSelection(text: string): number | null {
    return SessionManager.parseSelection(text)?.index ?? null;
  }

  /**
   * 解析翻页或换一批指令
   * 支持: "下一页", "下页", "上一页", "上页", "第2页", "换一批", "换一组", "再来一批", "下一批", "换换", "换一部"
   */
  static parsePagination(text: string): { action: 'next' | 'prev' | 'goto' | 'refresh'; page?: number } | null {
    const trimmed = text.trim();
    const cleanQ = trimmed.replace(/[?？!！。.~～]+$/g, '').trim();
    if (
      [
        '下一页',
        '下页',
        '后一页',
        'next',
        '还有吗',
        '还有嘛',
        '还有没有',
        '还有别的吗',
        '还有其他吗',
        '还有啥',
        '后面呢',
        '后面的',
        '接着看',
        '还有',
        '更多',
      ].includes(cleanQ.toLowerCase())
    ) {
      return { action: 'next' };
    }
    if (['上一页', '上页', '前一页', 'prev'].includes(trimmed.toLowerCase())) {
      return { action: 'prev' };
    }
    if (
      [
        '换一批',
        '换一组',
        '再换一批',
        '下一批',
        '再来一批',
        '换换',
        '换几个',
        '换点别的',
        '换别的',
        '换一部',
        '换一个',
        '再换一部',
        '再来一部',
        '换部别的',
      ].includes(trimmed)
    ) {
      return { action: 'refresh' };
    }
    const pageMatch = trimmed.match(/^第\s*([0-9]+)\s*页$/);
    if (pageMatch && pageMatch[1]) {
      return { action: 'goto', page: parseInt(pageMatch[1], 10) };
    }
    return null;
  }
}
