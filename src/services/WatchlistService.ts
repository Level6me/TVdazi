import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * 跨平台片单解析与导入助手：
 * 支持：
 * 1. 豆瓣片单 / 豆列 / 电影想看页面 URL 提取片名
 * 2. 小红书 / 朋友圈 / 影评文章含《片名》的批量提取
 * 3. 逗号、顿号、换行分隔的多部剧名清单
 */
export class WatchlistService {
  /**
   * 从自由文本或分段清单中抽取规范影视名称
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

    // 1. 优先提取《片名》格式（适配小红书/公众号推荐文案）
    const bookMatches = text.match(/《([^》\n]{1,40})》/g);
    if (bookMatches && bookMatches.length > 0) {
      for (const m of bookMatches) {
        pushTitle(m);
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
  static async extractFromDoubanUrl(url: string): Promise<string[]> {
    try {
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
    const trimmed = (input || '').trim();
    const urlMatch = trimmed.match(/https?:\/\/(?:www\.|movie\.)?douban\.com\/[^\s]+/i);
    if (urlMatch) {
      const fromUrl = await this.extractFromDoubanUrl(urlMatch[0]);
      if (fromUrl.length > 0) return fromUrl;
    }
    return this.extractTitlesFromText(trimmed);
  }
}
