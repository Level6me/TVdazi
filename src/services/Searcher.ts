import axios from 'axios';
import * as cheerio from 'cheerio';
import { CloudResource, SearchOptions, SearchResult } from '../types';
import { ChannelManager } from './ChannelManager';
import { CategoryClassifier } from './CategoryClassifier';

export class ResourceSearcher {
  private explicitChannels?: string[];
  private channelManager: ChannelManager;

  constructor(channels?: string[]) {
    this.explicitChannels = channels;
    this.channelManager = new ChannelManager();
  }

  private getActiveChannels(): string[] {
    if (this.explicitChannels && this.explicitChannels.length > 0) {
      return this.explicitChannels;
    }
    const channels = this.channelManager.loadChannels().map((c) => c.id);
    return channels.length > 0 ? channels : ['Quark_Movies', 'shareAliyun', 'PanjClub', 'guaguale115', 'hao115'];
  }

  /**
   * 提炼精简纯净的标题，去除冗余描述、长文、链接与无关字符
   */
  private cleanRawTitle(rawTitle: string, keyword: string): string {
    let clean = rawTitle.trim();
    clean = clean.split(/(?:描述|简介|链接|夸克|迅雷|阿里|网盘)[：:]/)[0].trim();
    clean = clean.split('\n')[0].trim();
    clean = clean.replace(/^(?:名称|片名|标题)[：:]\s*/, '').trim();
    clean = clean.replace(/#[a-zA-Z0-9_\u4e00-\u9fa5]+/g, '').trim();
    if (clean.length > 50) {
      clean = clean.slice(0, 50).trim() + '...';
    }
    return clean || keyword;
  }

  /**
   * 计算匹配相关度得分：
   * 标题完全包含关键词 > 帖子正文包含关键词 > 模糊匹配
   */
  private calculateScore(
    item: CloudResource,
    keyword: string,
    preferredQuality?: string,
    aliasKeywords?: string[]
  ): number {
    const kw = keyword.toLowerCase().trim();
    const title = (item.title || '').toLowerCase();
    const raw = (item.rawText || '').toLowerCase();
    const full = `${title} ${raw}`;

    let score = 0;

    // 1. 标题完全包含完整关键词（最优先）
    if (kw && title.includes(kw)) {
      score += 1000;
      score += Math.max(0, 100 - title.length);
    } else if (aliasKeywords && aliasKeywords.length > 0) {
      const matchedAlias = aliasKeywords.find((a) => {
        const ak = a.toLowerCase().trim();
        return ak.length >= 2 && title.includes(ak);
      });
      if (matchedAlias) {
        score += 750;
        score += Math.max(0, 80 - title.length);
      }
    }

    // 2. 帖子正文前 100 字符内包含完整关键词或别名
    if (kw && raw.slice(0, 100).includes(kw)) {
      score += 300;
    } else if (kw && raw.includes(kw)) {
      score += 100;
    } else if (aliasKeywords && aliasKeywords.some((a) => a.trim().length >= 2 && raw.slice(0, 100).includes(a.toLowerCase().trim()))) {
      score += 200;
    } else if (aliasKeywords && aliasKeywords.some((a) => a.trim().length >= 2 && raw.includes(a.toLowerCase().trim()))) {
      score += 70;
    }

    // 3. 夸克网盘优先加分（支持一键转存）
    if (item.panType === 'quark') {
      score += 50;
    }

    // 4. 画质标签加分与用户专属画质偏好加权
    if (title.includes('4k') || raw.includes('4k') || full.includes('2160p')) score += 20;
    if (title.includes('remux') || raw.includes('remux') || full.includes('原盘') || full.includes('蓝光')) score += 15;
    if (title.includes('1080p') || raw.includes('1080p')) score += 10;

    const pref = (preferredQuality || '').toUpperCase();
    if (pref === '4K' && /(?:4k|2160p|uhd|杜比|dolby|hdr)/i.test(full)) {
      score += 80;
    } else if (pref === '原盘' && /(?:remux|原盘|bluray|蓝光|iso)/i.test(full)) {
      score += 80;
    } else if (pref === '1080P' && /(?:1080p|1080i|高码)/i.test(full)) {
      score += 80;
    }

    return score;
  }

  /**
   * 归一化文本用于相关性校验（去除书名号、标点符号与空白）
   */
  private normalizeForMatch(str: string): string {
    return (str || '')
      .toLowerCase()
      .replace(/[《》〈〉「」『』【】\[\]()（）:：·.,，。！!？?、\s\-_\/\\]/g, '');
  }

  private isSingleTermRelevant(hayNorm: string, term: string): boolean {
    const kwNorm = this.normalizeForMatch(term);
    if (!kwNorm || kwNorm.length < 2) return false;

    if (hayNorm.includes(kwNorm)) {
      return true;
    }

    const tokens = term
      .toLowerCase()
      .split(/\s+/)
      .map((t) => this.normalizeForMatch(t))
      .filter((t) => t.length >= 2);
    if (tokens.length > 1 && tokens.every((t) => hayNorm.includes(t))) {
      return true;
    }

    const coreKw = kwNorm
      .replace(/(?:第[一二三四五六七八九十\d]+[季部]|season\d+|s\d+|4k|2160p|1080p|国语|中字|完结|全集|电影|电视剧|网剧|动漫)+$/g, '')
      .trim();
    if (coreKw.length >= 2 && hayNorm.includes(coreKw)) {
      return true;
    }

    return false;
  }

  /**
   * 判断检索到的网盘资源是否与搜索词或其跨语种别名真实相关
   */
  private isRelevantItem(item: CloudResource, keyword: string, aliasKeywords?: string[]): boolean {
    if (!this.normalizeForMatch(keyword)) return true;

    const hayRaw = `${item.title || ''} ${item.rawText || ''}`.toLowerCase();
    const hayNorm = this.normalizeForMatch(hayRaw);

    if (this.isSingleTermRelevant(hayNorm, keyword)) {
      return true;
    }

    if (aliasKeywords && aliasKeywords.length > 0) {
      for (const alias of aliasKeywords) {
        if (this.isSingleTermRelevant(hayNorm, alias)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 合并多标题/多别名检索结果，按 shareUrl 去重并重新按主片名优先评分排序
   */
  public mergeResults(
    base: SearchResult,
    extras: SearchResult[],
    primaryKeyword: string,
    preferredQuality?: string,
    aliasKeywords?: string[],
    maxResults: number = 60
  ): SearchResult {
    const seen = new Set<string>();
    const merged: CloudResource[] = [];

    for (const batch of [base, ...extras]) {
      for (const item of batch.items || []) {
        if (!item.shareUrl || seen.has(item.shareUrl)) continue;
        seen.add(item.shareUrl);
        merged.push(item);
      }
    }

    merged.sort((a, b) => {
      const scoreA = this.calculateScore(a, primaryKeyword, preferredQuality, aliasKeywords);
      const scoreB = this.calculateScore(b, primaryKeyword, preferredQuality, aliasKeywords);
      return scoreB - scoreA;
    });

    const totalDuration = [base, ...extras].reduce((acc, r) => acc + (r.durationMs || 0), 0);
    return {
      keyword: primaryKeyword,
      items: merged.slice(0, maxResults),
      totalFound: merged.length,
      durationMs: totalDuration,
    };
  }

  /**
   * 搜索公开频道影视/网盘资源
   */
  async search(options: SearchOptions): Promise<SearchResult> {
    const startTime = Date.now();
    const keyword = options.keyword.trim();
    if (!keyword) {
      return { keyword: '', items: [], totalFound: 0, durationMs: 0 };
    }
    const results: CloudResource[] = [];
    const seenUrls = new Set<string>();
    const channels = this.getActiveChannels();

    const fetchChannel = async (channel: string) => {
      try {
        const url = `https://t.me/s/${channel}?q=${encodeURIComponent(keyword)}`;
        const response = await axios.get(url, {
          timeout: 5500,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });

        const $ = cheerio.load(response.data);
        $('.tgme_widget_message_wrap').each((_, elem) => {
          const msgElem = $(elem).find('.tgme_widget_message_text');
          if (!msgElem.length) return;

          // 将 <br> 替换为换行符，防止 Cheerio .text() 抹除换行导致片名与简介粘连成一行
          msgElem.find('br').replaceWith('\n');

          // 提取 <a href="..."> 中的隐藏网盘超链接
          const hrefLinks: string[] = [];
          msgElem.find('a').each((__, aElem) => {
            const href = $(aElem).attr('href');
            if (href && /^https?:\/\//i.test(href)) {
              hrefLinks.push(href);
            }
          });

          const rawTextContent = msgElem.text().trim();
          const combinedText = hrefLinks.length > 0 ? `${rawTextContent}\n${hrefLinks.join('\n')}` : rawTextContent;
          if (!combinedText) return;

          let extractedTitle = keyword;
          const nameMatch = rawTextContent.match(/(?:名称|片名|剧名|标题|资源名称)[：:]\s*([^\n\r]+)/);
          if (nameMatch && nameMatch[1]) {
            extractedTitle = nameMatch[1].trim();
          } else {
            const lines = rawTextContent
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => l && !/^https?:\/\//i.test(l));
            extractedTitle = lines[0] ? lines[0].replace(/^(?:名称|片名|剧名|标题)[：:]\s*/, '').trim() : keyword;
          }

          const cleanTitle = this.cleanRawTitle(extractedTitle, keyword);
          const category = CategoryClassifier.classify(cleanTitle || keyword, rawTextContent);

          const addResource = (
            shareUrl: string,
            shareId: string,
            panType: CloudResource['panType'],
            passcode?: string
          ) => {
            if (!shareUrl || seenUrls.has(shareUrl)) return;
            seenUrls.add(shareUrl);
            results.push({
              title: cleanTitle || keyword,
              shareUrl,
              shareId,
              passcode: passcode || undefined,
              panType,
              category,
              rawText: rawTextContent.slice(0, 400),
              sourceChannel: channel,
            });
          };

          // 提取一条消息内的全部网盘链接（支持同帖多链接/多清晰度/多网盘共存）
          const quarkRegex = /https?:\/\/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)(?:\?(?:[^#\s"']*?\b)?pwd=([a-zA-Z0-9]{4}))?/gi;
          for (const m of combinedText.matchAll(quarkRegex)) {
            const shareId = m[1];
            const shareUrl = `https://pan.quark.cn/s/${shareId}`;
            const matchPos = m.index ?? 0;
            const nearbySlice = combinedText.slice(Math.max(0, matchPos - 20), Math.min(combinedText.length, matchPos + m[0].length + 45));
            const nearbyPassMatch = nearbySlice.match(/(?:提取码|密码|访问码|口令)[：:\s]*([a-zA-Z0-9]{4})\b/i);
            const fallbackPassMatch = !nearbyPassMatch
              ? combinedText.match(/(?:提取码|密码|访问码|口令)[：:\s]*([a-zA-Z0-9]{4})\b/i)
              : null;
            const passcode = m[2] || nearbyPassMatch?.[1] || fallbackPassMatch?.[1] || '';
            addResource(shareUrl, shareId, 'quark', passcode);
          }

          const otherPatterns: Array<{ regex: RegExp; panType: CloudResource['panType']; hasId: boolean }> = [
            { regex: /https?:\/\/(?:\w+\.)?(?:alipan|aliyundrive)\.com\/s\/([a-zA-Z0-9]+)/gi, panType: 'aliyun', hasId: true },
            { regex: /https?:\/\/drive\.uc\.cn\/s\/([a-zA-Z0-9]+)/gi, panType: 'uc', hasId: true },
            { regex: /https?:\/\/(?:115|anxia|115cdn)\.com\/s\/([a-zA-Z0-9]+)/gi, panType: '115', hasId: true },
            { regex: /https?:\/\/(?:www\.)?123[^\/\s<>"]+\.com\/s\/([a-zA-Z0-9]+)/gi, panType: 'other', hasId: true },
            { regex: /https?:\/\/cloud\.189\.cn\/[^\s<>"]+/gi, panType: 'other', hasId: false },
            { regex: /https?:\/\/(?:pan|yun)\.baidu\.com\/s\/[^\s<>"]+/gi, panType: 'other', hasId: false },
          ];

          for (const pat of otherPatterns) {
            for (const m of combinedText.matchAll(pat.regex)) {
              addResource(m[0], pat.hasId ? m[1] || '' : '', pat.panType);
            }
          }
        });
      } catch {
        // 静默异常
      }
    };

    // 分批并发控制（每批 15 个频道），并限制单次全网检索软超时上限（14秒）避免阻塞响应
    const CONCURRENCY = 15;
    const SEARCH_BUDGET_MS = 14000;
    for (let i = 0; i < channels.length; i += CONCURRENCY) {
      if (i > 0 && Date.now() - startTime >= SEARCH_BUDGET_MS) {
        break;
      }
      const batch = channels.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map((ch) => fetchChannel(ch)));
    }

    // 严格过滤掉与搜索词及其已知别名完全无关的频道干扰项
    const pool = results.filter((item) => this.isRelevantItem(item, keyword, options.aliasKeywords));

    pool.sort((a, b) => {
      const scoreA = this.calculateScore(a, keyword, options.quality, options.aliasKeywords);
      const scoreB = this.calculateScore(b, keyword, options.quality, options.aliasKeywords);
      return scoreB - scoreA;
    });

    const limit = options.maxResults || 60;
    const finalItems = pool.slice(0, limit);

    return {
      keyword,
      items: finalItems,
      totalFound: pool.length,
      durationMs: Date.now() - startTime,
    };
  }

  async verifyQuarkLink(pwdId: string): Promise<boolean> {
    try {
      const resp = await axios.get(`https://pan.quark.cn/s/${pwdId}`, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
        },
      });
      return !resp.data.includes('分享已失效') && !resp.data.includes('分享不存在');
    } catch {
      return true;
    }
  }
}
