import axios from 'axios';
import { DoubanService } from './DoubanService';
import { LlmClientFactory } from '../utils/LlmClientFactory';
import { CloudResource } from '../types';

export interface MediaResolveInput {
  query?: string;
  originalTitle?: string;
  guessTitle?: string;
  alternateTitles?: string[];
  year?: string;
  mediaType?: 'movie' | 'tv';
  clues?: string;
  userId?: string;
  forceLlm?: boolean;
}

export interface ResolvedMediaInfo {
  standardTitle: string;
  originalTitle?: string;
  englishTitle?: string;
  originalLanguage?: string;
  aliases: string[];
  year?: string;
  mediaType?: 'movie' | 'tv';
  overview?: string;
  coverUrl?: string;
  source: 'tmdb' | 'bangumi' | 'douban' | 'llm' | 'raw';
}

interface CacheEntry {
  data: ResolvedMediaInfo;
  timestamp: number;
}

/**
 * 跨语种片名归一化与别名扩展解析器：
 * - 已配置 TMDB_API_KEY 时优先使用方案 B（TMDB 多语言权威片库对齐官方译名与港台/外语别名）；
 * - 未配置时自动降级为方案 A（豆瓣/Bangumi 公开检索 + 大模型反直译实体消歧与别名扩展）。
 */
export class MetadataResolver {
  private static instance: MetadataResolver;
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 30 * 60 * 1000;
  private doubanService = new DoubanService();

  private constructor() {}

  private normalizeEntityName(value: unknown): string {
    return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  /** 用归一化包含度与双字片段重合度估算标题是否为同一实体。 */
  private titleSimilarity(query: string, candidate: string): number {
    const a = this.normalizeEntityName(query);
    const b = this.normalizeEntityName(candidate);
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

  public static getInstance(): MetadataResolver {
    if (!MetadataResolver.instance) {
      MetadataResolver.instance = new MetadataResolver();
    }
    return MetadataResolver.instance;
  }

  public hasTmdbConfigured(): boolean {
    return this.getTmdbCredential().length > 0;
  }

  private getTmdbCredential(): string {
    return (process.env.TMDB_API_KEY || '').trim();
  }

  /**
   * 判断输入是否包含日/韩/英文等非纯中文字符，用于触发跨语种译名对齐
   */
  public static hasForeignScript(text: string): boolean {
    if (!text) return false;
    // 日文平假名/片假名、韩文谚文、连续 3 位以上英文字母（排除常见画质词 4K/HDR/REMUX 等）
    if (/[\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af\u1100-\u11ff]/.test(text)) {
      return true;
    }
    const stripped = text.replace(/\b(?:4k|2k|1080p|2160p|720p|hdr|dv|uhd|remux|bluray|web-dl|aac|x264|x265|hevc|tv|hd)\b/gi, '');
    return /[a-zA-Z]{3,}/.test(stripped);
  }

  private static cleanTitleStatic(raw?: string): string {
    return (raw || '')
      .replace(/[《》""''「」『』]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 从网盘资源标题中剥离【原盘】、4K、REMUX、60帧、外挂字幕、年份等噪点，提取纯净片名与年份
   */
  public static extractMediaQuery(raw?: string): { title: string; year?: string } {
    const base = MetadataResolver.cleanTitleStatic(raw);
    if (!base) return { title: '' };

    const yearMatch = base.match(/(?:^|[\s(\[（【])((?:19|20)\d{2})(?:[\s)\]）】]|$)/);
    const year = yearMatch ? yearMatch[1] : undefined;

    const cleaned = base
      .replace(/^(?:【[^】]{1,24}】|\[[^\]]{1,24}\])\s*/g, '')
      .replace(/[（(\[【]\s*(?:19|20)\d{2}\s*[）)\]】]/g, ' ')
      .replace(/\b(?:19|20)\d{2}\b/g, ' ')
      .replace(
        /\b(?:4k|2k|8k|1080p|2160p|720p|uhd|hdr\d*|dv|sdr|remux|bluray|blu-ray|bdmv|web-dl|webrip|hdtv|hevc|avc|x264|x265|h\.?264|h\.?265|10bit|8bit|aac|ac3|dts(?:-hd)?|truehd|atmos|flac|fps)\b/gi,
        ' '
      )
      .replace(
        /(?:杜比视界|杜比全景声|全景声|高码率?|高帧率|\d{2,3}帧|原盘|国粤双语|国粤多音轨|多音轨|双语|国语|粤语|英语|中英双字|外挂中?字?字幕|内封中?字?|简繁中字|简体中字|繁体中字|中文字幕|双语字幕|特效字幕|中字|未删减|无删减|加长版|导演剪辑版|终极版|完整版|珍藏版|合集|全集|全\d+集)/gi,
        ' '
      )
      .replace(/\bS\d{1,2}(?:E\d{1,3})?\b/gi, ' ')
      .replace(/[（(\[【][^（）()\[\]【】]{0,20}[）)\]】]\s*$/g, ' ')
      .replace(/[\s\-_|/]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      title: cleaned || base,
      year,
    };
  }

  private normalizeCleanTitle(raw?: string): string {
    return MetadataResolver.cleanTitleStatic(raw);
  }

  /**
   * 过滤容易在全网频道产生海量无关匹配的极短纯英文词（例如仅 2 个字符的扩展词 "Up"/"It"），
   * 但保留用户主动输入的原始关键词与多单词英文短语。
   */
  public static isNoisyShortEnglishTerm(term: string, userRawQuery?: string): boolean {
    const clean = MetadataResolver.cleanTitleStatic(term);
    if (!clean) return true;
    const rawClean = MetadataResolver.cleanTitleStatic(userRawQuery);
    if (rawClean && clean.toLowerCase() === rawClean.toLowerCase()) {
      return false;
    }
    if (/^[a-zA-Z0-9\s\-_.:'!&]+$/.test(clean)) {
      const compact = clean.replace(/[^a-zA-Z0-9]/g, '');
      const hasSpaces = /\s+/.test(clean);
      if (!hasSpaces && compact.length < 3) {
        return true;
      }
    }
    return false;
  }

  /**
   * 按固定三语槽位生成并发检索词列表：[中文官方名, 拍摄国原语言标题, 英文标题]（自动去重并过滤极短英文噪词）
   */
  public static buildTrilingualSearchTerms(
    info: Partial<ResolvedMediaInfo>,
    fallbackPrimary?: string,
    userRawQuery?: string
  ): string[] {
    const chineseTitle = MetadataResolver.cleanTitleStatic(info.standardTitle || fallbackPrimary || userRawQuery);
    const originalTitle = MetadataResolver.cleanTitleStatic(info.originalTitle);

    let englishTitle = MetadataResolver.cleanTitleStatic(info.englishTitle);
    if (!englishTitle && Array.isArray(info.aliases)) {
      const fallbackEn = info.aliases.find((a) => {
        const clean = MetadataResolver.cleanTitleStatic(a);
        return clean.length >= 3 && /^[a-zA-Z0-9\s\-_.:'!&,()]+$/.test(clean) && /[a-zA-Z]{2,}/.test(clean);
      });
      if (fallbackEn) {
        englishTitle = MetadataResolver.cleanTitleStatic(fallbackEn);
      }
    }

    const candidates = [chineseTitle, originalTitle, englishTitle];
    const seen = new Set<string>();
    const out: string[] = [];

    for (const c of candidates) {
      if (!c || c.length < 2) continue;
      if (/^\d{4}$/.test(c) || /^none$/i.test(c)) continue;
      if (MetadataResolver.isNoisyShortEnglishTerm(c, userRawQuery)) continue;

      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
      if (out.length >= 3) break;
    }

    if (out.length === 0 && userRawQuery) {
      const cleanRaw = MetadataResolver.cleanTitleStatic(userRawQuery);
      if (cleanRaw) out.push(cleanRaw);
    }

    return out;
  }

  private buildUniqueAliases(primary: string, candidates: Array<string | undefined>): string[] {
    const primaryNorm = primary.toLowerCase();
    const seen = new Set<string>([primaryNorm]);
    const out: string[] = [];

    for (const c of candidates) {
      const clean = this.normalizeCleanTitle(c);
      if (!clean || clean.length < 2) continue;
      // 跳过纯数字年份或无意义短词
      if (/^\d{4}$/.test(clean) || /^none$/i.test(clean)) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
      if (out.length >= 6) break;
    }
    return out;
  }

  private setCache(key: string, data: ResolvedMediaInfo): void {
    if (!this.cache.has(key) && this.cache.size >= 300) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * 方案 B：通过 TMDB API 获取官方简体中文译名及多地区/原语别名
   */
  private async resolveWithTmdb(
    queries: string[],
    preferredYear?: string,
    preferredMediaType?: 'movie' | 'tv',
    allowExactTie: boolean = false
  ): Promise<ResolvedMediaInfo | null> {
    const cred = this.getTmdbCredential();
    if (!cred) return null;

    const isBearer = cred.startsWith('eyJ') || cred.length > 45;
    const baseHeaders: Record<string, string> = { Accept: 'application/json' };
    if (isBearer) {
      baseHeaders.Authorization = `Bearer ${cred}`;
    }

    const tmdbGet = async (endpoint: string, params: Record<string, string>) => {
      const finalParams = isBearer ? params : { ...params, api_key: cred };
      const resp = await axios.get(`https://api.themoviedb.org/3${endpoint}`, {
        params: finalParams,
        headers: baseHeaders,
        timeout: 4500,
      });
      return resp.data;
    };

    for (const q of queries) {
      const cleanQ = this.normalizeCleanTitle(q);
      if (!cleanQ) continue;

      try {
        const searchData = await tmdbGet('/search/multi', {
          query: cleanQ,
          language: 'zh-CN',
          include_adult: 'false',
        });

        const items = Array.isArray(searchData?.results)
          ? searchData.results.filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv')
          : [];
        if (items.length === 0) continue;

        const ranked = items
          .map((item: any) => {
            const names = [item.title, item.name, item.original_title, item.original_name].filter(Boolean);
            const nameScore = Math.max(0, ...names.map((name: string) => this.titleSimilarity(cleanQ, name)));
            const date = String(item.release_date || item.first_air_date || '');
            const yearMatch = Boolean(preferredYear && date.startsWith(preferredYear));
            const yearMismatch = Boolean(preferredYear && /^\d{4}/.test(date) && !yearMatch);
            const typeMatch = Boolean(preferredMediaType && item.media_type === preferredMediaType);
            const typeMismatch = Boolean(preferredMediaType && item.media_type !== preferredMediaType);
            const score = nameScore * 0.78 + (preferredYear ? (yearMatch ? 0.18 : yearMismatch ? -0.12 : 0) : 0.1) +
              (preferredMediaType ? (typeMatch ? 0.08 : typeMismatch ? -0.12 : 0) : 0.08);
            const popularity = Number(item.popularity) || 0;
            const hasPoster = Boolean(item.poster_path);
            return { item, nameScore, yearMatch, yearMismatch, typeMatch, score, popularity, hasPoster };
          })
          .sort((a: any, b: any) => b.score - a.score || Number(b.hasPoster) - Number(a.hasPoster) || b.popularity - a.popularity);
        const bestRanked = ranked[0];
        const runnerUp = ranked[1];
        if (!bestRanked || bestRanked.nameScore < 0.58) continue;
        if (preferredYear && bestRanked.yearMismatch) continue;
        const exactName = bestRanked.nameScore >= 0.999;
        const clearWinner = !runnerUp || bestRanked.score - runnerUp.score >= 0.08;
        if (!exactName && !bestRanked.yearMatch && !bestRanked.typeMatch && !clearWinner) continue;
        if (!(allowExactTie && exactName) && runnerUp && bestRanked.score - runnerUp.score < 0.06) continue;
        const best = bestRanked.item;

        const mediaType: 'movie' | 'tv' = best.media_type === 'tv' ? 'tv' : 'movie';
        const officialTitle = this.normalizeCleanTitle(best.title || best.name);
        const origTitle = this.normalizeCleanTitle(best.original_title || best.original_name);
        const originalLanguage = best.original_language ? String(best.original_language).toLowerCase() : undefined;
        const year = String(best.release_date || best.first_air_date || '').slice(0, 4) || preferredYear;

        if (!officialTitle) continue;

        let englishTitle = originalLanguage === 'en' && origTitle ? origTitle : '';
        const collectedAliases: string[] = [];
        if (origTitle && origTitle.toLowerCase() !== officialTitle.toLowerCase()) {
          collectedAliases.push(origTitle);
        }

        // 并发拉取多地区译名与别名（优先定位 en 英文国际名，同时收集 zh-CN/zh-TW/zh-HK 等译名）
        try {
          const [transData, altData] = await Promise.allSettled([
            tmdbGet(`/${mediaType}/${best.id}/translations`, {}),
            tmdbGet(`/${mediaType}/${best.id}/alternative_titles`, {}),
          ]);

          const regionalAliases: string[] = [];
          if (transData.status === 'fulfilled' && Array.isArray(transData.value?.translations)) {
            for (const tr of transData.value.translations) {
              const iso = `${tr.iso_639_1 || ''}-${tr.iso_3166_1 || ''}`;
              const t = this.normalizeCleanTitle(tr.data?.title || tr.data?.name);
              if (!t) continue;
              if (tr.iso_639_1 === 'en') {
                if (!englishTitle || iso === 'en-US') {
                  englishTitle = t;
                }
                regionalAliases.push(t);
              } else if (['zh-CN', 'zh-TW', 'zh-HK'].includes(iso)) {
                regionalAliases.push(t);
              }
            }
          }

          if (altData.status === 'fulfilled') {
            const altList = altData.value?.titles || altData.value?.results || [];
            if (Array.isArray(altList)) {
              for (const alt of altList) {
                if (!alt.title) continue;
                const cleanAlt = this.normalizeCleanTitle(alt.title);
                if (!cleanAlt) continue;
                if (!englishTitle && ['US', 'GB'].includes(alt.iso_3166_1)) {
                  englishTitle = cleanAlt;
                }
                if (['CN', 'TW', 'HK', 'US', 'JP', 'KR'].includes(alt.iso_3166_1)) {
                  regionalAliases.push(cleanAlt);
                }
              }
            }
          }

          if (englishTitle) {
            collectedAliases.push(englishTitle);
          }
          collectedAliases.push(...regionalAliases);
        } catch {
          // 补充别名失败不影响主片名返回
        }

        return {
          standardTitle: officialTitle,
          originalTitle: origTitle || undefined,
          englishTitle: englishTitle || undefined,
          originalLanguage,
          aliases: this.buildUniqueAliases(officialTitle, collectedAliases),
          year: year || undefined,
          mediaType,
          overview: best.overview ? String(best.overview).trim() : undefined,
          coverUrl: best.poster_path ? `https://image.tmdb.org/t/p/w500${best.poster_path}` : undefined,
          source: 'tmdb',
        };
      } catch {
        // 当前查询失败则尝试下一个候选词或降级方案 A
      }
    }

    return null;
  }

  /**
   * Bangumi 公开片库查询（免 Key，重点辅助日影/日剧/动漫原名对齐官方中文译名）
   */
  private async resolveWithBangumi(queries: string[]): Promise<ResolvedMediaInfo | null> {
    for (const q of queries) {
      const cleanQ = this.normalizeCleanTitle(q);
      if (!cleanQ) continue;
      try {
        const resp = await axios.get(`https://api.bgm.tv/search/subject/${encodeURIComponent(cleanQ)}`, {
          params: { responseGroup: 'small', max_results: 5 },
          headers: { 'User-Agent': 'TVdazi/1.0 (https://github.com/Level6me/TVdazi)' },
          timeout: 3200,
        });
        const list = Array.isArray(resp.data?.list) ? resp.data.list : [];
        if (list.length === 0) continue;

        const ranked = list
          .map((item: any) => ({
            item,
            score: Math.max(
              this.titleSimilarity(cleanQ, item.name_cn),
              this.titleSimilarity(cleanQ, item.name)
            ),
          }))
          .sort((a: any, b: any) => b.score - a.score);
        if (!ranked[0] || ranked[0].score < 0.58) continue;
        if (ranked[1] && ranked[0].score - ranked[1].score < 0.06) continue;
        const exact = ranked[0].item;

        const cn = this.normalizeCleanTitle(exact?.name_cn);
        const orig = this.normalizeCleanTitle(exact?.name);
        if (!cn && !orig) continue;

        const primary = cn || orig;
        const bgmImg = exact?.images?.common || exact?.images?.large || exact?.images?.medium;
        return {
          standardTitle: primary,
          originalTitle: orig && orig !== primary ? orig : undefined,
          aliases: this.buildUniqueAliases(primary, [orig]),
          year: exact?.air_date ? String(exact.air_date).slice(0, 4) : undefined,
          coverUrl: bgmImg ? String(bgmImg).replace(/^http:\/\//i, 'https://') : undefined,
          source: 'bangumi',
        };
      } catch {
        // 静默回退
      }
    }
    return null;
  }

  /**
   * 方案 A 核心：结合豆瓣/Bangumi 与大模型反直译实体消歧，提取官方中文片名与跨语种别名
   */
  private async resolveWithLlm(input: MediaResolveInput): Promise<ResolvedMediaInfo | null> {
    const userId = input.userId || 'default_user';
    const { client, model, hasValidKey } = LlmClientFactory.getClientForUser(userId, 8500);
    if (!hasValidKey) return null;

    const systemPrompt = `你是一个精通中日韩美欧美影视资料库（豆瓣、TMDB、IMDb、Bangumi）的「官方译名对齐与跨语种别名专家」。
核心任务：解决外语片名被生硬字面直译（例如把日文片名按字面直译成“突然身体不适”而非官方译名《突如其来》）或资源站点使用不同译名（大陆官方译名/港台译名/民间俗称/原语言标题/英文名）导致搜不到资源的问题。

请根据提供的片名、外语原文或线索，严格输出合法 JSON：
{
  "isKnownWork": true,
  "standardTitle": "中国大陆豆瓣或主流字幕组最通用的官方正式中文片名（不带书名号；严禁按外语单词字面生硬直译！）",
  "originalTitle": "拍摄国原语言标题（如日文/韩文/英文原名，不确定则留空）",
  "englishTitle": "官方或国际发行英文片名（若本身是英语作品可与originalTitle相同，不确定留空）",
  "aliases": ["港台译名", "常见别名或民间译名", "英文名或原片名（最多4个）"],
  "year": "上映或开播年份（4位数字，不确定留空）"
}
规则：
1. 若输入本身像是外语按字面意思生硬直译的片名（或包含日/韩/英文原文），务必反查并还原为国内影迷圈与网盘资源站真正通用的正式中文片名；
2. aliases 中尽量保留常见异名（港台译名、英文名、原片名），以便多关键词扩展搜全网盘资源。`;

    const parts = [
      input.originalTitle ? `外语/海报原标题: ${input.originalTitle}` : '',
      input.guessTitle ? `初步识别或直译名: ${input.guessTitle}` : '',
      input.query && input.query !== input.guessTitle ? `用户搜索词: ${input.query}` : '',
      input.year ? `年份线索: ${input.year}` : '',
      input.clues ? `画面/演员/导演线索: ${input.clues}` : '',
    ].filter(Boolean);

    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: parts.join('\n') },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const raw = (resp.choices[0]?.message?.content || '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(raw);

      const standard = this.normalizeCleanTitle(parsed.standardTitle || input.guessTitle || input.query);
      if (!standard) return null;

      const orig = this.normalizeCleanTitle(parsed.originalTitle || input.originalTitle);
      const englishTitle = this.normalizeCleanTitle(parsed.englishTitle);
      const llmAliases = Array.isArray(parsed.aliases) ? parsed.aliases : [];

      return {
        standardTitle: standard,
        originalTitle: orig || undefined,
        englishTitle: englishTitle || undefined,
        aliases: this.buildUniqueAliases(standard, [
          orig,
          englishTitle,
          ...llmAliases,
          input.guessTitle,
          input.query,
          ...(input.alternateTitles || []),
        ]),
        year: parsed.year ? String(parsed.year).slice(0, 4) : input.year,
        source: 'llm',
      };
    } catch {
      return null;
    }
  }

  /**
   * 统一入口：优先方案 B（TMDB API），未配置或未命中时自动执行方案 A（豆瓣/Bangumi + 大模型实体对齐）
   */
  public async resolveMedia(input: MediaResolveInput): Promise<ResolvedMediaInfo> {
    const cleanQuery = this.normalizeCleanTitle(input.query);
    const cleanOrig = this.normalizeCleanTitle(input.originalTitle);
    const cleanGuess = this.normalizeCleanTitle(input.guessTitle);
    const fallbackPrimary = cleanGuess || cleanQuery || cleanOrig;

    const cacheKey = [
      cleanOrig,
      cleanGuess,
      cleanQuery,
      input.year || '',
      input.mediaType || '',
      input.forceLlm ? 'force-llm' : '',
      input.userId || 'default_user',
      ...(input.alternateTitles || []).map((title) => this.normalizeCleanTitle(title)).sort(),
    ].join('::').toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (
      cached &&
      Date.now() - cached.timestamp < this.CACHE_TTL_MS &&
      !(input.forceLlm && cached.data.source === 'raw')
    ) {
      return cached.data;
    }

    const splitOrigParts = cleanOrig
      ? cleanOrig
          .split(/\s*[\/|｜]\s*/)
          .map((s) => this.normalizeCleanTitle(s))
          .filter((s) => s.length >= 2)
      : [];
    const rawCandidates = [
      ...splitOrigParts,
      cleanOrig,
      cleanGuess,
      cleanQuery,
      ...(input.alternateTitles || []),
    ].filter(Boolean);

    // 1. 方案 B：若配置了 TMDB_API_KEY，优先调用 TMDB 对齐官方中文译名与多语言别名
    if (this.hasTmdbConfigured()) {
      const tmdbRes = await this.resolveWithTmdb(rawCandidates, input.year, input.mediaType);
      if (tmdbRes) {
        const merged: ResolvedMediaInfo = {
          ...tmdbRes,
          aliases: this.buildUniqueAliases(tmdbRes.standardTitle, [
            ...tmdbRes.aliases,
            cleanOrig,
            cleanGuess,
            cleanQuery,
            ...(input.alternateTitles || []),
          ]),
        };
        this.setCache(cacheKey, merged);
        return merged;
      }
    }

    // 2. 方案 A（无 TMDB Key 或 TMDB 未命中时自动兜底）
    // 2a. 尝试豆瓣 + Bangumi 公开片库（两者并行，总耗时受 3.2~4.5s 控制）
    const [doubanRes, bgmRes] = await Promise.allSettled([
      (async () => {
        for (const q of rawCandidates.slice(0, 2)) {
          const meta = await this.doubanService.getMovieMeta(q);
          if (meta?.title) return meta;
        }
        return null;
      })(),
      cleanOrig || MetadataResolver.hasForeignScript(fallbackPrimary)
        ? this.resolveWithBangumi(rawCandidates.slice(0, 2))
        : Promise.resolve(null),
    ]);

    const doubanMeta = doubanRes.status === 'fulfilled' ? doubanRes.value : null;
    const bgmMeta = bgmRes.status === 'fulfilled' ? bgmRes.value : null;

    if (doubanMeta?.title) {
      const primary = this.normalizeCleanTitle(doubanMeta.title);
      const res: ResolvedMediaInfo = {
        standardTitle: primary,
        originalTitle: this.normalizeCleanTitle(doubanMeta.subTitle || cleanOrig) || undefined,
        aliases: this.buildUniqueAliases(primary, [
          doubanMeta.subTitle,
          cleanOrig,
          cleanGuess,
          cleanQuery,
          bgmMeta?.standardTitle,
          ...(bgmMeta?.aliases || []),
          ...(input.alternateTitles || []),
        ]),
        year: doubanMeta.year || input.year,
        coverUrl: doubanMeta.cover || bgmMeta?.coverUrl || undefined,
        source: 'douban',
      };
      this.setCache(cacheKey, res);
      return res;
    }

    // 2b. 若有外语原名、强迫纠偏标记或需提取跨语种别名，调用大模型反直译对齐官方中文译名
    const shouldCallLlm =
      Boolean(input.forceLlm) ||
      Boolean(cleanOrig) ||
      MetadataResolver.hasForeignScript(fallbackPrimary);

    if (shouldCallLlm) {
      const llmRes = await this.resolveWithLlm({
        ...input,
        originalTitle: cleanOrig || bgmMeta?.originalTitle || undefined,
        guessTitle: bgmMeta?.standardTitle || cleanGuess || cleanQuery,
      });
      if (llmRes) {
        const res: ResolvedMediaInfo = {
          ...llmRes,
          aliases: this.buildUniqueAliases(llmRes.standardTitle, [
            ...llmRes.aliases,
            bgmMeta?.standardTitle,
            ...(bgmMeta?.aliases || []),
          ]),
        };
        this.setCache(cacheKey, res);
        return res;
      }
    }

    if (bgmMeta) {
      const res: ResolvedMediaInfo = {
        ...bgmMeta,
        aliases: this.buildUniqueAliases(bgmMeta.standardTitle, [
          ...bgmMeta.aliases,
          cleanOrig,
          cleanGuess,
          cleanQuery,
          ...(input.alternateTitles || []),
        ]),
      };
      this.setCache(cacheKey, res);
      return res;
    }

    const rawResult: ResolvedMediaInfo = {
      standardTitle: fallbackPrimary,
      originalTitle: cleanOrig || undefined,
      aliases: this.buildUniqueAliases(fallbackPrimary, [
        cleanOrig,
        cleanGuess,
        cleanQuery,
        ...(input.alternateTitles || []),
      ]),
      year: input.year,
      source: 'raw',
    };
    this.setCache(cacheKey, rawResult);
    return rawResult;
  }

  /**
   * AI 检索结果精准筛选：
   * - 保留目标作品本体，以及同一系列/同一 IP 的续集（第2部/第N季/Part 2）、前传、剧场版、番外篇、特别篇、官方衍生作品与系列合集；
   * - 剔除完全无关的同名/局部撞词他作（例如《突如其来》误命中完全无关的《突如其来的幸福》）、仅页脚广告顺带提及、或短剧/电子书/音频/PPT 等非影视无关资源。
   */
  public async filterRelevantResources(params: {
    items: CloudResource[];
    targetTitle: string;
    originalTitle?: string;
    aliases?: string[];
    year?: string;
    mediaType?: 'movie' | 'tv';
    overview?: string;
    userId?: string;
  }): Promise<{ filteredItems: CloudResource[]; aiFiltered: boolean; droppedCount: number; reason?: string }> {
    const items = params.items || [];
    if (items.length === 0) {
      return { filteredItems: [], aiFiltered: false, droppedCount: 0 };
    }

    const { client, model, hasValidKey } = LlmClientFactory.getClientForUser(params.userId, 8000);
    if (!hasValidKey) {
      return { filteredItems: items, aiFiltered: false, droppedCount: 0 };
    }

    const candidates = items.slice(0, 25);
    const serialized = candidates.map((item, idx) => {
      const cleanRaw = (item.rawText || '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      return `[${idx}] 标题:${item.title} | 分类:${item.category || '未知'} | 摘要:${cleanRaw}`;
    });

    const targetDesc = [
      `标准片名: 《${params.targetTitle}》`,
      params.originalTitle ? `外语原名: ${params.originalTitle}` : '',
      params.year ? `年份: ${params.year}` : '',
      params.mediaType ? `类型: ${params.mediaType === 'movie' ? '电影' : '剧集'}` : '',
      params.aliases && params.aliases.length > 0 ? `合法别名: ${params.aliases.slice(0, 5).join(' / ')}` : '',
      params.overview ? `剧情梗概: ${params.overview.slice(0, 120)}` : '',
    ]
      .filter(Boolean)
      .join('；');

    const systemPrompt = `你是网盘影视资源智能审核专家。
给定用户想找的目标影视作品元信息，以及从 Telegram 频道按关键词抓取到的候选网盘资源列表，请甄别每一条候选资源是否属于**目标作品本体**或**同系列续集/衍生作品**！

必须保留（不要剔除）：
1. **目标作品本体**：对应目标作品本身（含正式中文名、外语原名、英文名、官方港台译名，以及带年份、4K/1080P、字幕组前缀、全集合集的版本）；
2. **同一系列的续集与前传**：如第 2 部、第 3 部、第二季 / 第 N 季、Part 2、续篇、前传、终章、系列合集/全集打包（例如搜《沙丘》时保留《沙丘2》，搜《庆余年》时保留《庆余年 第二季》《庆余年全集》）；
3. **同 IP 衍生作品**：同一作品宇宙或同一系列的官方外传、番外篇、特别篇、SP、OVA、OAD、剧场版、总集篇或明确相关的衍生剧/衍生电影。

严格剔除：
1. **完全无关的同名异作 / 局部撞词**：只是字面上凑巧包含相同词组但剧情/主创/背景毫无关系的另一部作品（例如目标为 2026 年日本电影《突如其来》，候选却是完全无关的另一部作品《突如其来的幸福》《突如其来的大雨》《突然的喜欢》）；
2. **非目标介质或垃圾广告资源**：微短剧/竖屏土味短剧（除非目标本身就是短剧）、小说电子书(TXT/EPUB)、音频/OST音乐专辑、PPT 模板、软件工具或仅在频道广告推荐列表尾部顺带提及关键词的无关帖子。

注意：不要因为续集/衍生作品的“上映年份与第一部不同”或标题多了“2 / 第二季 / 前传 / 外传 / 番外”而将其误删！
如果候选中没有任何条目属于目标作品及其系列/衍生作品，将 keepIndices 设为 []。

请严格输出合法 JSON：
{
  "keepIndices": [0, 2],
  "reason": "用25字以内简述过滤或保留依据"
}`;

    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `【目标作品】\n${targetDesc}\n\n【候选资源(${candidates.length}条)】\n${serialized.join('\n')}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const raw = (resp.choices[0]?.message?.content || '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed.keepIndices)) {
        return { filteredItems: items, aiFiltered: false, droppedCount: 0 };
      }

      const validSeen = new Set<number>();
      const kept: CloudResource[] = [];
      for (const rawIdx of parsed.keepIndices) {
        const idx = Number(rawIdx);
        if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length && !validSeen.has(idx)) {
          validSeen.add(idx);
          kept.push(candidates[idx]);
        }
      }

      const droppedCount = candidates.length - kept.length;
      const reason = parsed.reason ? String(parsed.reason).trim() : undefined;
      console.log(
        `[AI 精筛] target=《${params.targetTitle}》, 候选=${candidates.length}, 保留=${kept.length}, 剔除=${droppedCount}, reason=${reason || '-'}`
      );

      return {
        filteredItems: kept,
        aiFiltered: true,
        droppedCount,
        reason,
      };
    } catch (err: any) {
      console.warn('[AI 精筛降级] 跳过 AI 筛选，保留原检索结果:', err.message);
      return { filteredItems: items, aiFiltered: false, droppedCount: 0 };
    }
  }

  /**
   * 快捷解析单部影视作品的官方海报封面 URL（支持脏标题清洗，并发检索豆瓣 / TMDB，缺失时回退 LLM 错别字纠偏再查）
   */
  public async resolveCoverUrl(
    title: string,
    opts?: { year?: string; mediaType?: 'movie' | 'tv'; userId?: string }
  ): Promise<string | undefined> {
    const extracted = MetadataResolver.extractMediaQuery(title);
    const clean = extracted.title;
    const year = opts?.year || extracted.year;
    if (!clean) return undefined;

    const noDigitTitle = clean.replace(/(?:第[一二三四五六七八九十\d]+季|\s*\d+)$/, '').trim();
    const candidates = noDigitTitle && noDigitTitle !== clean ? [clean, noDigitTitle] : [clean];

    const [doubanMeta, tmdbRes] = await Promise.all([
      (async () => {
        for (const q of candidates) {
          const m = await this.doubanService.getMovieMeta(q, { allowExactTie: true, year }).catch(() => null);
          if (m?.cover) return m.cover;
        }
        return undefined;
      })(),
      this.hasTmdbConfigured()
        ? this.resolveWithTmdb(candidates, year, opts?.mediaType, true).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (doubanMeta) return doubanMeta;
    if (tmdbRes?.coverUrl) return tmdbRes.coverUrl;

    const resolved = await this.resolveMedia({
      query: clean,
      guessTitle: clean,
      year,
      mediaType: opts?.mediaType,
      userId: opts?.userId,
      forceLlm: true,
    }).catch(() => null);

    if (resolved?.coverUrl) return resolved.coverUrl;

    // 若大模型将错别字片名（如“财狼的日子2”->“豺狼的日子”）纠偏为标准片名，按标准片名补查一次封面
    const corrected = resolved?.standardTitle ? MetadataResolver.extractMediaQuery(resolved.standardTitle).title : '';
    if (corrected && corrected !== clean) {
      const [retryDouban, retryTmdb] = await Promise.all([
        this.doubanService.getMovieMeta(corrected, { allowExactTie: true, year: resolved?.year || year }).catch(() => null),
        this.hasTmdbConfigured()
          ? this.resolveWithTmdb([corrected], resolved?.year || year, opts?.mediaType, true).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (retryDouban?.cover) return retryDouban.cover;
      if (retryTmdb?.coverUrl) return retryTmdb.coverUrl;
    }

    return undefined;
  }
}
