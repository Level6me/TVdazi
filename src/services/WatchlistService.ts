import axios from 'axios';
import * as cheerio from 'cheerio';
import { DoubanService } from './DoubanService';
import { MetadataResolver } from './MetadataResolver';
import { QuarkService } from './QuarkService';
import { UserManager, WatchlistItem } from './UserManager';
import { UserProfileService } from './UserProfileService';

export interface WatchlistPick {
  item: WatchlistItem;
  score: number;
  reasons: string[];
}

/**
 * 跨平台片单解析、豆瓣补全、画像抽签、网盘对账与导出服务
 */
export class WatchlistService {
  /**
   * 从自由文本或分段清单中抽取规范影视名称（兼容混合《片名》与清单行）
   */
  static extractTitlesFromText(rawText: string): string[] {
    const text = (rawText || '').trim();
    if (!text) return [];

    const titles: string[] = [];
    const seen = new Set<string>();
    const pushTitle = (t: string) => {
      const clean = t
        .replace(/^[0-9]+[.、)\s]+/, '')
        .replace(/[《》「」『』""''\[\]【】]/g, '')
        .replace(/\(\s*\d{4}\s*\)$/, '')
        .trim();
      if (!clean || clean.length < 1 || clean.length > 45) return;
      if (/^https?:\/\//i.test(clean)) return;
      const key = clean.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        titles.push(clean);
      }
    };

    // 1. 提取所有《片名》
    const bookMatches = text.match(/《([^》\n]{1,40})》/g);
    if (bookMatches && bookMatches.length > 0) {
      for (const m of bookMatches) {
        pushTitle(m);
      }
      // 同步扫描其余独立短行（如序号列表或纯片名换行），排除散文长句
      const residualLines = text
        .replace(/《[^》\n]{1,40}》/g, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of residualLines) {
        if (/^[0-9]+[.、)\s]+[^\s，。！？；：]+/.test(line) && !/[。！？，]/.test(line)) {
          pushTitle(line);
        } else if (line.length <= 24 && !/[，。！？；：]/.test(line) && !/^https?:\/\//i.test(line)) {
          pushTitle(line);
        }
      }
      if (titles.length > 0) return titles;
    }

    // 2. 按换行、逗号、顿号拆分
    const lines = text
      .split(/[\r\n,，、;；]+/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      pushTitle(line);
    }
    return titles;
  }

  /**
   * 尝试抓取豆瓣片单/豆列 URL 中的影视名称列表
   */
  static async extractFromDoubanUrl(rawUrl: string): Promise<string[]> {
    try {
      const url = rawUrl
        .replace('https://m.douban.com/movie/doulist/', 'https://www.douban.com/doulist/')
        .replace('http://', 'https://');
      const resp = await axios.get(url, {
        timeout: 8000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });
      const $ = cheerio.load(resp.data);
      const titles: string[] = [];
      const seen = new Set<string>();

      const selectors = [
        '.doulist-item .title a',
        '.subject-item .info h2 a',
        '.grid-view .item .title a',
        'li.title a',
      ];

      for (const sel of selectors) {
        $(sel).each((_, el) => {
          const raw = $(el).text().trim().split('/')[0].trim();
          const clean = raw.replace(/\(\d{4}\)$/, '').trim();
          if (clean && !seen.has(clean.toLowerCase())) {
            seen.add(clean.toLowerCase());
            titles.push(clean);
          }
        });
      }
      return titles.slice(0, 50);
    } catch {
      return [];
    }
  }

  /**
   * 统一入口：支持 URL 或纯文本混合导入
   */
  static async parseBatchInput(input: string): Promise<string[]> {
    const { titles } = await this.parseBatchInputWithMeta(input);
    return titles;
  }

  static async parseBatchInputWithMeta(input: string): Promise<{
    titles: string[];
    source: 'douban_url' | 'text';
    notice?: string;
  }> {
    const trimmed = (input || '').trim();
    const urlMatch = trimmed.match(/https?:\/\/(?:www\.|movie\.|m\.)?douban\.com\/[^\s]+/i);
    if (urlMatch) {
      const fromUrl = await this.extractFromDoubanUrl(urlMatch[0]);
      if (fromUrl.length > 0) {
        return { titles: fromUrl, source: 'douban_url' };
      }
      const fallbackText = this.extractTitlesFromText(trimmed.replace(urlMatch[0], ''));
      if (fallbackText.length > 0) {
        return { titles: fallbackText, source: 'text' };
      }
      return {
        titles: [],
        source: 'douban_url',
        notice: '豆瓣链接未提取到片单（可能为私密豆列或触发反爬），建议复制片单文字或含《片名》的内容直接粘贴导入。',
      };
    }
    return { titles: this.extractTitlesFromText(trimmed), source: 'text' };
  }

  /**
   * 为片单条目补全豆瓣评分、年份、地区、题材、总集数与海报
   */
  static async enrichWatchlistItem(userId: string, title: string): Promise<WatchlistItem | null> {
    const cleanTitle = title.replace(/[《》]/g, '').trim();
    if (!cleanTitle) return null;

    const douban = new DoubanService();
    const userManager = UserManager.getInstance();
    const { title: queryTitle, year: extractedYear } = MetadataResolver.extractMediaQuery(cleanTitle);
    const lookupTitle = queryTitle || cleanTitle;

    try {
      const [subSettled, coverSettled] = await Promise.allSettled([
        Promise.race([
          douban.searchAndEnrichSubjectByTitle(lookupTitle),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
        ]),
        Promise.race([
          MetadataResolver.getInstance().resolveCoverUrl(lookupTitle, {
            year: extractedYear,
            userId,
          }),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3500)),
        ]),
      ]);

      const sub = subSettled.status === 'fulfilled' ? subSettled.value : null;
      const fallbackCover = coverSettled.status === 'fulfilled' ? coverSettled.value : undefined;
      const coverUrl = (sub?.cover || '').trim() || fallbackCover || undefined;

      if (!sub && !coverUrl) return null;

      const epNum = sub?.episodesCount ? parseInt(String(sub.episodesCount), 10) : NaN;
      const totalEpisodes = Number.isFinite(epNum) && epNum > 0 ? epNum : undefined;
      const inferredMedia = sub ? UserProfileService.getInstance().inferSubjectMediaTypes(sub) : [];
      const primaryCategory = inferredMedia[0] || undefined;

      return userManager.updateWatchlistItem(userId, cleanTitle, {
        rating: sub?.rate || undefined,
        year: sub?.year || extractedYear || undefined,
        region: sub?.region || undefined,
        genres: sub?.types && sub.types.length > 0 ? sub.types.slice(0, 4) : undefined,
        totalEpisodes,
        cover: coverUrl,
        doubanId: sub?.id || undefined,
        ...(sub
          ? {
              type: totalEpisodes || (primaryCategory && /剧|动画|综艺|纪录片/.test(primaryCategory)) ? 'tv' : 'movie',
            }
          : {}),
        ...(primaryCategory ? { category: primaryCategory } : {}),
      });
    } catch {
      return null;
    }
  }

  /**
   * 批量补全尚未拉取豆瓣元数据或封面的片单条目（并发处理，最多 maxItems 条）
   */
  static async enrichPendingItems(userId: string, maxItems: number = 8): Promise<number> {
    const plan = UserManager.getInstance().getUserPlan(userId);
    const pending = plan.watchlist
      .filter((w) => (!w.rating && !w.doubanId && !w.year) || !w.cover)
      .slice(0, maxItems);
    if (pending.length === 0) return 0;

    let updated = 0;
    const batchSize = 4;
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((item) => this.enrichWatchlistItem(userId, item.title))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) updated += 1;
      }
    }
    return updated;
  }

  /**
   * 结合用户观影画像 + 豆瓣评分 + 云盘状态，智能抽取最适合当下观看的作品
   */
  static pickFromWatchlist(userId: string, count: number = 3): WatchlistPick[] {
    const plan = UserManager.getInstance().getUserPlan(userId);
    const list = plan.watchlist || [];
    if (list.length === 0) return [];

    const pool = list.filter((w) => w.status !== 'completed');
    const candidates = pool.length > 0 ? pool : list;
    const profileSvc = UserProfileService.getInstance();

    const scored: WatchlistPick[] = candidates.map((item) => {
      const profileScore = profileSvc.scoreCandidate(userId, {
        id: item.doubanId || item.title,
        title: item.title,
        rate: item.rating || '',
        year: item.year,
        region: item.region,
        types: item.genres && item.genres.length > 0 ? item.genres : item.category ? [item.category] : [],
        episodesCount: item.totalEpisodes ? String(item.totalEpisodes) : undefined,
        cover: item.cover || '',
        url: '',
      });

      const baseProfile = profileScore === -Infinity ? -100 : profileScore;
      const rateNum = parseFloat(item.rating || '') || 0;
      const rateBonus = rateNum > 0 ? rateNum * 1.4 : 0;
      const cloudBonus = item.inCloudDisk ? 3.5 : 0;
      const progressBonus = item.status === 'saving' || (item.currentEpisode || 0) > 0 ? 2.5 : 0;
      // 轻微随机扰动（0~1.2），避免每次抽签完全固定在同一部
      const jitter = Math.random() * 1.2;

      const reasons: string[] = [];
      if (profileScore > 1 && profileScore !== -Infinity) reasons.push('契合你的观影画像');
      if (rateNum >= 7.5) reasons.push(`豆瓣 ${rateNum.toFixed(1)} 分`);
      if (item.inCloudDisk) reasons.push('网盘已备好');
      if (item.currentEpisode && item.currentEpisode > 0) {
        reasons.push(`在追至第 ${item.currentEpisode} 集`);
      }
      if (reasons.length === 0) reasons.push(item.category || '待看清单精选');

      return {
        item,
        score: Number((baseProfile + rateBonus + cloudBonus + progressBonus + jitter).toFixed(2)),
        reasons,
      };
    });

    return scored
      .filter((s) => s.score > -50)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, count));
  }

  /**
   * 扫描用户夸克网盘根目录并标记片单中已入库的作品
   */
  static async syncWithCloudDisk(userId: string): Promise<{
    configured: boolean;
    checkedFolders: number;
    matchedTitles: string[];
  }> {
    const userManager = UserManager.getInstance();
    const plan = userManager.getUserPlan(userId);
    const quark = new QuarkService();
    if (!quark.isConfigured(plan.quarkCookie)) {
      return { configured: false, checkedFolders: 0, matchedTitles: [] };
    }

    const baseDir = plan.saveRootDir || quark.getDefaultRootDir();
    const rootFid = await quark.resolveExistingPathFid(baseDir, plan.quarkCookie);
    if (!rootFid) {
      return { configured: true, checkedFolders: 0, matchedTitles: [] };
    }

    const normalize = (s: string) =>
      String(s || '')
        .replace(/[《》()（）\[\]【】\s·:：,，.。!\-_]/g, '')
        .replace(/(?:19|20)\d{2}/g, '')
        .toLowerCase();

    const cloudEntries: Array<{ normName: string; fullPath: string }> = [];
    let checkedFolders = 0;

    const topNodes = await quark.listFilesInFolder(rootFid, plan.quarkCookie, 100);
    checkedFolders += 1;
    for (const node of topNodes) {
      cloudEntries.push({
        normName: normalize(node.file_name),
        fullPath: `${baseDir.replace(/\/+$/, '')}/${node.file_name}`,
      });
    }

    const catFolders = topNodes.filter((n) => n.dir).slice(0, 12);
    for (const cat of catFolders) {
      const subNodes = await quark.listFilesInFolder(cat.fid, plan.quarkCookie, 100);
      checkedFolders += 1;
      for (const sub of subNodes) {
        cloudEntries.push({
          normName: normalize(sub.file_name),
          fullPath: `${baseDir.replace(/\/+$/, '')}/${cat.file_name}/${sub.file_name}`,
        });
      }
    }

    const matchedTitles: string[] = [];
    for (const item of plan.watchlist) {
      const normTitle = normalize(item.title);
      if (normTitle.length < 2) continue;
      const hit = cloudEntries.find(
        (e) => e.normName === normTitle || e.normName.includes(normTitle) || normTitle.includes(e.normName)
      );
      if (hit) {
        userManager.updateWatchlistItem(userId, item.title, {
          inCloudDisk: true,
          cloudPath: hit.fullPath,
        });
        matchedTitles.push(item.title);
      }
    }

    return { configured: true, checkedFolders, matchedTitles };
  }

  /**
   * 导出结构化 Markdown 片单清单
   */
  static exportMarkdown(userId: string): string {
    const plan = UserManager.getInstance().getUserPlan(userId);
    const list = plan.watchlist || [];
    if (list.length === 0) {
      return '# 我的追剧片单\n\n暂无片单记录。';
    }

    const formatRow = (w: WatchlistItem) => {
      const tags: string[] = [];
      if (w.category) tags.push(w.category);
      if (w.rating) tags.push(`豆瓣 ${w.rating}`);
      if (w.year) tags.push(w.year);
      if (w.currentEpisode && w.currentEpisode > 0) {
        tags.push(w.totalEpisodes ? `看到第 ${w.currentEpisode}/${w.totalEpisodes} 集` : `看到第 ${w.currentEpisode} 集`);
      }
      if (w.inCloudDisk) tags.push('☁️ 网盘已有');
      const suffix = tags.length > 0 ? `（${tags.join(' · ')}）` : '';
      const note = w.note ? ` - 备注：${w.note}` : '';
      return `- 《${w.title}》${suffix}${note}`;
    };

    const saving = list.filter((w) => w.status === 'saving');
    const planned = list.filter((w) => w.status === 'planned');
    const completed = list.filter((w) => w.status === 'completed');

    const sections: string[] = [`# 电视搭子片单清单（共 ${list.length} 部）`];
    if (saving.length > 0) {
      sections.push(`\n## 🔥 在追中 (${saving.length})\n${saving.map(formatRow).join('\n')}`);
    }
    if (planned.length > 0) {
      sections.push(`\n## ⏳ 想看清单 (${planned.length})\n${planned.map(formatRow).join('\n')}`);
    }
    if (completed.length > 0) {
      sections.push(`\n## ✅ 已看 / 已存 (${completed.length})\n${completed.map(formatRow).join('\n')}`);
    }
    return sections.join('\n');
  }
}
