import { CloudResource } from '../types';
import { DoubanSubject } from './DoubanService';

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
}

export class SessionManager {
  private static instance: SessionManager;
  private searchSessions: Map<string, SearchSession> = new Map();
  private hotSessions: Map<string, HotSession> = new Map();
  private lastActiveSessionType: Map<string, 'search' | 'hot'> = new Map();

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  setSearch(userId: string, keyword: string, items: CloudResource[], pageSize: number = 20): SearchSession {
    const session: SearchSession = {
      keyword,
      items,
      page: 1,
      pageSize,
      updatedAt: Date.now(),
    };
    this.searchSessions.set(userId, session);
    this.lastActiveSessionType.set(userId, 'search');
    return session;
  }

  getSearch(userId: string): SearchSession | undefined {
    return this.searchSessions.get(userId);
  }

  setHot(
    userId: string,
    type: 'movie' | 'tv',
    items: DoubanSubject[],
    tag: string = '热门',
    page: number = 1,
    pageSize: number = 10,
    query?: string
  ): HotSession {
    const session: HotSession = {
      type,
      tag,
      query,
      items,
      page,
      pageSize,
      updatedAt: Date.now(),
    };
    this.hotSessions.set(userId, session);
    this.lastActiveSessionType.set(userId, 'hot');
    return session;
  }

  getHot(userId: string): HotSession | undefined {
    return this.hotSessions.get(userId);
  }

  getLastActiveType(userId: string): 'search' | 'hot' | null {
    return this.lastActiveSessionType.get(userId) || null;
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
   * 解析数字/序号选择
   * 支持: "第2个", "我要第2个", "存第2个", "2", "第二个", "选2", "看第1个"
   */
  static parseNumberSelection(text: string): number | null {
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
      return 1;
    }

    const match = trimmed.match(
      /^(?:我要|我要存|帮我存|存|选|要|保存|查看|看|转存)?\s*(?:第)?\s*([0-9]{1,3}|[一二两三四五六七八九十])\s*(?:个|条|部|集)?$/
    );

    if (match && match[1]) {
      const val = match[1];
      if (/^[0-9]+$/.test(val)) {
        return parseInt(val, 10);
      }
      if (cnMap[val]) {
        return cnMap[val];
      }
    }
    return null;
  }

  /**
   * 解析翻页或换一批指令
   * 支持: "下一页", "下页", "上一页", "上页", "第2页", "换一批", "换一组", "再来一批", "下一批", "换换", "换一部"
   */
  static parsePagination(text: string): { action: 'next' | 'prev' | 'goto' | 'refresh'; page?: number } | null {
    const trimmed = text.trim();
    if (['下一页', '下页', '后一页', 'next'].includes(trimmed.toLowerCase())) {
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
