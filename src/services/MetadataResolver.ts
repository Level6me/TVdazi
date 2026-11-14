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
  clues?: string;
  userId?: string;
  forceLlm?: boolean;
}

export interface ResolvedMediaInfo {
  standardTitle: string;
  originalTitle?: string;
  aliases: string[];
  year?: string;
  mediaType?: 'movie' | 'tv';
  overview?: string;
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

  private normalizeCleanTitle(raw?: string): string {
    return (raw || '')
      .replace(/[《》""''「」『』]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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
  private async resolveWithTmdb(queries: string[], preferredYear?: string): Promise<ResolvedMediaInfo | null> {
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

        let best = items[0];
        if (preferredYear) {
          const yearMatched = items.find((item: any) => {
            const d = String(item.release_date || item.first_air_date || '');
            return d.startsWith(preferredYear);
          });
          if (yearMatched) best = yearMatched;
        }

        const mediaType: 'movie' | 'tv' = best.media_type === 'tv' ? 'tv' : 'movie';
        const officialTitle = this.normalizeCleanTitle(best.title || best.name);
        const origTitle = this.normalizeCleanTitle(best.original_title || best.original_name);
        const year = String(best.release_date || best.first_air_date || '').slice(0, 4) || preferredYear;

        if (!officialTitle) continue;

        const collectedAliases: string[] = [];
        if (origTitle && origTitle.toLowerCase() !== officialTitle.toLowerCase()) {
          collectedAliases.push(origTitle);
        }

        // 并发拉取多地区译名与别名（zh-TW / zh-HK / en-US / 别名）
        try {
          const [transData, altData] = await Promise.allSettled([
            tmdbGet(`/${mediaType}/${best.id}/translations`, {}),
            tmdbGet(`/${mediaType}/${best.id}/alternative_titles`, {}),
          ]);

          if (transData.status === 'fulfilled' && Array.isArray(transData.value?.translations)) {
            for (const tr of transData.value.translations) {
              const iso = `${tr.iso_639_1 || ''}-${tr.iso_3166_1 || ''}`;
              if (['zh-CN', 'zh-TW', 'zh-HK', 'en-US'].includes(iso)) {
                const t = tr.data?.title || tr.data?.name;
                if (t) collectedAliases.push(t);
              }
            }
          }

          if (altData.status === 'fulfilled') {
            const altList = altData.value?.titles || altData.value?.results || [];
            if (Array.isArray(altList)) {
              for (const alt of altList) {
                if (['CN', 'TW', 'HK', 'US', 'JP', 'KR'].includes(alt.iso_3166_1) && alt.title) {
                  collectedAliases.push(alt.title);
                }
              }
            }
          }
        } catch {
          // 补充别名失败不影响主片名返回
        }

        return {
          standardTitle: officialTitle,
          originalTitle: origTitle || undefined,
          aliases: this.buildUniqueAliases(officialTitle, collectedAliases),
          year: year || undefined,
          mediaType,
          overview: best.overview ? String(best.overview).trim() : undefined,
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
          headers: { 'User-Agent': 'WeSaver/1.0 (https://github.com/Level6me/wesaver)' },
          timeout: 3200,
        });
        const list = Array.isArray(resp.data?.list) ? resp.data.list : [];
        if (list.length === 0) continue;

        const exact =
          list.find(
            (item: any) =>
              this.normalizeCleanTitle(item.name_cn) === cleanQ || this.normalizeCleanTitle(item.name) === cleanQ
          ) || list[0];

        const cn = this.normalizeCleanTitle(exact?.name_cn);
        const orig = this.normalizeCleanTitle(exact?.name);
        if (!cn && !orig) continue;

        const primary = cn || orig;
        return {
          standardTitle: primary,
          originalTitle: orig && orig !== primary ? orig : undefined,
          aliases: this.buildUniqueAliases(primary, [orig]),
          year: exact?.air_date ? String(exact.air_date).slice(0, 4) : undefined,
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
  "originalTitle": "原语言标题（如日文/韩文/英文原名，不确定则留空）",
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
      const llmAliases = Array.isArray(parsed.aliases) ? parsed.aliases : [];

      return {
        standardTitle: standard,
        originalTitle: orig || undefined,
        aliases: this.buildUniqueAliases(standard, [
          ...llmAliases,
          orig,
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

    const cacheKey = [cleanOrig, cleanGuess, cleanQuery, input.year || ''].join('::').toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
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
      const tmdbRes = await this.resolveWithTmdb(rawCandidates, input.year);
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
   * AI 检索结果精准筛选：剔除同名异作（例如搜索《突如其来》误命中《突如其来的幸福》/其他年份同名片）、
   * 仅在推广页脚提及关键词的无关合集、以及短剧/电子书/音频资源
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

    const systemPrompt = `你是网盘影视资源精准审核专家。
给定用户真正想找的目标影视作品元信息，以及从 Telegram 频道按关键词抓取到的候选网盘资源列表，请严格甄别每一条候选资源是否真正属于目标作品本身！

剔除标准（务必严格）：
1. **同名异作 / 局部撞词**：标题只是包含了目标词的一部分（例如目标为《突如其来》，候选却是《突如其来的幸福》《突如其来的大雨》《突然的喜欢》等另一部作品）；
2. **年份/国家/类型明显不符**：例如目标为 2026 年日本电影，候选明确是 2010 年欧美片、国产微短剧、综艺、纪录片、小说电子书、音乐专辑、PPT 模板或频道广告合集；
3. **仅顺带提及**：目标词仅出现在频道尾部推荐列表或标签广告中，本帖主资源并非该作品。

保留标准：
- 标题或正文主资源确实对应目标作品本身（或已知外语原名/官方港台译名），即便标题带了年份、画质(4K/1080P)、字幕组前缀也应保留。
- 如果候选中没有任何条目是目标作品，请果断将 keepIndices 设为 []，宁缺毋滥，绝不放行错片！

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
}
