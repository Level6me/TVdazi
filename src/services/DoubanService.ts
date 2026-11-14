import axios from 'axios';

export interface DoubanSubject {
  id: string;
  title: string;
  rate: string;
  cover: string;
  url: string;
  is_new?: boolean;
  year?: string;
  sub_title?: string;
  actors?: string;
}

export class DoubanService {
  private baseUrl = 'https://movie.douban.com/j';
  private detailCache: Map<string, { rating: string; actors: string; year: string }> = new Map();

  /**
   * 拉取豆瓣热门电影/剧集榜单
   */
  async getHotList(type: 'movie' | 'tv' = 'movie', tag: string = '热门', limit: number = 8, start: number = 0): Promise<DoubanSubject[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/search_subjects`, {
        params: {
          type,
          tag,
          page_limit: limit.toString(),
          page_start: start.toString(),
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://movie.douban.com/',
          'Accept': 'application/json, text/plain, */*',
        },
        timeout: 8000,
      });

      if (response.data && response.data.subjects) {
        return response.data.subjects;
      }
      return [];
    } catch (err: any) {
      console.error('[DoubanService] 获取热门榜单失败:', err.message);
      return [];
    }
  }

  /**
   * 根据片名检索豆瓣信息，获取准确年份、评分、原名与演员
   */
  async getMovieMeta(keyword: string): Promise<{ title: string; year?: string; rate?: string; subTitle?: string } | null> {
    const clean = keyword.replace(/^(电影|电视剧|网剧|动漫)\s*/, '').trim();
    if (!clean) return null;

    try {
      const resp = await axios.get('https://movie.douban.com/j/subject_suggest', {
        params: { q: clean },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://movie.douban.com/',
        },
        timeout: 5000,
      });

      if (Array.isArray(resp.data) && resp.data.length > 0) {
        // 优先匹配标题相近的条目
        const matched = resp.data.find((item: any) => clean.includes(item.title) || item.title.includes(clean)) || resp.data[0];
        return {
          title: matched.title,
          year: matched.year,
          subTitle: matched.sub_title,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 多维度高级检索召回（支持按热度/时间/评分排序、年代区间、国家地区、题材过滤）
   * sort: 'T' (标记最多/大众最火), 'U' (近期热门), 'R' (最新上映), 'S' (评分最高)
   */
  async getAdvancedCandidates(options: {
    tags?: string;
    sort?: 'T' | 'U' | 'R' | 'S';
    genres?: string;
    countries?: string;
    yearRange?: string;
    start?: number;
    limit?: number;
  }): Promise<DoubanSubject[]> {
    try {
      const params: Record<string, string | number> = {
        sort: options.sort || 'U',
        range: '0,10',
        tags: options.tags || '电影',
        start: options.start || 0,
      };
      if (options.genres) params.genres = options.genres;
      if (options.countries) params.countries = options.countries;
      if (options.yearRange) params.year_range = options.yearRange;

      const resp = await axios.get(`${this.baseUrl}/new_search_subjects`, {
        params,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://movie.douban.com/',
          Accept: 'application/json, text/plain, */*',
        },
        timeout: 6500,
      });

      const list = resp.data?.data;
      if (Array.isArray(list)) {
        return list.slice(0, options.limit || 15).map((item: any) => ({
          id: item.id || item.title,
          title: item.title,
          rate: item.rate || '',
          cover: item.cover || '',
          url: item.url || '',
          actors: Array.isArray(item.casts) ? item.casts.slice(0, 3).join(' / ') : '',
        }));
      }
      return [];
    } catch (err: any) {
      console.warn('[DoubanService] getAdvancedCandidates 异常:', err.message);
      return [];
    }
  }
}
