import OpenAI from 'openai';
import { UserManager } from './UserManager';
import { DoubanService, DoubanSubject } from './DoubanService';

export type TimeScope = 'current_season' | 'this_year' | 'last_year' | 'custom_year' | 'classic' | 'mixed';

export interface IntentSlots {
  count: number;
  isExplicitCount: boolean;
  timeScope: TimeScope;
  yearRange?: [number, number];
  dateHint?: string;
  mediaType: 'movie' | 'tv';
  doubanTag: string;
  country?: string;
  genre?: string;
  subTheme?: string;
  excludeGenres: string[];
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
  // 记录每个用户上一次推荐的意图槽位，用于多轮追问（如“换一部悬疑的”、“不要古装的”）自动继承上下文
  private lastUserSlots: Map<string, IntentSlots> = new Map();

  private constructor() {
    this.userManager = UserManager.getInstance();
    this.doubanService = new DoubanService();
    this.globalApiKey = process.env.DEEPSEEK_API_KEY || '';
    this.globalBaseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    this.globalClient = new OpenAI({
      apiKey: this.globalApiKey || 'dummy_key',
      baseURL: this.globalBaseURL,
      timeout: 12000,
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
      const activeKey = plan.deepseekApiKey?.trim() || plan.inheritedApiKey?.trim();
      if (activeKey) {
        return new OpenAI({
          apiKey: activeKey,
          baseURL: this.globalBaseURL,
          timeout: 12000,
        });
      }
    }
    return this.globalClient;
  }

  private getCurrentYearAndMonth(): { year: number; month: number } {
    const now = new Date();
    const year = now.getFullYear() >= 2026 ? now.getFullYear() : 2026;
    const month = now.getMonth() + 1;
    return { year, month };
  }

  /**
   * Stage 1: 结合多轮上下文的意图理解与槽位解析
   */
  public parseIntentSlots(
    query: string = '',
    fallbackType: 'movie' | 'tv' = 'tv',
    fallbackTag: string = '热门',
    userId?: string
  ): IntentSlots {
    const text = (query || fallbackTag || '').trim();
    const prevSlots = userId ? this.lastUserSlots.get(userId) : undefined;
    const isFollowUp =
      Boolean(prevSlots) &&
      (text.length <= 16 || /(?:换|那|别的|其他|不要|再来|有.*吗|呢)/.test(text)) &&
      !/(?:电影|电视剧|韩剧|美剧|英剧|日剧|国产剧|动漫|综艺)/.test(text);

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
    let count = isFollowUp && prevSlots ? prevSlots.count : 4;
    let isExplicitCount = isFollowUp && prevSlots ? prevSlots.isExplicitCount : false;

    const numMatch = text.match(/([0-9]{1,2}|[一单两二三四五六七八九十])\s*(?:部|个|条|本|出)/);
    if (numMatch && numMatch[1]) {
      const rawNum = numMatch[1];
      const parsed = /^[0-9]+$/.test(rawNum) ? parseInt(rawNum, 10) : cnNumMap[rawNum];
      if (parsed && parsed >= 1 && parsed <= 10) {
        count = parsed;
        isExplicitCount = true;
      }
    } else if (/(?:推荐部|来部|找部|看部|求部|推一部|换一部|再来一部|就一部)/.test(text)) {
      count = 1;
      isExplicitCount = true;
    }

    // 2. 解析细粒度时效性约束、指定年份/年代区间与月份档期 (timeScope, yearRange, dateHint)
    const { year: currentYear } = this.getCurrentYearAndMonth();
    let timeScope: TimeScope = isFollowUp && prevSlots ? prevSlots.timeScope : 'mixed';
    let yearRange: [number, number] | undefined = isFollowUp && prevSlots ? prevSlots.yearRange : undefined;
    let dateHint: string | undefined = isFollowUp && prevSlots ? prevSlots.dateHint : undefined;

    // 提取档期与具体月份提示 (如“暑期档”、“春节档”、“下半年”、“10月”)
    const dateHintMatch = text.match(
      /(?:春节档|暑期档|国庆档|贺岁档|五一档|跨年|上半年|下半年|年初|年底|春天|春季|夏天|夏季|秋天|秋季|冬天|冬季|(?:1[0-2]|[1-9])月份?)/
    );
    if (dateHintMatch) {
      dateHint = dateHintMatch[0];
    }

    // 2.1 匹配明确年份区间：如 "2018到2022"、"2015-2020年"、"2010至2015"
    const rangeMatch = text.match(/(19[7-9]\d|20[0-2]\d)\s*(?:年)?\s*(?:到|至|-|~|—|～)\s*(19[7-9]\d|20[0-2]\d)/);
    // 2.2 匹配年代：如 "90年代"、"80年代"、"00年代"
    const decadeMatch = text.match(/([789012]0)\s*年代/);
    // 2.3 匹配明确单一年份：如 "2019年"、"2023的"、"1994"
    const singleYearMatch = text.match(/(?:^|[^0-9])(19[7-9]\d|20[0-2]\d)\s*(?:年|年度|的)?/);
    // 2.4 匹配两位数年份简称：如 "19年的"、"21年"、"94年"
    const shortYearMatch = text.match(/(?:^|[^0-9])([89]\d|0\d|1\d|2[0-6])\s*年/);

    if (rangeMatch) {
      const y1 = parseInt(rangeMatch[1], 10);
      const y2 = parseInt(rangeMatch[2], 10);
      yearRange = [Math.min(y1, y2), Math.max(y1, y2)];
      timeScope = 'custom_year';
    } else if (decadeMatch) {
      const dec = decadeMatch[1];
      const startY = dec.startsWith('0') || dec.startsWith('1') || dec.startsWith('2') ? 2000 + parseInt(dec, 10) : 1900 + parseInt(dec, 10);
      yearRange = [startY, Math.min(currentYear, startY + 9)];
      timeScope = 'custom_year';
    } else if (
      /(?:这两个月|近两个月|最近一两个月|这阵子|这个月|上个月|最近正在播|正在热播|正在播|刚出|刚播|新出|最新|现在最火|最近比较火|最近最火|近期比较火|近期最火|最近火|近期火|院线|正在上映)/.test(
        text
      )
    ) {
      timeScope = 'current_season';
      yearRange = [currentYear, currentYear];
    } else if (singleYearMatch) {
      const y = parseInt(singleYearMatch[1], 10);
      if (y === currentYear && !dateHint) {
        timeScope = 'this_year';
        yearRange = [currentYear, currentYear];
      } else {
        timeScope = 'custom_year';
        yearRange = [y, y];
      }
    } else if (shortYearMatch) {
      const sy = parseInt(shortYearMatch[1], 10);
      const fullY = sy >= 70 ? 1900 + sy : 2000 + sy;
      timeScope = fullY === currentYear && !dateHint ? 'this_year' : 'custom_year';
      yearRange = [fullY, fullY];
    } else if (/(?:近三年|最近三年|这三年)/.test(text)) {
      timeScope = 'custom_year';
      yearRange = [currentYear - 2, currentYear];
    } else if (/(?:近五年|最近五年|这五年)/.test(text)) {
      timeScope = 'custom_year';
      yearRange = [currentYear - 4, currentYear];
    } else if (/(?:前年)/.test(text)) {
      timeScope = 'custom_year';
      yearRange = [currentYear - 2, currentYear - 2];
    } else if (/(?:前两年|前几年)/.test(text)) {
      timeScope = 'custom_year';
      yearRange = [currentYear - 3, currentYear - 1];
    } else if (/(?:今年|本年度)/.test(text)) {
      timeScope = dateHint ? 'custom_year' : 'this_year';
      yearRange = [currentYear, currentYear];
    } else if (/(?:去年)/.test(text)) {
      timeScope = 'last_year';
      yearRange = [currentYear - 1, currentYear - 1];
    } else if (/(?:经典|老片|以前|影史|封神|必看榜|天花板|高分经典)/.test(text)) {
      timeScope = 'classic';
      yearRange = undefined;
    } else if (/(?:最近|近期)/.test(text)) {
      timeScope = 'current_season';
      yearRange = [currentYear, currentYear];
    } else if (dateHint && !yearRange) {
      timeScope = 'custom_year';
      yearRange = [currentYear, currentYear];
    }

    // 3. 解析载体类型 (mediaType & doubanTag)
    let mediaType: 'movie' | 'tv' = isFollowUp && prevSlots ? prevSlots.mediaType : fallbackType;
    let doubanTag = isFollowUp && prevSlots ? prevSlots.doubanTag : mediaType === 'movie' ? '电影' : '电视剧';

    if (/(?:电影|大片|院线|影院|高分片|科幻片|动作片|恐怖片|喜剧片|爱情片|悬疑片|犯罪片|战争片|灾难片|港片)/.test(text)) {
      mediaType = 'movie';
      doubanTag = '电影';
    } else if (/(?:动漫|动画|番剧|日漫|国漫)/.test(text)) {
      mediaType = 'tv';
      doubanTag = '动画';
    } else if (/(?:综艺|真人秀|脱口秀|恋综)/.test(text)) {
      mediaType = 'tv';
      doubanTag = '综艺';
    } else if (/(?:纪录片)/.test(text)) {
      mediaType = 'tv';
      doubanTag = '纪录片';
    } else if (/(?:剧|韩剧|美剧|英剧|日剧|国产剧|港剧|台剧|泰剧|连续剧|网剧)/.test(text)) {
      mediaType = 'tv';
      doubanTag = '电视剧';
    }

    // 4. 解析国家/地区偏好 (country，支持豆瓣 14+ 常见国家地区)
    let country: string | undefined = isFollowUp && prevSlots ? prevSlots.country : undefined;
    const combined = `${text} ${fallbackTag}`;
    if (/韩剧|韩国|韩影/.test(combined)) country = '韩国';
    else if (/美剧|美国|好莱坞/.test(combined)) country = '美国';
    else if (/英剧|英国/.test(combined)) country = '英国';
    else if (/日剧|日本|日漫|日影/.test(combined)) country = '日本';
    else if (/国产|华语|大陆|内地|国剧|国漫/.test(combined)) country = '中国大陆';
    else if (/港片|港剧|香港/.test(combined)) country = '中国香港';
    else if (/台剧|台湾/.test(combined)) country = '中国台湾';
    else if (/泰剧|泰国/.test(combined)) country = '泰国';
    else if (/法国|法剧/.test(combined)) country = '法国';
    else if (/印度/.test(combined)) country = '印度';
    else if (/西班牙/.test(combined)) country = '西班牙';
    else if (/德国/.test(combined)) country = '德国';
    else if (/意大利/.test(combined)) country = '意大利';
    else if (/俄罗斯|苏联/.test(combined)) country = '俄罗斯';

    // 5. 解析否定题材约束 (excludeGenres)、豆瓣标准类型 (genre) 与细分题材标签 (subTheme)
    const excludeGenres: string[] = isFollowUp && prevSlots ? [...prevSlots.excludeGenres] : [];
    const allGenres = [
      { key: '古装', pattern: /古装|仙侠|古偶|宫斗/ },
      { key: '爱情', pattern: /爱情|甜宠|恋爱|偶像/ },
      { key: '悬疑', pattern: /悬疑|推理|烧脑|破案|刑侦/ },
      { key: '犯罪', pattern: /犯罪|黑帮|警匪|扫黑/ },
      { key: '恐怖', pattern: /惊悚|恐怖|吓人|灵异|鬼片/ },
      { key: '喜剧', pattern: /喜剧|搞笑|沙雕|无厘头/ },
      { key: '科幻', pattern: /科幻|太空|赛博|外星|机甲/ },
      { key: '动作', pattern: /动作|打斗|格斗|爽片/ },
      { key: '武侠', pattern: /武侠|江湖/ },
      { key: '奇幻', pattern: /奇幻|魔幻|玄幻/ },
      { key: '冒险', pattern: /冒险|探险|盗墓/ },
      { key: '灾难', pattern: /灾难|末日|丧尸/ },
      { key: '历史', pattern: /历史|年代|朝代/ },
      { key: '战争', pattern: /战争|抗战|军旅|谍战/ },
      { key: '传记', pattern: /传记|真实事件|真实改编/ },
      { key: '家庭', pattern: /家庭|亲情|生活|伦理/ },
      { key: '运动', pattern: /运动|体育|竞技|热血/ },
      { key: '音乐', pattern: /音乐|歌舞/ },
      { key: '动画', pattern: /动画|动漫/ },
    ];

    for (const g of allGenres) {
      const negRegex = new RegExp(`(?:不要|别推|不看|不喜欢|除了)[^，。！？]*?${g.pattern.source}`);
      if (negRegex.test(text) && !excludeGenres.includes(g.key)) {
        excludeGenres.push(g.key);
      }
    }
    if (/现代剧|都市剧|现代都市/.test(text) && !excludeGenres.includes('古装')) {
      excludeGenres.push('古装');
    }

    let genre: string | undefined;
    for (const g of allGenres) {
      if (g.pattern.test(combined) && !excludeGenres.includes(g.key)) {
        genre = g.key;
        break;
      }
    }
    if (!genre && /治愈|温情|感人|催泪|群像|烟火气|人性|女性|职场|医疗|律政|校园|青春/.test(combined)) {
      genre = '剧情';
    }

    // 提取细分微题材（用于提示词精准引导与短评匹配加权）
    const subThemeMatch = text.match(
      /(?:无限流|时间循环|穿越|重生|丧尸|末日|权谋|宫斗|宅斗|刑侦|破案|法医|扫黑|缉毒|盗墓|谍战|职场|医疗|律政|校园|青春|暗恋|破镜重圆|先婚后爱|电竞|年代剧|大女主|女性群像|家庭群像|复仇|爽剧|下饭|治愈|催泪|赛博朋克|克苏鲁)/
    );
    const subTheme = subThemeMatch ? subThemeMatch[0] : undefined;

    const slots: IntentSlots = {
      count,
      isExplicitCount,
      timeScope,
      yearRange,
      dateHint,
      mediaType,
      doubanTag,
      country,
      genre,
      subTheme,
      excludeGenres,
      rawQuery: text,
    };

    if (userId) {
      this.lastUserSlots.set(userId, slots);
    }
    return slots;
  }

  /**
   * 映射豆瓣实时热播榜 (search_subjects) 的最匹配 tag
   */
  private resolveDoubanHotTag(slots: IntentSlots): string {
    if (slots.mediaType === 'tv') {
      if (slots.doubanTag === '综艺') return '综艺';
      if (slots.doubanTag === '动画') return '日本动画';
      if (slots.doubanTag === '纪录片') return '纪录片';
      if (slots.country === '中国大陆') return '国产剧';
      if (slots.country === '韩国') return '韩剧';
      if (slots.country === '美国') return '美剧';
      if (slots.country === '英国') return '英剧';
      if (slots.country === '日本') return '日剧';
      if (slots.country === '中国香港') return '港剧';
      return '热门';
    } else {
      if (slots.country === '中国大陆' || slots.country === '中国香港') return '华语';
      if (slots.country === '韩国') return '韩国';
      if (slots.country === '日本') return '日本';
      if (slots.country === '美国' || slots.country === '英国') return '欧美';
      if (slots.genre && ['动作', '喜剧', '爱情', '科幻', '悬疑', '恐怖'].includes(slots.genre)) {
        return slots.genre;
      }
      return '热门';
    }
  }

  /**
   * Stage 2 & 3: 多路实时候选集召回 + 豆瓣详情摘要(年份/类型/短评)增强 + 严格时间与题材过滤重排
   */
  public async recallAndRankCandidates(
    slots: IntentSlots,
    userId?: string,
    page: number = 1
  ): Promise<DoubanSubject[]> {
    const { year: currentYear } = this.getCurrentYearAndMonth();
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

    const hotTag = this.resolveDoubanHotTag(slots);
    const tasks: Array<{ promise: Promise<DoubanSubject[]>; weight: number }> = [];

    if (slots.timeScope === 'current_season') {
      // 【这两个月/最近正在热播/最新】：
      // 第一优先级：豆瓣实时热播榜 (search_subjects)，代表当前 1~2 个月内正在热播的剧集/电影
      tasks.push({
        promise: this.doubanService.getHotList(slots.mediaType, hotTag, 16, 0),
        weight: 2.2,
      });
      // 第二优先级：豆瓣近期热度趋势榜 (sort=U)，严格限定当年 (2026,2026)，绝不混入 2025 旧作
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'U',
          countries: slots.country,
          genres: slots.genre,
          yearRange: `${currentYear},${currentYear}`,
          limit: 16,
        }),
        weight: 1.6,
      });
      if (slots.mediaType === 'movie') {
        tasks.push({
          promise: this.doubanService.getHotList('movie', '最新', 12, 0),
          weight: 1.5,
        });
      }
    } else if (slots.timeScope === 'this_year') {
      // 【今年/2026年】：限定当年 (2026,2026)，兼顾近期热度 (U) 与年度爆款 (T)
      tasks.push({
        promise: this.doubanService.getHotList(slots.mediaType, hotTag, 15, 0),
        weight: 1.8,
      });
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'U',
          countries: slots.country,
          genres: slots.genre,
          yearRange: `${currentYear},${currentYear}`,
          limit: 15,
        }),
        weight: 1.6,
      });
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'T',
          countries: slots.country,
          genres: slots.genre,
          yearRange: `${currentYear},${currentYear}`,
          limit: 15,
        }),
        weight: 1.5,
      });
    } else if (slots.timeScope === 'last_year') {
      const lastYear = currentYear - 1;
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'T',
          countries: slots.country,
          genres: slots.genre,
          yearRange: `${lastYear},${lastYear}`,
          limit: 16,
        }),
        weight: 1.8,
      });
    } else if (slots.timeScope === 'custom_year' && slots.yearRange) {
      const [yStart, yEnd] = slots.yearRange;
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'T',
          countries: slots.country,
          genres: slots.genre,
          yearRange: `${yStart},${yEnd}`,
          limit: 18,
        }),
        weight: 2.0,
      });
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'S',
          countries: slots.country,
          genres: slots.genre,
          yearRange: `${yStart},${yEnd}`,
          limit: 15,
        }),
        weight: 1.6,
      });
      if (yEnd >= currentYear - 1) {
        tasks.push({
          promise: this.doubanService.getAdvancedCandidates({
            tags: slots.doubanTag,
            sort: 'U',
            countries: slots.country,
            genres: slots.genre,
            yearRange: `${yStart},${yEnd}`,
            limit: 14,
          }),
          weight: 1.5,
        });
      }
    } else if (slots.timeScope === 'classic') {
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'S',
          countries: slots.country,
          genres: slots.genre,
          limit: 20,
        }),
        weight: 1.8,
      });
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'T',
          countries: slots.country,
          genres: slots.genre,
          limit: 15,
        }),
        weight: 1.4,
      });
    } else {
      // 默认 mixed：优先当前热播 + 当年佳作 + 近年口碑爆款
      tasks.push({
        promise: this.doubanService.getHotList(slots.mediaType, hotTag, 14, 0),
        weight: 1.8,
      });
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'U',
          countries: slots.country,
          genres: slots.genre,
          yearRange: `${currentYear},${currentYear}`,
          limit: 14,
        }),
        weight: 1.5,
      });
      tasks.push({
        promise: this.doubanService.getAdvancedCandidates({
          tags: slots.doubanTag,
          sort: 'T',
          countries: slots.country,
          genres: slots.genre,
          yearRange: `${currentYear - 1},${currentYear}`,
          limit: 12,
        }),
        weight: 1.1,
      });
    }

    const settled = await Promise.allSettled(tasks.map((t) => t.promise));
    const mergedMap = new Map<string, { subject: DoubanSubject; score: number }>();

    settled.forEach((res, idx) => {
      const weight = tasks[idx].weight;
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        res.value.forEach((item, rankIdx) => {
          const cleanTitle = (item.title || '').trim();
          if (!cleanTitle || excludeSet.has(cleanTitle)) return;

          const rateNum = parseFloat(item.rate) || 0;
          // 剔除已出分且评分过低的烂片
          if (rateNum > 0 && rateNum < 6.2) return;

          const rankScore = Math.max(0, 20 - rankIdx) * weight;
          // 已出高分的当季剧集给予适当口碑加成，未出分的刚开播新剧给予基础热度分
          const ratingBonus = rateNum >= 7.0 ? rateNum * 2.8 : rateNum > 0 ? rateNum * 1.8 : 16;
          const totalScore = rankScore + ratingBonus;

          if (mergedMap.has(cleanTitle)) {
            const existing = mergedMap.get(cleanTitle)!;
            existing.score += 14; // 多路同时命中的当季爆款大幅加权
            if (!existing.subject.actors && item.actors) existing.subject.actors = item.actors;
            if (!existing.subject.id && item.id) existing.subject.id = item.id;
          } else {
            mergedMap.set(cleanTitle, { subject: { ...item }, score: totalScore });
          }
        });
      }
    });

    const initialRanked = Array.from(mergedMap.values()).sort((a, b) => b.score - a.score);
    const topPool = initialRanked.slice(0, 14);

    // 并发拉取豆瓣单条目真实详情摘要 (release_year / types / actors / shortComment)
    await Promise.allSettled(
      topPool.map(async (entry) => {
        const abs = await this.doubanService.getSubjectAbstract(entry.subject.id);
        if (abs) {
          if (abs.year) entry.subject.year = abs.year;
          if (abs.rate && !entry.subject.rate) entry.subject.rate = abs.rate;
          if (abs.types && abs.types.length > 0) entry.subject.types = abs.types;
          if (abs.region) entry.subject.region = abs.region;
          if (abs.actors) entry.subject.actors = abs.actors;
          if (abs.directors) entry.subject.directors = abs.directors;
          if (abs.episodesCount) entry.subject.episodesCount = abs.episodesCount;
          if (abs.shortComment) entry.subject.shortComment = abs.shortComment;
        }
      })
    );

    // 基于真实详情元数据进行硬性过滤与精准加权
    const verified: Array<{ subject: DoubanSubject; score: number }> = [];
    for (const entry of topPool) {
      const sub = entry.subject;
      const itemYear = sub.year ? parseInt(sub.year, 10) : currentYear;
      const types = sub.types || [];

      // 1. 严格年份过滤：
      // - 如果用户要求“这两个月/最近/今年”，绝不允许混入 2025 及以前的旧剧！
      // - 如果用户指定了明确年份或年代区间 (custom_year)，严格过滤在该年份区间内！
      if ((slots.timeScope === 'current_season' || slots.timeScope === 'this_year') && itemYear < currentYear) {
        continue;
      }
      if (slots.timeScope === 'last_year' && itemYear !== currentYear - 1) {
        continue;
      }
      if (slots.timeScope === 'custom_year' && slots.yearRange && sub.year) {
        const [yStart, yEnd] = slots.yearRange;
        if (itemYear < yStart || itemYear > yEnd) {
          continue;
        }
      }

      // 2. 严格载体过滤：如果用户搜的是电视剧（如国产剧/韩剧/美剧），自动剔除混在热榜里的真人秀/综艺
      if (
        slots.doubanTag === '电视剧' &&
        (types.includes('真人秀') || types.includes('脱口秀') || types.includes('歌舞'))
      ) {
        continue;
      }

      // 3. 否定题材过滤：如果用户明确说“不要古装/现代剧”等，剔除对应题材
      if (slots.excludeGenres.length > 0 && types.some((t) => slots.excludeGenres.includes(t))) {
        continue;
      }

      // 4. 正向题材与细分微题材匹配加分
      if (slots.genre && types.includes(slots.genre)) {
        entry.score += 25;
      }
      if (slots.subTheme && (sub.shortComment?.includes(slots.subTheme) || sub.title.includes(slots.subTheme))) {
        entry.score += 20;
      }

      // 5. 有真实高分 (≥7.5) 且有短评的剧集优先排在最前，保证推荐质量与说服力
      const rNum = parseFloat(sub.rate) || 0;
      if (rNum >= 7.5) {
        entry.score += 10;
      }

      verified.push(entry);
    }

    verified.sort((a, b) => b.score - a.score);
    return verified.map((v) => v.subject);
  }

  private recordRecommended(userId: string | undefined, titles: string[]): void {
    if (!userId) return;
    let set = this.recommendedHistory.get(userId);
    if (!set) {
      set = new Set<string>();
      this.recommendedHistory.set(userId, set);
    }
    if (set.size > 35) {
      set.clear();
    }
    for (const t of titles) {
      const clean = t.replace(/[《》""''「」]/g, '').trim();
      if (clean) set.add(clean);
    }
  }

  /**
   * Stage 4: 理解用户真实意图 + 基于豆瓣实时核验数据生成自然、走心的对话式推荐（拒绝机械模板）
   */
  async generateXiaohongshuNote(options: {
    query?: string;
    type?: 'movie' | 'tv';
    tag?: string;
    page?: number;
    userId?: string;
    chatHistory?: any[];
  }): Promise<RecommendResult> {
    const { query, type = 'tv', tag = '热门', page = 1, userId, chatHistory = [] } = options;
    const { year: currentYear, month: currentMonth } = this.getCurrentYearAndMonth();
    const slots = this.parseIntentSlots(query || '', type, tag, userId);
    const client = this.getClientForUser(userId);

    // 实时召回并经豆瓣 subject_abstract 核验的候选池
    const candidates = await this.recallAndRankCandidates(slots, userId, page);
    const topCandidates = candidates.slice(0, Math.max(slots.count * 2 + 2, 8));

    const candidateContext =
      topCandidates.length > 0
        ? topCandidates
            .map((c, i) => {
              const yearStr = c.year || (slots.yearRange ? String(slots.yearRange[0]) : String(currentYear));
              const rateStr = c.rate ? `豆瓣 ${c.rate}分` : '刚开播热播中(暂未出分)';
              const typeStr = c.types && c.types.length > 0 ? c.types.join('/') : slots.doubanTag;
              const actorStr = c.actors ? `主演: ${c.actors}` : '';
              const epStr = c.episodesCount ? `共${c.episodesCount}集` : '';
              const commentStr = c.shortComment ? `豆瓣真实热评: "${c.shortComment}"` : '';
              return `${i + 1}. 《${c.title}》 | 年份: ${yearStr}年 | 评分: ${rateStr} | 类型: ${typeStr}${
                epStr ? ` | ${epStr}` : ''
              }${actorStr ? ` | ${actorStr}` : ''}${commentStr ? ` | ${commentStr}` : ''}`;
            })
            .join('\n')
        : '';

    const recentHistoryText =
      chatHistory.length > 0
        ? chatHistory
            .slice(-4)
            .map((m: any) => `${m.role === 'user' ? 'user' : 'assistant'}: ${String(m.content || '').slice(0, 120)}`)
            .join('\n')
        : '';

    const customYearLabel = slots.yearRange
      ? slots.yearRange[0] === slots.yearRange[1]
        ? `${slots.yearRange[0]}年`
        : `${slots.yearRange[0]}~${slots.yearRange[1]}年`
      : '';

    const timeDescMap: Record<TimeScope, string> = {
      current_season: `【当前当季正在热播 / 近一两个月（${currentYear}年${Math.max(1, currentMonth - 1)}~${currentMonth}月）最火新作】`,
      this_year: `【今年（${currentYear}年）${slots.dateHint || ''}热门佳作】`,
      last_year: `【去年（${currentYear - 1}年）${slots.dateHint || ''}热门作品】`,
      custom_year: `【用户明确指定的年份/档期：${customYearLabel}${slots.dateHint ? ` ${slots.dateHint}` : ''}】`,
      classic: `【高分经典必看口碑作】`,
      mixed: `【近期热门与高口碑佳作】`,
    };

    const genreAndThemeHint = [
      slots.country ? `地区:${slots.country}` : '',
      slots.genre ? `类型:${slots.genre}` : '',
      slots.subTheme ? `细分题材:${slots.subTheme}` : '',
      slots.dateHint ? `档期/月份:${slots.dateHint}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    try {
      const prompt = `你是一个真正能听懂人话、懂影视、像微信好友一样自然聊天的影视达人。
请仔细理解用户的这句话，并结合下方【豆瓣实时核验片单】给出最贴合他心意的回复！

【当前真实时间】：${currentYear}年${currentMonth}月（注意：今年是 ${currentYear} 年！）
${recentHistoryText ? `【近期对话上下文】：\n${recentHistoryText}\n` : ''}
【用户当前说的原话】："${slots.rawQuery}"
${genreAndThemeHint ? `【提取到的细分维度】：${genreAndThemeHint}\n` : ''}
【你必须遵守的核心原则】：
1. **真正理解用户的意思，拒绝机械式套格式**：
   - 绝对不要输出冷冰冰的表单卡片！**严禁**出现“🎯 为你精选...”、“----”分割线、“🎬 片名：”、“🏷️ 标签：”、“⭐ 评分：”、“🔥 推荐理由：”这种机械模板前缀！
   - 要顺着用户的原话自然接话（例如用户指定了年份、月份档期或特定类型，就在聊天中自然点出该年份/档期/类型的特点）。
2. **严格遵守数量、年份与类型要求**：
   - 用户要求的推荐数量：**${slots.count} 部**（如果 count=1，正文中重点只推荐 1 部最匹配的，绝不要罗列五六部！如果 count>1，用清爽的 1. 《片名》... 2. 《片名》... 自然分段介绍 ${slots.count} 部）。
   - 用户要求的时间范围：${timeDescMap[slots.timeScope]}。必须只从下方【豆瓣实时核验片单】中挑选（若用户指定了具体月份/档期如“春节档/暑期档/10月”，优先挑选片单中最契合该档期與细分题材的作品），年份严格以片单中标注的真实年份为准！
3. **剧情与看点真实不瞎编**：
   - 必须严格根据候选池里提供的【主演、类型、豆瓣真实热评】来聊这部剧为什么好看、是什么氛围，严禁胡乱编造人物关系或假剧情！
4. **结尾自然引导转存**：
   - 在回复末尾顺口提一句简短自然的话（不要加分割线）：${
     slots.count === 1
       ? '告诉用户想看这部直接回个「1」或「转存」就能帮他搜夸克网盘存好，看过了也可以回「换一部」。'
       : '告诉用户想看哪部直接回对应数字（如 1、2）就能帮他搜夸克网盘存好，或者回「换一批」看看别的。'
   }

【豆瓣实时核验片单（100% 真实在播数据，请严格从中挑选最契合用户意图的 ${slots.count} 部）】：
${candidateContext}

请输出严格 JSON 格式：
{
  "replyText": "直接发送给用户的微信聊天回复全文（自然、走心、懂他意思，无机械分割线与表单符号）",
  "recommendedTitles": ["按你在正文中推荐顺序排列的标准中文片名（不带书名号，严格 ${slots.count} 个）"]
}`;

      const res = await client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.4,
      });

      const raw = res.choices[0]?.message?.content?.trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        let replyText = String(parsed.replyText || '').trim();
        const rawTitles: string[] = Array.isArray(parsed.recommendedTitles)
          ? parsed.recommendedTitles.slice(0, slots.count)
          : [];

        if (replyText && rawTitles.length > 0) {
          // 防御性校准：当用户要求今年/近期(2026)作品时，防止模型误将 (2026) 写成 (2025)
          if (slots.timeScope === 'current_season' || slots.timeScope === 'this_year') {
            replyText = replyText.replace(/[（\(]2025(?:年)?[）\)]/g, `(${currentYear})`);
          }

          const cleanTitles = rawTitles.map((t) => String(t).replace(/[《》""''「」]/g, '').trim()).filter(Boolean);
          this.recordRecommended(userId, cleanTitles);

          const subjects: DoubanSubject[] = cleanTitles.map((title) => {
            const matched = topCandidates.find((c) => c.title === title || c.title.includes(title) || title.includes(c.title));
            return (
              matched || {
                id: title,
                title,
                rate: '8.0',
                cover: '',
                url: '',
                year: String(currentYear),
              }
            );
          });

          const items: RecommendItem[] = subjects.map((s, idx) => ({
            title: s.title,
            displayTitle: slots.count === 1 ? `《${s.title}》` : `${idx + 1}.《${s.title}》`,
            tags: (s.types || [slots.doubanTag]).join('｜'),
            rating: s.rate ? `豆瓣 ${s.rate}分` : '近期热播',
            description: s.shortComment || '',
          }));

          return {
            title: cleanTitles[0] || '',
            items,
            formattedNote: replyText,
            subjects,
            slots,
          };
        }
      }
    } catch (err: any) {
      console.warn('[AiRecommender] DeepSeek 生成自然推荐异常，使用实时核验候选兜底:', err.message);
    }

    return this.buildFallbackFromCandidates(topCandidates, slots, page, userId);
  }

  /**
   * 兜底方案：同样采用自然口语对话体，基于豆瓣实时核验数据生成回复（无机械表单）
   */
  private buildFallbackFromCandidates(
    candidates: DoubanSubject[],
    slots: IntentSlots,
    page: number,
    userId?: string
  ): RecommendResult {
    const { year: currentYear } = this.getCurrentYearAndMonth();
    const picked = (
      candidates.length > 0
        ? candidates
        : [
            {
              id: '36675942',
              title: '小城良方',
              rate: '8.0',
              year: String(currentYear),
              cover: '',
              url: '',
              actors: '肖战 / 倪大红 / 姜妍',
              types: ['剧情'],
              shortComment: '有笑有泪有吵有闹，但又不失烟火气的鲜活群像故事。',
            },
          ]
    ).slice(0, slots.count);

    this.recordRecommended(
      userId,
      picked.map((p) => p.title)
    );

    let replyText = '';
    if (slots.count === 1 && picked.length === 1) {
      const s = picked[0];
      const yearStr = s.year || String(currentYear);
      const rateStr = s.rate ? `豆瓣 ${s.rate} 分` : '目前正在热播';
      const actorStr = s.actors ? `，由 ${s.actors} 主演` : '';
      const commentStr = s.shortComment
        ? `观众评价它“${s.shortComment}”`
        : '近期讨论度和口碑都很稳，节奏紧凑不注水，非常值得追。';

      replyText = [
        `要看近期比较火的${slots.country === '中国大陆' ? '国产剧' : slots.doubanTag}，很推荐你看看《${s.title}》（${yearStr}年，${rateStr}${actorStr}）。`,
        '',
        `${commentStr}`,
        '',
        `想看这部的话直接回个「1」或者「转存」，我马上帮你去搜夸克网盘资源存好；如果看过了跟我说声「换一部」就行~`,
      ].join('\n');
    } else {
      const lines: string[] = [
        `给你挑了这几部热度与口碑都很不错的${slots.country === '中国大陆' ? '国产剧' : slots.doubanTag}：`,
        '',
      ];
      picked.forEach((s, idx) => {
        const yearStr = s.year || String(currentYear);
        const rateStr = s.rate ? `豆瓣 ${s.rate}分` : '近期热播';
        const actorStr = s.actors ? `｜${s.actors}` : '';
        const desc = s.shortComment || '近期口碑与热度兼具的诚意佳作，值得一看。';
        lines.push(`${idx + 1}. 《${s.title}》（${yearStr}｜${rateStr}${actorStr}）\n${desc}\n`);
      });
      lines.push(`想看哪部直接回数字（比如 1、2），我马上帮你搜夸克网盘存好；或者回「换一批」换几部看看~`);
      replyText = lines.join('\n').trim();
    }

    const items: RecommendItem[] = picked.map((s, idx) => ({
      title: s.title,
      displayTitle: slots.count === 1 ? `《${s.title}》` : `${idx + 1}.《${s.title}》`,
      tags: (s.types || [slots.doubanTag]).join('｜'),
      rating: s.rate ? `豆瓣 ${s.rate}分` : '近期热播',
      description: s.shortComment || '',
    }));

    return {
      title: picked[0]?.title || '',
      items,
      formattedNote: replyText,
      subjects: picked,
      slots,
    };
  }
}
