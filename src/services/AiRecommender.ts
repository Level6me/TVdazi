import OpenAI from 'openai';
import { UserManager } from './UserManager';
import { DoubanService, DoubanSubject } from './DoubanService';

export interface IntentSlots {
  count: number;
  isExplicitCount: boolean;
  timeScope: 'recent' | 'classic' | 'mixed';
  mediaType: 'movie' | 'tv';
  doubanTag: string;
  country?: string;
  genre?: string;
  rawQuery: string;
}

export interface RecommendItem {
  title: string;
  displayTitle: string;
  tags: string;
  rating: string;
  description: string;
}

export interface RecommendResult {
  title: string;
  items: RecommendItem[];
  formattedNote: string;
  subjects: DoubanSubject[];
  slots: IntentSlots;
}

export class AiRecommender {
  private static instance: AiRecommender;
  private userManager: UserManager;
  private doubanService: DoubanService;
  private globalApiKey: string;
  private globalBaseURL: string;
  private model: string;
  private globalClient: OpenAI;
  // 记录每个用户近期已推荐过的片名，实现“换一部/换一批”与多轮推荐自动去重
  private recommendedHistory: Map<string, Set<string>> = new Map();

  private constructor() {
    this.userManager = UserManager.getInstance();
    this.doubanService = new DoubanService();
    this.globalApiKey = process.env.DEEPSEEK_API_KEY || '';
    this.globalBaseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    this.globalClient = new OpenAI({
      apiKey: this.globalApiKey || 'dummy_key',
      baseURL: this.globalBaseURL,
      timeout: 10000,
    });
  }

  public static getInstance(): AiRecommender {
    if (!AiRecommender.instance) {
      AiRecommender.instance = new AiRecommender();
    }
    return AiRecommender.instance;
  }

  private getClientForUser(userId?: string): OpenAI {
    if (userId) {
      const plan = this.userManager.getUserPlan(userId);
      if (plan.deepseekApiKey) {
        return new OpenAI({
          apiKey: plan.deepseekApiKey,
          baseURL: this.globalBaseURL,
          timeout: 10000,
        });
      }
    }
    return this.globalClient;
  }

  /**
   * Stage 1: NLU 结构化意图槽位解析（提取数量、时效性、载体类型、地区、题材）
   */
  public parseIntentSlots(
    query: string = '',
    fallbackType: 'movie' | 'tv' = 'tv',
    fallbackTag: string = '热门'
  ): IntentSlots {
    const text = (query || fallbackTag || '').trim();

    // 1. 解析数量约束 (count)
    const cnNumMap: Record<string, number> = {
      一: 1,
      单: 1,
      两: 2,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    let count = 5;
    let isExplicitCount = false;

    const numMatch = text.match(/([0-9]{1,2}|[一单两二三四五六七八九十])\s*(?:部|个|条|本|出)/);
    if (numMatch && numMatch[1]) {
      const rawNum = numMatch[1];
      const parsed = /^[0-9]+$/.test(rawNum) ? parseInt(rawNum, 10) : cnNumMap[rawNum];
      if (parsed && parsed >= 1 && parsed <= 10) {
        count = parsed;
        isExplicitCount = true;
      }
    } else if (/(?:推荐部|来部|找部|看部|求部)/.test(text)) {
      count = 1;
      isExplicitCount = true;
    }

    // 2. 解析时效性约束 (timeScope)
    let timeScope: 'recent' | 'classic' | 'mixed' = 'mixed';
    if (
      /(?:最近|近期|新出|最新|今年|刚出|正在热映|院线|现在火|最近火|比较火|最火|流行|2025|2026)/.test(text)
    ) {
      timeScope = 'recent';
    } else if (/(?:经典|老片|以前|影史|封神|必看榜|天花板)/.test(text)) {
      timeScope = 'classic';
    }

    // 3. 解析载体类型 (mediaType & doubanTag)
    let mediaType: 'movie' | 'tv' = fallbackType;
    let doubanTag = mediaType === 'movie' ? '电影' : '电视剧';

    if (/(?:电影|大片|院线|影院|高分片|科幻片|动作片|恐怖片|喜剧片|爱情片)/.test(text)) {
      mediaType = 'movie';
      doubanTag = '电影';
    } else if (/(?:动漫|动画|番剧|日漫|国漫)/.test(text)) {
      mediaType = 'tv';
      doubanTag = '动画';
    } else if (/(?:综艺|真人秀)/.test(text)) {
      mediaType = 'tv';
      doubanTag = '综艺';
    } else if (/(?:纪录片)/.test(text)) {
      mediaType = 'tv';
      doubanTag = '纪录片';
    } else if (/(?:剧|韩剧|美剧|英剧|日剧|国产剧|连续剧|网剧)/.test(text)) {
      mediaType = 'tv';
      doubanTag = '电视剧';
    }

    // 4. 解析国家/地区偏好 (country)
    let country: string | undefined;
    const combined = `${text} ${fallbackTag}`;
    if (/韩剧|韩国/.test(combined)) country = '韩国';
    else if (/美剧|美国|好莱坞/.test(combined)) country = '美国';
    else if (/英剧|英国/.test(combined)) country = '英国';
    else if (/日剧|日本|日漫/.test(combined)) country = '日本';
    else if (/国产|华语|大陆|内地|国剧|国漫/.test(combined)) country = '中国大陆';
    else if (/港片|港剧|香港/.test(combined)) country = '中国香港';

    // 5. 解析题材偏好 (genre)
    let genre: string | undefined;
    if (/悬疑|推理|烧脑|破案|刑侦|侦探/.test(combined)) genre = '悬疑';
    else if (/科幻|太空|未来|赛博/.test(combined)) genre = '科幻';
    else if (/喜剧|搞笑|下饭|轻松|沙雕/.test(combined)) genre = '喜剧';
    else if (/爱情|甜宠|恋爱|浪漫|情侣/.test(combined)) genre = '爱情';
    else if (/动作|爽片|打斗|犯罪|黑帮/.test(combined)) genre = '动作';
    else if (/惊悚|恐怖|吓人|灵异/.test(combined)) genre = '惊悚';
    else if (/治愈|温情|感人|催泪|家庭/.test(combined)) genre = '剧情';
    else if (/奇幻|魔幻|仙侠/.test(combined)) genre = '奇幻';

    return {
      count,
      isExplicitCount,
      timeScope,
      mediaType,
      doubanTag,
      country,
      genre,
      rawQuery: text,
    };
  }

  /**
   * Stage 2 & 3: 多路实时候选集召回 + 已看去重与加权评分重排
   */
  private async recallAndRankCandidates(
    slots: IntentSlots,
    userId?: string,
    page: number = 1
  ): Promise<DoubanSubject[]> {
    // 收集该用户需要排除的已看/已推荐片单
    const excludeSet = new Set<string>();
    if (userId) {
      const plan = this.userManager.getUserPlan(userId);
      for (const w of plan.watchlist || []) {
        excludeSet.add(w.title.trim());
      }
      const hist = this.recommendedHistory.get(userId);
      if (hist) {
        for (const t of hist) excludeSet.add(t);
      }
    }

    const tasks: Promise<DoubanSubject[]>[] = [];

    if (slots.timeScope === 'recent') {
      // 近期热门/最新：多路并发召回 2025-2026 大众爆款 (sort=T) 与近期热度飙升 (sort=U)
      tasks.push(
        this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'T',
          countries: slots.country,
          genres: slots.genre,
          yearRange: '2025,2026',
          limit: 15,
        })
      );
      tasks.push(
        this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'U',
          countries: slots.country,
          genres: slots.genre,
          yearRange: '2025,2026',
          limit: 15,
        })
      );
      // 补充豆瓣实时热榜接口
      const hotTag = slots.country === '韩国' ? '韩剧' : slots.country === '美国' ? '美剧' : '热门';
      tasks.push(this.doubanService.getHotList(slots.mediaType, hotTag, 12, (page - 1) * 6));
    } else if (slots.timeScope === 'classic') {
      tasks.push(
        this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'S',
          countries: slots.country,
          genres: slots.genre,
          limit: 20,
        })
      );
    } else {
      tasks.push(
        this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'T',
          countries: slots.country,
          genres: slots.genre,
          limit: 15,
        })
      );
      tasks.push(
        this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'U',
          countries: slots.country,
          genres: slots.genre,
          yearRange: '2024,2026',
          limit: 10,
        })
      );
    }

    const results = await Promise.allSettled(tasks);
    const mergedMap = new Map<string, { subject: DoubanSubject; score: number }>();

    results.forEach((res, sourceIdx) => {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        res.value.forEach((item, rankIdx) => {
          const cleanTitle = (item.title || '').trim();
          if (!cleanTitle || excludeSet.has(cleanTitle)) return;

          const rateNum = parseFloat(item.rate) || 0;
          // 过滤评分过低的烂片（若已有评分且低于 6.0 则剔除）
          if (rateNum > 0 && rateNum < 6.0) return;

          // 综合打分公式：热度排名权重 + 豆瓣评分权重 + 多源交叉命中加分
          const popularityScore = Math.max(0, 20 - rankIdx) * (sourceIdx === 0 ? 1.5 : 1.0);
          const ratingBonus = rateNum > 0 ? rateNum * 2.5 : 15;
          const totalScore = popularityScore + ratingBonus;

          if (mergedMap.has(cleanTitle)) {
            const existing = mergedMap.get(cleanTitle)!;
            existing.score += 10; // 多路同时召回的热门佳作额外加权
            if (!existing.subject.actors && item.actors) {
              existing.subject.actors = item.actors;
            }
          } else {
            mergedMap.set(cleanTitle, { subject: item, score: totalScore });
          }
        });
      }
    });

    const ranked = Array.from(mergedMap.values())
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.subject);

    return ranked;
  }

  private recordRecommended(userId: string | undefined, items: RecommendItem[]): void {
    if (!userId) return;
    let set = this.recommendedHistory.get(userId);
    if (!set) {
      set = new Set<string>();
      this.recommendedHistory.set(userId, set);
    }
    // 若历史过长则重置，避免耗尽候选池
    if (set.size > 35) {
      set.clear();
    }
    for (const it of items) {
      if (it.title) set.add(it.title.trim());
    }
  }

  /**
   * Stage 4: 结合意图槽位与实时 Grounding 候选池生成精准推荐
   */
  async generateXiaohongshuNote(options: {
    query?: string;
    type?: 'movie' | 'tv';
    tag?: string;
    page?: number;
    userId?: string;
  }): Promise<RecommendResult> {
    const { query, type = 'tv', tag = '热门', page = 1, userId } = options;
    const slots = this.parseIntentSlots(query || '', type, tag);
    const client = this.getClientForUser(userId);

    // 实时多路召回豆瓣最新/最火候选集
    const candidates = await this.recallAndRankCandidates(slots, userId, page);
    const topCandidates = candidates.slice(0, Math.max(slots.count * 2, 10));

    const candidateContext =
      topCandidates.length > 0
        ? topCandidates
            .map(
              (c, i) =>
                `${i + 1}. 《${c.title}》${c.rate ? ` (豆瓣 ${c.rate}分)` : ' (近期新作)'}${
                  c.actors ? ` [主演: ${c.actors}]` : ''
                }`
            )
            .join('\n')
        : '';

    const targetTopic =
      slots.rawQuery || `${slots.country || ''}${slots.genre || ''}${slots.doubanTag}`;

    try {
      const prompt = `你是一个懂用户心意的智能影视推荐专家与小红书资深影视博主。
请严格根据【用户的真实意图与约束】进行精准影视推荐！

【用户原始需求】："${targetTopic}"
【解析出的硬性意图约束】：
- 要求推荐数量 (count)：必须精准推荐 **${slots.count}** 部！（严禁多推或少推，要求 ${slots.count} 部就只输出 ${slots.count} 部！）
- 时效性要求 (timeScope)：${
        slots.timeScope === 'recent'
          ? '【近期/最新爆款】用户明确要求“最近/近期比较火或新出”的作品！必须优先从下方【实时热榜候选池】中选择 2025-2026 近期热门作品，严禁拿几年前的老片充数！'
          : slots.timeScope === 'classic'
          ? '【口碑经典】优先推荐豆瓣高分封神代表作'
          : '【优质好片】兼顾近期高口碑与高人气佳作'
      }
- 载体与题材：${slots.doubanTag}${slots.country ? ` / 地区：${slots.country}` : ''}${
        slots.genre ? ` / 风格：${slots.genre}` : ''
      }

${
  candidateContext
    ? `【豆瓣实时召回的最新/热门候选池（真实数据参考）】：\n${candidateContext}\n（请优先从以上实时候选池中挑选最匹配用户意图的 ${slots.count} 部作品进行深度种草介绍！）`
    : ''
}

【输出内容要求】：
1. 数量绝对服从：items 数组长度必须严格等于 ${slots.count}；
2. 每部作品包含：
   - title: 标准中文片名（不带书名号，用于后续自动搜网盘，如 "哪吒之魔童闹海"）
   - displayTitle: ${
     slots.count === 1
       ? '片名展示（如 "🎬《哪吒之魔童闹海》(2025)"）'
       : '带序号片名展示（如 "1.《哪吒之魔童闹海》"）'
   }
   - tags: 精准细分标签（如 "电影｜动画｜奇幻｜近期爆款"）
   - rating: 真实豆瓣评分与主演信息（如 "⭐ 豆瓣 8.4分｜主演：吕艳婷 / 囧森瑟夫"）
   - description: 灵魂种草推荐语（2~3句讲透核心看点、为什么最近火、情绪爽点或氛围感，绝不剧透，自然生动）。

请输出严格 JSON 格式：
{
  "title": "${
    slots.count === 1
      ? '🎯 为你精选近期最火的 1 部电影'
      : '🍿 精选高分影视种草清单'
  }",
  "items": [
    {
      "title": "标准中文片名",
      "displayTitle": "...",
      "tags": "...",
      "rating": "...",
      "description": "..."
    }
  ]
}`;

      const res = await client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.5,
      });

      const raw = res.choices[0]?.message?.content?.trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.items && Array.isArray(parsed.items) && parsed.items.length > 0) {
          // 强制截断为 slots.count，确保 100% 遵守数量约束
          const slicedItems = parsed.items.slice(0, slots.count);
          const items: RecommendItem[] = slicedItems.map((it: any, idx: number) => {
            const rawTitle = (it.title || '').replace(/[《》""''「」]/g, '').trim();
            let cleanDisplay = it.displayTitle || `《${rawTitle}》`;
            if (slots.count > 1) {
              cleanDisplay = cleanDisplay.replace(/^\d+[\.、]\s*/, '');
              if (!cleanDisplay.startsWith(`${idx + 1}.`)) {
                cleanDisplay = `${idx + 1}.${cleanDisplay}`;
              }
            }
            return {
              title: rawTitle,
              displayTitle: cleanDisplay,
              tags: it.tags || `${slots.doubanTag}｜热门推荐`,
              rating: it.rating || '⭐ 豆瓣高分推荐',
              description: it.description || '',
            };
          });

          this.recordRecommended(userId, items);

          const formattedNote = this.formatNoteOutput(parsed.title, items, slots, page);
          const subjects: DoubanSubject[] = items.map((it) => ({
            id: it.title,
            title: it.title,
            rate: it.rating.replace(/[^0-9\.]/g, '') || '8.5',
            cover: '',
            url: '',
          }));

          return {
            title: parsed.title || '',
            items,
            formattedNote,
            subjects,
            slots,
          };
        }
      }
    } catch (err: any) {
      console.warn('[AiRecommender] DeepSeek 生成推荐异常，使用实时召回兜底:', err.message);
    }

    return this.buildFallbackFromCandidates(topCandidates, slots, page, userId);
  }

  /**
   * 根据单部 (count=1) 或多部 (count>1) 自适应排版输出
   */
  private formatNoteOutput(
    customTitle: string | undefined,
    items: RecommendItem[],
    slots: IntentSlots,
    page: number
  ): string {
    if (slots.count === 1 && items.length === 1) {
      const it = items[0];
      const header =
        customTitle ||
        `🎯 按你的要求，为你精选了 1 部${slots.timeScope === 'recent' ? '近期最火的' : '高分'}${slots.doubanTag}：`;
      let text = `${header}\n----------------------------------------\n\n`;
      text += `${it.displayTitle.startsWith('🎬') ? it.displayTitle : `🎬 ${it.displayTitle}`}\n`;
      if (it.tags) text += `🏷️ ${it.tags}\n`;
      if (it.rating) text += `${it.rating}\n`;
      if (it.description) text += `🔥 推荐理由：${it.description}\n\n`;
      text += `----------------------------------------\n`;
      text += `💡 想看这部直接回复「1」或「转存」，我马上全网为你搜夸克网盘活链一键存入！\n`;
      text += `✨ 如果这部看过了，回复「换一部」立马为你换下一部；回复「取消」退出。`;
      return text.trim();
    }

    const noteTitle = customTitle || `🍿 精选【${slots.rawQuery || slots.doubanTag}】推荐笔记`;
    const batchSuffix = page > 1 ? ` (第 ${page} 批)` : '';
    let noteText = `${noteTitle}${batchSuffix}\n----------------------------------------\n\n`;

    items.forEach((it) => {
      noteText += `${it.displayTitle}\n`;
      if (it.tags) noteText += `${it.tags}\n`;
      if (it.rating) noteText += `${it.rating}\n`;
      if (it.description) noteText += `${it.description}\n`;
      noteText += `\n`;
    });

    noteText += `----------------------------------------\n`;
    noteText += `💡 想看哪一部直接回复数字（如「1」或「看第2个」），我马上为你全网搜网盘活链一键存入！\n`;
    noteText += `✨ 回复「换一批」换新推荐；回复「取消」退出。`;
    return noteText.trim();
  }

  /**
   * 兜底方案：直接基于实时召回的豆瓣候选集生成响应（同样严格遵守 count 约束）
   */
  private buildFallbackFromCandidates(
    candidates: DoubanSubject[],
    slots: IntentSlots,
    page: number,
    userId?: string
  ): RecommendResult {
    const picked = (
      candidates.length > 0
        ? candidates
        : [
            { id: '1', title: '哪吒之魔童闹海', rate: '8.4', cover: '', url: '', actors: '吕艳婷 / 囧森瑟夫' },
            { id: '2', title: '好东西', rate: '8.9', cover: '', url: '', actors: '宋佳 / 钟楚曦' },
            { id: '3', title: '疯狂动物城2', rate: '8.3', cover: '', url: '', actors: '金妮弗·古德温' },
          ]
    ).slice(0, slots.count);

    const items: RecommendItem[] = picked.map((s, idx) => ({
      title: s.title,
      displayTitle: slots.count === 1 ? `《${s.title}》` : `${idx + 1}.《${s.title}》`,
      tags: `${slots.country || ''}${slots.genre || slots.doubanTag}｜${
        slots.timeScope === 'recent' ? '近期爆款' : '高分推荐'
      }`,
      rating: `${s.rate ? `⭐ 豆瓣 ${s.rate}分` : '⭐ 近期高热度'}${s.actors ? `｜主演：${s.actors}` : ''}`,
      description: `近期全网热度与口碑兼具的诚意佳作，剧情节奏紧凑，视听与情绪体验极佳！`,
    }));

    this.recordRecommended(userId, items);
    const formattedNote = this.formatNoteOutput(undefined, items, slots, page);

    return {
      title: formattedNote.split('\n')[0],
      items,
      formattedNote,
      subjects: picked,
      slots,
    };
  }
}
