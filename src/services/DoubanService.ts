import axios from 'axios';
import { LruCache } from '../utils/LruCache';

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
  releaseDate?: string;
  wishCount?: number;
  rank?: number;
  roles?: string[];
  type?: 'movie' | 'tv';
}

export type DoubanChartType =
  | 'movie_showing'
  | 'movie_soon'
  | 'movie_weekly_best'
  | 'tv_chinese_best_weekly'
  | 'tv_global_best_weekly'
  | 'movie_top250';

export interface DoubanSubjectDetail {
  id: string;
  title: string;
  originalTitle?: string;
  type: 'movie' | 'tv';
  year?: string;
  pubdate: string[];
  durations: string[];
  genres: string[];
  countries: string[];
  rate: string;
  ratingCount: number;
  intro: string;
  directors: string[];
  actors: string[];
  honors: string[];
  episodesCount?: number;
  episodesInfo?: string;
  lastEpisodeNumber?: number;
  isFinished: boolean;
  linewatches: string[];
  cover: string;
  url: string;
}

export interface DoubanComment {
  author: string;
  rating?: number;
  content: string;
  voteCount: number;
  createTime?: string;
}

export interface DoubanCelebrityResult {
  id: string;
  name: string;
  cover?: string;
  works: DoubanSubject[];
}

export interface DoubanEpisodeProgress {
  id: string;
  title: string;
  episodesCount?: number;
  episodesInfo?: string;
  lastEpisodeNumber?: number;
  isFinished: boolean;
  pubdate: string[];
  rate?: string;
}

export class DoubanService {
  private baseUrl = 'https://movie.douban.com/j';
  private rexxarBaseUrl = 'https://m.douban.com/rexxar/api/v2';
  private abstractCache: Map<string, Partial<DoubanSubject>> = new Map();
  private rexxarCache = new LruCache<string, any>(180, 15 * 60 * 1000);

  private normalizeTitle(value: unknown): string {
    return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  private titleSimilarity(query: string, candidate: string): number {
    const a = this.normalizeTitle(query);
    const b = this.normalizeTitle(candidate);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.82 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
    if (a.length < 2 || b.length < 2) return 0;
    const grams = (s: string) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
    const ga = grams(a);
    const gb = grams(b);
    let overlap = 0;
    for (const gram of ga) if (gb.has(gram)) overlap++;
    return (2 * overlap) / (ga.size + gb.size);
  }

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
   * 根据片名检索豆瓣信息，获取准确 ID、年份、评分、原名、海报封面与作品类型
   */
  async getMovieMeta(
    keyword: string,
    opts?: { allowExactTie?: boolean; year?: string }
  ): Promise<{ id?: string; title: string; year?: string; rate?: string; subTitle?: string; cover?: string; type?: 'movie' | 'tv' } | null> {
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
        const yearMatch = opts?.year || clean.match(/(?:19|20)\d{2}/)?.[0];
        const queryTitle = clean.replace(/[（(](?:19|20)\d{2}[）)]?/g, '').replace(/(?:19|20)\d{2}/g, '').trim() || clean;
        const ranked = resp.data
          .map((item: any, idx: number) => {
            const similarity = Math.max(
              this.titleSimilarity(queryTitle, item.title),
              this.titleSimilarity(queryTitle, item.sub_title)
            );
            const matchesYear = Boolean(yearMatch && String(item.year || '') === yearMatch);
            const hasYearConflict = Boolean(yearMatch && item.year && String(item.year) !== yearMatch);
            const hasCover = Boolean(item.img && String(item.img).trim());
            return {
              item,
              idx,
              similarity,
              matchesYear,
              hasYearConflict,
              score: similarity + (matchesYear ? 0.2 : hasYearConflict ? -0.2 : 0) + (opts?.allowExactTie && hasCover ? 0.01 : 0),
            };
          })
          .sort((a: any, b: any) => b.score - a.score || a.idx - b.idx);
        const best = ranked[0];
        if (!best || best.similarity < 0.58 || (yearMatch && best.hasYearConflict)) return null;
        const allowTie = Boolean(opts?.allowExactTie && best.similarity >= 0.99);
        if (!allowTie && ranked[1] && best.score - ranked[1].score < 0.06) return null;
        const matched = best.item;
        return {
          id: matched.id ? String(matched.id) : undefined,
          title: matched.title,
          year: matched.year,
          subTitle: matched.sub_title,
          cover: matched.img ? String(matched.img).trim() : undefined,
          type: matched.type === 'tv' ? 'tv' : 'movie',
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
    const meta = await this.getMovieMeta(title, { allowExactTie: true });
    if (!meta || !meta.id) return null;

    const abs = await this.getSubjectAbstract(meta.id);
    return {
      id: meta.id,
      title: meta.title || title,
      rate: abs?.rate || '',
      cover: meta.cover || '',
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

  private async rexxarGet(apiPath: string, params: Record<string, string | number> = {}, timeoutMs = 5500): Promise<any | null> {
    const queryStr = new URLSearchParams(
      Object.entries({ for_mobile: 1, ...params }).map(([k, v]) => [k, String(v)])
    ).toString();
    const fullUrl = `${this.rexxarBaseUrl}${apiPath}${queryStr ? `?${queryStr}` : ''}`;
    const cached = this.rexxarCache.get(fullUrl);
    if (cached !== undefined) return cached;

    try {
      const resp = await axios.get(fullUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
          Referer: 'https://m.douban.com/movie/',
          Accept: 'application/json',
        },
        timeout: timeoutMs,
      });
      if (resp.data) {
        this.rexxarCache.set(fullUrl, resp.data);
      }
      return resp.data || null;
    } catch {
      return null;
    }
  }

  /**
   * 解析 Rexxar subject_collection 条目或推荐条目为统一 DoubanSubject
   */
  public static mapRexxarItem(item: any): DoubanSubject {
    const subtitle = String(item?.card_subtitle || item?.info || '').trim();
    const parts = subtitle
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    const yearMatch = String(item?.year || parts[0] || '').match(/(?:19|20)\d{2}/)?.[0];
    const regionPart = parts.find((p) => !/^(?:19|20)\d{2}$/.test(p));
    const genrePart = parts.find((p, i) => i >= 1 && p !== regionPart && !/^(?:19|20)\d{2}$/.test(p));
    const types = Array.isArray(item?.genres)
      ? item.genres.map(String)
      : genrePart
      ? genrePart.split(/\s+/).filter(Boolean).slice(0, 4)
      : [];
    const rawRate = item?.rating?.value ?? item?.rate ?? '';
    const rate = typeof rawRate === 'number' && rawRate > 0 ? rawRate.toFixed(1) : String(rawRate || '');
    const actorsList = Array.isArray(item?.actors)
      ? item.actors.map((a: any) => (typeof a === 'string' ? a : a?.name || '')).filter(Boolean).slice(0, 3)
      : [];
    const directorsList = Array.isArray(item?.directors)
      ? item.directors.map((d: any) => (typeof d === 'string' ? d : d?.name || '')).filter(Boolean).slice(0, 2)
      : [];

    return {
      id: String(item?.id || item?.title || ''),
      title: String(item?.title || '').trim(),
      rate,
      cover: String(item?.cover?.url || item?.cover_url || item?.pic?.normal || item?.pic?.large || '').trim(),
      url: String(item?.url || item?.sharing_url || (item?.id ? `https://movie.douban.com/subject/${item.id}/` : '')),
      year: yearMatch,
      region: regionPart,
      types,
      actors: actorsList.join(' / ') || (parts.length >= 4 ? parts.slice(-1)[0] : ''),
      directors: directorsList.join(' / '),
      shortComment: String(item?.comment || item?.description || '').trim() || undefined,
      releaseDate: item?.release_date ? String(item.release_date).trim() : undefined,
      wishCount: typeof item?.wish_count === 'number' ? item.wish_count : undefined,
      rank: typeof item?.rank === 'number' ? item.rank : undefined,
      type: item?.type === 'tv' ? 'tv' : 'movie',
    };
  }

  /**
   * 判定剧集是否已在豆瓣标记完结
   */
  public static parseEpisodeFinished(episodesInfo?: string, episodesCount?: number, lastEpisodeNumber?: number): boolean {
    const info = String(episodesInfo || '').trim();
    if (/全\s*\d+\s*集|\d+\s*集全|已完结|完结/.test(info)) return true;
    if (
      typeof episodesCount === 'number' &&
      episodesCount > 0 &&
      typeof lastEpisodeNumber === 'number' &&
      lastEpisodeNumber >= episodesCount
    ) {
      return true;
    }
    return false;
  }

  private async resolveIdAndType(
    titleOrId: string,
    preferredType?: 'movie' | 'tv'
  ): Promise<{ id: string; type: 'movie' | 'tv' } | null> {
    const clean = String(titleOrId || '').replace(/[《》]/g, '').trim();
    if (!clean) return null;
    if (/^\d+$/.test(clean)) {
      return { id: clean, type: preferredType || 'movie' };
    }
    const meta = await this.getMovieMeta(clean, { allowExactTie: true });
    if (!meta?.id || !/^\d+$/.test(meta.id)) return null;
    return {
      id: meta.id,
      type: preferredType || meta.type || 'movie',
    };
  }

  /**
   * 1 & 2 & 3. 获取豆瓣权威榜单：正在热映 / 即将上映 / 一周口碑榜 / 华语与全球口碑剧集榜 / Top 250
   */
  async getDoubanChart(chartType: DoubanChartType, limit = 10, start = 0): Promise<DoubanSubject[]> {
    const data = await this.rexxarGet(`/subject_collection/${chartType}/items`, {
      start: Math.max(0, start),
      count: Math.min(25, Math.max(1, limit)),
    });
    const list = Array.isArray(data?.subject_collection_items) ? data.subject_collection_items : [];
    return list.slice(0, limit).map((item: any) => DoubanService.mapRexxarItem(item));
  }

  /**
   * 1. 大陆院线「即将上映 / 待映」新片清单（含定档日期、想看人数）
   */
  async getUpcomingMovies(limit = 12): Promise<DoubanSubject[]> {
    return this.getDoubanChart('movie_soon', limit, 0);
  }

  /**
   * 2. 大陆院线「正在热映」在映电影清单
   */
  async getNowPlaying(limit = 10): Promise<DoubanSubject[]> {
    return this.getDoubanChart('movie_showing', limit, 0);
  }

  /**
   * 4 & 7. 获取单部电影/剧集完整详情（剧情简介、获奖荣誉、时长/集数、播放平台、完结进度）
   */
  async getSubjectFullDetail(titleOrId: string, preferredType?: 'movie' | 'tv'): Promise<DoubanSubjectDetail | null> {
    const target = await this.resolveIdAndType(titleOrId, preferredType);
    if (!target) return null;

    let kind: 'movie' | 'tv' = target.type;
    let raw = await this.rexxarGet(`/${kind}/${target.id}`, { ck: '' });
    if (!raw || !raw.title) {
      const altKind: 'movie' | 'tv' = kind === 'movie' ? 'tv' : 'movie';
      const altRaw = await this.rexxarGet(`/${altKind}/${target.id}`, { ck: '' });
      if (altRaw && altRaw.title) {
        raw = altRaw;
        kind = altKind;
      }
    }
    if (!raw || !raw.title) return null;

    const epCount = typeof raw.episodes_count === 'number' ? raw.episodes_count : parseInt(String(raw.episodes_count || ''), 10) || undefined;
    const epInfo = raw.episodes_info ? String(raw.episodes_info).trim() : undefined;
    const lastEp =
      typeof raw.last_episode_number === 'number'
        ? raw.last_episode_number
        : parseInt(String(raw.last_episode_number || ''), 10) || undefined;

    return {
      id: String(raw.id || target.id),
      title: String(raw.title || '').trim(),
      originalTitle: raw.original_title ? String(raw.original_title).trim() : undefined,
      type: raw.is_tv || kind === 'tv' ? 'tv' : 'movie',
      year: raw.year ? String(raw.year).trim() : undefined,
      pubdate: Array.isArray(raw.pubdate) ? raw.pubdate.map(String) : [],
      durations: Array.isArray(raw.durations) ? raw.durations.map(String) : [],
      genres: Array.isArray(raw.genres) ? raw.genres.map(String) : [],
      countries: Array.isArray(raw.countries) ? raw.countries.map(String) : [],
      rate: typeof raw.rating?.value === 'number' && raw.rating.value > 0 ? raw.rating.value.toFixed(1) : '',
      ratingCount: typeof raw.rating?.count === 'number' ? raw.rating.count : 0,
      intro: String(raw.intro || '').replace(/\s+/g, ' ').trim(),
      directors: Array.isArray(raw.directors) ? raw.directors.map((d: any) => d?.name || '').filter(Boolean).slice(0, 3) : [],
      actors: Array.isArray(raw.actors) ? raw.actors.map((a: any) => a?.name || '').filter(Boolean).slice(0, 5) : [],
      honors: Array.isArray(raw.honor_infos)
        ? raw.honor_infos.map((h: any) => (h?.rank ? `${h.title}(No.${h.rank})` : h?.title || '')).filter(Boolean)
        : [],
      episodesCount: epCount,
      episodesInfo: epInfo,
      lastEpisodeNumber: lastEp,
      isFinished: DoubanService.parseEpisodeFinished(epInfo, epCount, lastEp),
      linewatches: Array.isArray(raw.linewatches) ? raw.linewatches.map((l: any) => l?.source?.name || '').filter(Boolean) : [],
      cover: String(raw.cover_url || raw.cover?.url || raw.pic?.normal || '').trim(),
      url: String(raw.url || `https://movie.douban.com/subject/${target.id}/`),
    };
  }

  /**
   * 4b. 获取豆瓣官方「喜欢这部作品的人也喜欢」相似推荐列表
   */
  async getSimilarSubjects(titleOrId: string, preferredType?: 'movie' | 'tv', limit = 8): Promise<DoubanSubject[]> {
    const target = await this.resolveIdAndType(titleOrId, preferredType);
    if (!target) return [];

    let list = await this.rexxarGet(`/${target.type}/${target.id}/recommendations`);
    if (!Array.isArray(list) || list.length === 0) {
      const alt: 'movie' | 'tv' = target.type === 'movie' ? 'tv' : 'movie';
      list = await this.rexxarGet(`/${alt}/${target.id}/recommendations`);
    }
    if (!Array.isArray(list)) return [];
    return list.slice(0, limit).map((item: any) => DoubanService.mapRexxarItem(item));
  }

  /**
   * 5. 获取单部作品高赞真实短评（口碑排雷与评价参考）
   */
  async getHotComments(titleOrId: string, preferredType?: 'movie' | 'tv', limit = 6): Promise<DoubanComment[]> {
    const target = await this.resolveIdAndType(titleOrId, preferredType);
    if (!target) return [];

    let data = await this.rexxarGet(`/${target.type}/${target.id}/interests`, {
      count: Math.min(10, Math.max(1, limit)),
      order_by: 'hot',
      start: 0,
    });
    if (!Array.isArray(data?.interests)) {
      const alt: 'movie' | 'tv' = target.type === 'movie' ? 'tv' : 'movie';
      data = await this.rexxarGet(`/${alt}/${target.id}/interests`, {
        count: Math.min(10, Math.max(1, limit)),
        order_by: 'hot',
        start: 0,
      });
    }
    const list = Array.isArray(data?.interests) ? data.interests : [];
    return list
      .map((it: any) => ({
        author: String(it?.user?.name || '豆瓣影迷').trim(),
        rating: typeof it?.rating?.value === 'number' ? it.rating.value : undefined,
        content: String(it?.comment || '').replace(/\s+/g, ' ').trim(),
        voteCount: typeof it?.vote_count === 'number' ? it.vote_count : 0,
        createTime: it?.create_time ? String(it.create_time).slice(0, 10) : undefined,
      }))
      .filter((c: DoubanComment) => c.content.length > 0)
      .slice(0, limit);
  }

  /**
   * 6. 影人档案检索：按导演/演员姓名查询高分代表作品集
   */
  async searchCelebrityWorks(personName: string, limit = 12): Promise<DoubanCelebrityResult | null> {
    const cleanName = String(personName || '').trim();
    if (!cleanName) return null;

    try {
      const suggestResp = await axios.get('https://movie.douban.com/j/subject_suggest', {
        params: { q: cleanName },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://movie.douban.com/',
        },
        timeout: 4500,
      });
      const suggestions = Array.isArray(suggestResp.data) ? suggestResp.data : [];
      const celeb = suggestions.find((s: any) => s?.type === 'celebrity' && s?.id);
      if (!celeb) return null;

      const worksData = await this.rexxarGet(`/celebrity/${celeb.id}/works`, {
        start: 0,
        count: Math.min(20, Math.max(5, limit)),
      });
      const rawWorks = Array.isArray(worksData?.works) ? worksData.works : [];
      const works: DoubanSubject[] = rawWorks
        .map((entry: any) => {
          const w = entry?.work || entry;
          const mapped = DoubanService.mapRexxarItem(w);
          mapped.roles = Array.isArray(entry?.roles) ? entry.roles.map(String) : [];
          return mapped;
        })
        .filter((w: DoubanSubject) => Boolean(w.title))
        .slice(0, limit);

      return {
        id: String(celeb.id),
        name: String(celeb.title || cleanName).trim(),
        cover: celeb.img ? String(celeb.img).trim() : undefined,
        works,
      };
    } catch {
      return null;
    }
  }

  /**
   * 7. 剧集分集进度与完结状态查询
   */
  async getEpisodeProgress(titleOrId: string): Promise<DoubanEpisodeProgress | null> {
    const detail = await this.getSubjectFullDetail(titleOrId, 'tv');
    if (!detail) return null;
    return {
      id: detail.id,
      title: detail.title,
      episodesCount: detail.episodesCount,
      episodesInfo: detail.episodesInfo,
      lastEpisodeNumber: detail.lastEpisodeNumber,
      isFinished: detail.isFinished,
      pubdate: detail.pubdate,
      rate: detail.rate || undefined,
    };
  }

  /**
   * 将榜单 / 热映 / 待映 / 影人作品集格式化为微信精排版 Markdown 卡片
   */
  public static formatChartMarkdown(
    heading: string,
    subjects: DoubanSubject[],
    opts?: { hint?: string; showWishOrDate?: boolean }
  ): string {
    if (!subjects || subjects.length === 0) {
      return `暂时没拉到「${heading}」的数据，过会儿再试一下~`;
    }
    const lines: string[] = [`**${heading}**`, ''];
    subjects.forEach((s, idx) => {
      const meta: string[] = [];
      if (s.releaseDate) meta.push(`${s.releaseDate}上映`);
      else if (s.year) meta.push(s.year);
      if (s.rate) meta.push(`⭐ ${s.rate}分`);
      else if (opts?.showWishOrDate && s.wishCount) meta.push(`${(s.wishCount / 1000).toFixed(1)}k 想看`);
      if (s.region) meta.push(s.region);
      if (s.types && s.types.length > 0) meta.push(s.types.slice(0, 2).join('/'));
      if (s.roles && s.roles.length > 0) meta.push(s.roles.slice(0, 2).join('/'));

      const metaText = meta.length > 0 ? `（${meta.join(' · ')}）` : '';
      lines.push(`**${idx + 1}. 《${s.title}》**${metaText}`);
      if (s.shortComment) {
        lines.push(`> ${s.shortComment.slice(0, 65)}`);
      } else if (s.actors) {
        lines.push(`> 主演：${s.actors}`);
      }
    });
    lines.push('');
    lines.push(opts?.hint || '👉 看中哪部直接回数字（如 **「1」**）搜网盘，或说 **「蹲守第1部」** 盯资源~');
    return lines.join('\n');
  }

  /**
   * 将单部详情、高赞短评与相似推荐格式化为微信精排版 Markdown 卡片
   */
  public static formatDeepDetailMarkdown(params: {
    detail: DoubanSubjectDetail;
    comments?: DoubanComment[];
    similar?: DoubanSubject[];
  }): string {
    const { detail, comments = [], similar = [] } = params;
    const meta: string[] = [];
    if (detail.year) meta.push(detail.year);
    if (detail.rate) meta.push(`⭐ ${detail.rate}分`);
    if (detail.countries.length > 0) meta.push(detail.countries.slice(0, 2).join('/'));
    if (detail.genres.length > 0) meta.push(detail.genres.slice(0, 3).join('/'));
    if (detail.durations.length > 0) meta.push(detail.durations[0]);

    const lines: string[] = [`**🎬 《${detail.title}》**${meta.length ? `（${meta.join(' · ')}）` : ''}`, ''];

    if (detail.type === 'tv' && (detail.episodesCount || detail.episodesInfo)) {
      const epParts = [
        detail.episodesCount ? `共 ${detail.episodesCount} 集` : '',
        detail.episodesInfo || (detail.isFinished ? '已完结' : '连载/待更新'),
        detail.pubdate[0] ? `首播：${detail.pubdate[0]}` : '',
      ].filter(Boolean);
      lines.push(`📺 **剧集进度**：${epParts.join(' · ')}`);
    } else if (detail.pubdate.length > 0) {
      lines.push(`📅 **上映时间**：${detail.pubdate.slice(0, 2).join(' / ')}`);
    }

    if (detail.directors.length > 0) lines.push(`🎬 **导演**：${detail.directors.join(' / ')}`);
    if (detail.actors.length > 0) lines.push(`🎭 **主演**：${detail.actors.join(' / ')}`);
    if (detail.honors.length > 0) lines.push(`🏆 **荣誉**：${detail.honors.slice(0, 3).join(' · ')}`);
    if (detail.linewatches.length > 0) lines.push(`📱 **正版平台**：${detail.linewatches.slice(0, 4).join(' / ')}`);

    if (detail.intro) {
      lines.push('');
      const shortIntro = detail.intro.length > 150 ? `${detail.intro.slice(0, 150)}...` : detail.intro;
      lines.push(`**剧情简介**\n${shortIntro}`);
    }

    if (comments.length > 0) {
      lines.push('');
      lines.push('**💬 豆瓣高赞短评**');
      comments.slice(0, 3).forEach((c) => {
        const star = c.rating ? `⭐${c.rating}分 · ` : '';
        lines.push(`> ${star}${c.content.slice(0, 85)}`);
      });
    }

    if (similar.length > 0) {
      lines.push('');
      lines.push('**🍿 喜欢这部的人也喜欢**');
      similar.slice(0, 5).forEach((s, idx) => {
        const r = s.rate ? ` · ⭐ ${s.rate}` : '';
        lines.push(`**${idx + 1}. 《${s.title}》**${s.year ? `（${s.year}${r}）` : r ? `（${r.slice(3)}）` : ''}`);
      });
    }

    lines.push('');
    lines.push(
      similar.length > 0
        ? `👉 想搜《${detail.title}》回 **「搜一下」**；想搜上面推荐回对应数字（如 **「1」**）~`
        : `👉 想看这部直接回 **「搜一下」** 或 **「蹲守《${detail.title}》」**~`
    );

    return lines.join('\n');
  }
}
