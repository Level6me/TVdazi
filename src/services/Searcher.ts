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
  private calculateScore(item: CloudResource, keyword: string): number {
    const kw = keyword.toLowerCase().trim();
    const title = (item.title || '').toLowerCase();
    const raw = (item.rawText || '').toLowerCase();

    let score = 0;

    // 1. 标题完全包含完整关键词（最优先）
    if (title.includes(kw)) {
      score += 1000;
      // 标题越短且纯净，权重更高
      score += Math.max(0, 100 - title.length);
    }

    // 2. 帖子正文前 100 字符内包含完整关键词
    if (raw.slice(0, 100).includes(kw)) {
      score += 300;
    } else if (raw.includes(kw)) {
      score += 100;
    }

    // 3. 夸克网盘优先加分（支持一键转存）
    if (item.panType === 'quark') {
      score += 50;
    }

    // 4. 画质标签加分
    if (title.includes('4k') || raw.includes('4k')) score += 20;
    if (title.includes('remux') || raw.includes('remux')) score += 15;
    if (title.includes('1080p') || raw.includes('1080p')) score += 10;

    return score;
  }

  /**
   * 搜索公开频道影视/网盘资源
   */
  async search(options: SearchOptions): Promise<SearchResult> {
    const startTime = Date.now();
    const keyword = options.keyword.trim();
    const results: CloudResource[] = [];
    const seenUrls = new Set<string>();
    const channels = this.getActiveChannels();

    const searchPromises = channels.map(async (channel) => {
      try {
        const url = `https://t.me/s/${channel}?q=${encodeURIComponent(keyword)}`;
        const response = await axios.get(url, {
          timeout: 7000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });

        const $ = cheerio.load(response.data);
        $('.tgme_widget_message_wrap').each((_, elem) => {
          const text = $(elem).find('.tgme_widget_message_text').text();
          if (!text) return;

          // 提取各种网盘链接
          const quarkMatch = text.match(/https?:\/\/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/);
          const aliyunMatch = text.match(/https?:\/\/(?:\w+\.)?(?:alipan|aliyundrive)\.com\/s\/([a-zA-Z0-9]+)/);
          const ucMatch = text.match(/https?:\/\/drive\.uc\.cn\/s\/([a-zA-Z0-9]+)/);
          const pan115Match = text.match(/https?:\/\/(?:115|anxia|115cdn)\.com\/s\/([a-zA-Z0-9]+)/);
          const pan123Match = text.match(/https?:\/\/(?:www\.)?123[^\/\s<>"]+\.com\/s\/([a-zA-Z0-9]+)/);
          const tianyiMatch = text.match(/https?:\/\/cloud\.189\.cn\/[^\s<>"]+/);
          const baiduMatch = text.match(/https?:\/\/(?:pan|yun)\.baidu\.com\/s\/[^\s<>"]+/);

          let shareUrl = '';
          let shareId = '';
          let panType: CloudResource['panType'] = 'other';

          if (quarkMatch) {
            shareUrl = quarkMatch[0];
            shareId = quarkMatch[1];
            panType = 'quark';
          } else if (aliyunMatch) {
            shareUrl = aliyunMatch[0];
            shareId = aliyunMatch[1];
            panType = 'aliyun';
          } else if (ucMatch) {
            shareUrl = ucMatch[0];
            shareId = ucMatch[1];
            panType = 'uc';
          } else if (pan115Match) {
            shareUrl = pan115Match[0];
            shareId = pan115Match[1];
            panType = 'other';
          } else if (pan123Match) {
            shareUrl = pan123Match[0];
            shareId = pan123Match[1];
            panType = 'other';
          } else if (tianyiMatch) {
            shareUrl = tianyiMatch[0];
            panType = 'other';
          } else if (baiduMatch) {
            shareUrl = baiduMatch[0];
            panType = 'other';
          }

          if (shareUrl && !seenUrls.has(shareUrl)) {
            let extractedTitle = keyword;
            const nameMatch = text.match(/名称[：:]\s*([^\n\r]+)/);
            if (nameMatch && nameMatch[1]) {
              extractedTitle = nameMatch[1].trim();
            } else {
              const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
              extractedTitle = lines[0] ? lines[0].replace(/^(名称|片名|标题)[：:]\s*/, '').trim() : keyword;
            }

            const cleanTitle = this.cleanRawTitle(extractedTitle, keyword);
            seenUrls.add(shareUrl);
            const category = CategoryClassifier.classify(cleanTitle || keyword, text);

            results.push({
              title: cleanTitle || keyword,
              shareUrl,
              shareId,
              panType,
              category,
              rawText: text.slice(0, 400),
              sourceChannel: channel,
            });
          }
        });
      } catch (err) {
        // 静默异常
      }
    });

    await Promise.allSettled(searchPromises);

    // 关键优化：按相关度精确打分并降序排列！优先过滤标题或正文完全不含关键词的无关干扰项
    const kwLower = keyword.toLowerCase();
    const relevantItems = results.filter((item) => {
      const inTitle = item.title.toLowerCase().includes(kwLower);
      const inRaw = (item.rawText || '').toLowerCase().includes(kwLower);
      return inTitle || inRaw;
    });

    // 若有高相关度结果，则只使用高相关度项；若都没有才降级返回全部
    const pool = relevantItems.length > 0 ? relevantItems : results;

    pool.sort((a, b) => {
      const scoreA = this.calculateScore(a, keyword);
      const scoreB = this.calculateScore(b, keyword);
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
