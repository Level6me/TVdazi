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
  directors?: string;
  types?: string[];
  region?: string;
  episodesCount?: string;
  shortComment?: string;
}

export class DoubanService {
  private baseUrl = 'https://movie.douban.com/j';
  private detailCache: Map<string, { rating: string; actors: string; year: string }> = new Map();
  private abstractCache: Map<string, Partial<DoubanSubject>> = new Map();

  /**
   * 获取豆瓣单部作品的真实详情摘要（包含准确上映年份、题材类型、主演、导演、集数与热门短评）
   */
  async getSubjectAbstract(subjectId: string): Promise<Partial<DoubanSubject> | null> {
    if (!subjectId || !/^\d+$/.test(String(subjectId))) return null;
    if (this.abstractCache.has(subjectId)) {
      return this.abstractCache.get(subjectId)!;
    }

    try {
      const resp = await axios.get(`${this.baseUrl}/subject_abstract`, {
        params: { subject_id: subjectId },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://movie.douban.com/',
          Accept: 'application/json, text/plain, */*',
        },
        timeout: 3500,
      });

      const sub = resp.data?.subject;
      if (!sub) return null;

      const info: Partial<DoubanSubject> = {
        id: String(sub.id || subjectId),
        year: sub.release_year ? String(sub.release_year).trim() : undefined,
        rate: sub.rate ? String(sub.rate).trim() : undefined,
        types: Array.isArray(sub.types) ? sub.types : [],
        region: sub.region ? String(sub.region).trim() : undefined,
        actors: Array.isArray(sub.actors) ? sub.actors.slice(0, 4).join(' / ') : undefined,
        directors: Array.isArray(sub.directors) ? sub.directors.slice(0, 2).join(' / ') : undefined,
        episodesCount: sub.episodes_count ? String(sub.episodes_count).trim() : undefined,
        shortComment: sub.short_comment?.content ? String(sub.short_comment.content).trim() : undefined,
      };

      if (this.abstractCache.size >= 500) {
        const oldestKey = this.abstractCache.keys().next().value;
        if (oldestKey) this.abstractCache.delete(oldestKey);
      }
      this.abstractCache.set(subjectId, info);
      return info;
    } catch {
      return null;
    }
  }

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
   * 根据片名检索豆瓣信息，获取准确 ID、年份、评分、原名与演员
   */
  async getMovieMeta(keyword: string): Promise<{ id?: string; title: string; year?: string; rate?: string; subTitle?: string } | null> {
    const clean = keyword.replace(/^(电影|电视剧|网剧|动漫)\s*/, '').trim();
    if (!clean) return null;

    try {
      const resp = await axios.get('https://movie.douban.com/j/subject_suggest', {
        params: { q: clean },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://movie.douban.com/',
        },
        timeout: 4500,
      });

      if (Array.isArray(resp.data) && resp.data.length > 0) {
        const matched =
          resp.data.find((item: any) => item.title === clean) ||
          resp.data.find((item: any) => clean.includes(item.title) || item.title.includes(clean)) ||
          resp.data[0];
        return {
          id: matched.id ? String(matched.id) : undefined,
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
   * 根据片名直接查询豆瓣并补全真实详情摘要（用于特定剧情/相似剧集精准核验）
   */
  async searchAndEnrichSubjectByTitle(title: string): Promise<DoubanSubject | null> {
    const meta = await this.getMovieMeta(title);
    if (!meta || !meta.id) return null;

    const abs = await this.getSubjectAbstract(meta.id);
    return {
      id: meta.id,
      title: meta.title || title,
      rate: abs?.rate || '',
      cover: '',
      url: `https://movie.douban.com/subject/${meta.id}/`,
      year: abs?.year || meta.year,
      types: abs?.types || [],
      region: abs?.region,
      actors: abs?.actors,
      directors: abs?.directors,
      episodesCount: abs?.episodesCount,
      shortComment: abs?.shortComment,
    };
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
