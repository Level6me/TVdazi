import { UserManager, UserPlan } from './UserManager';
import { DoubanService, DoubanSubject } from './DoubanService';
import { CategoryClassifier } from './CategoryClassifier';

export const ALL_SUPPORTED_MEDIA_TYPES = [
  '电影',
  '电视剧',
  '国产剧',
  '美剧',
  '韩剧',
  '日剧',
  '英剧',
  '港剧',
  '台剧',
  '泰剧',
  '动画',
  '综艺',
  '纪录片',
  '短剧',
] as const;

export type ImplicitAction = 'save' | 'share' | 'search' | 'skip';

export interface UserTasteProfile {
  explicitLikes: {
    mediaTypes?: string[];
    genres: string[];
    regions: string[];
    directors: string[];
    actors: string[];
    favoriteSeeds: string[];
  };
  explicitDislikes: {
    mediaTypes?: string[];
    genres: string[];
    titles: string[];
  };
  implicitEvents: Array<{
    title: string;
    action: ImplicitAction;
    mediaType?: string;
    genres: string[];
    region?: string;
    directors?: string[];
    actors?: string[];
    decade?: string;
    timestamp: number;
  }>;
  updatedAt: number;
}

export interface TagWeightVector {
  mediaTypes: Record<string, number>;
  genres: Record<string, number>;
  regions: Record<string, number>;
  directors: Record<string, number>;
  actors: Record<string, number>;
  decades: Record<string, number>;
}

export interface ParsedNaturalPreference {
  likeMediaTypes: string[];
  dislikeMediaTypes: string[];
  likeGenres: string[];
  dislikeGenres: string[];
  likeRegions: string[];
  likeDirectors: string[];
  likeActors: string[];
  favoriteSeeds: string[];
  dislikeTitles: string[];
}

export interface ProfileAnalysisResult {
  personaLabel: string;
  confidence: number;
  diversityEntropy: number;
  diversityLabel: string;
  mediaTypeDistribution: Array<{ name: string; weight: number; ratio: number }>;
  topGenres: Array<{ name: string; score: number }>;
  topRegions: Array<{ name: string; score: number }>;
  topDirectors: Array<{ name: string; score: number }>;
  topActors: Array<{ name: string; score: number }>;
  favoriteSeeds: string[];
  dislikedGenres: string[];
  dislikedMediaTypes: string[];
  eventCount: number;
  recommendationStrategy: string;
}

const ACTION_BASE_WEIGHTS: Record<ImplicitAction, number> = {
  save: 3.0,
  share: 2.5,
  search: 1.0,
  skip: -0.8,
};

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天半衰期

/**
 * 轻量级用户观影画像与混合推荐排序引擎（专为 1~几十人小圈子设计，零额外依赖）
 * - 三源信号：显式偏好(+5.0 永久) + 隐式行为(save/share/search/skip + 30天指数时间衰减) + 负反馈排雷
 * - 排序算法：内容特征向量点积匹配 + 豆瓣口碑融合 + MMR 最大边界相关多样性重排
 */
export class UserProfileService {
  private static instance: UserProfileService;
  private userManager: UserManager;
  private doubanService: DoubanService;

  private constructor() {
    this.userManager = UserManager.getInstance();
    this.doubanService = new DoubanService();
  }

  static getInstance(): UserProfileService {
    if (!UserProfileService.instance) {
      UserProfileService.instance = new UserProfileService();
    }
    return UserProfileService.instance;
  }

  private ensureProfile(plan: UserPlan): UserTasteProfile {
    if (!plan.tasteProfile) {
      plan.tasteProfile = {
        explicitLikes: {
          mediaTypes: [],
          genres: [],
          regions: [],
          directors: [],
          actors: [],
          favoriteSeeds: [],
        },
        explicitDislikes: {
          mediaTypes: [],
          genres: [],
          titles: [],
        },
        implicitEvents: [],
        updatedAt: Date.now(),
      };
    } else {
      if (!Array.isArray(plan.tasteProfile.explicitLikes.mediaTypes)) {
        plan.tasteProfile.explicitLikes.mediaTypes = [];
      }
      if (!Array.isArray(plan.tasteProfile.explicitDislikes.mediaTypes)) {
        plan.tasteProfile.explicitDislikes.mediaTypes = [];
      }
    }
    return plan.tasteProfile;
  }

  public getProfile(userId: string): UserTasteProfile {
    const plan = this.userManager.getUserPlan(userId);
    return this.ensureProfile(plan);
  }

  private mergeUnique(target: string[], incoming?: string[], maxLen = 20): void {
    if (!incoming || incoming.length === 0) return;
    const seen = new Set(target.map((x) => x.toLowerCase()));
    for (const raw of incoming) {
      const clean = String(raw || '').replace(/[《》\s]+/g, ' ').trim();
      if (!clean || seen.has(clean.toLowerCase())) continue;
      seen.add(clean.toLowerCase());
      target.push(clean);
      if (target.length > maxLen) target.shift();
    }
  }

  private extractDecade(year?: string): string | undefined {
    const y = year ? parseInt(year, 10) : NaN;
    if (!Number.isFinite(y) || y < 1900 || y > 2099) return undefined;
    return `${Math.floor(y / 10) * 10}s`;
  }

  /**
   * 记录用户的显式偏好（主动告诉 bot 喜欢什么类型、地区、导演、演员、代表作或排雷什么）
   */
  public recordExplicitPreference(
    userId: string,
    opts: {
      likeMediaTypes?: string[];
      dislikeMediaTypes?: string[];
      likeGenres?: string[];
      likeRegions?: string[];
      likeDirectors?: string[];
      likeActors?: string[];
      favoriteSeeds?: string[];
      dislikeGenres?: string[];
      dislikeTitles?: string[];
      enrichSeedsAsync?: boolean;
    }
  ): UserTasteProfile {
    const plan = this.userManager.getUserPlan(userId);
    const profile = this.ensureProfile(plan);

    const normLikeMedia = opts.likeMediaTypes?.map((m) => UserProfileService.normalizeMediaType(m)).filter(Boolean);
    const normDislikeMedia = opts.dislikeMediaTypes?.map((m) => UserProfileService.normalizeMediaType(m)).filter(Boolean);

    this.mergeUnique(profile.explicitLikes.mediaTypes!, normLikeMedia, 14);
    this.mergeUnique(profile.explicitDislikes.mediaTypes!, normDislikeMedia, 10);
    this.mergeUnique(profile.explicitLikes.genres, opts.likeGenres, 15);
    this.mergeUnique(profile.explicitLikes.regions, opts.likeRegions, 10);
    this.mergeUnique(profile.explicitLikes.directors, opts.likeDirectors, 15);
    this.mergeUnique(profile.explicitLikes.actors, opts.likeActors, 15);
    this.mergeUnique(profile.explicitLikes.favoriteSeeds, opts.favoriteSeeds, 20);
    this.mergeUnique(profile.explicitDislikes.genres, opts.dislikeGenres, 15);
    this.mergeUnique(profile.explicitDislikes.titles, opts.dislikeTitles, 30);

    if (opts.likeMediaTypes && opts.likeMediaTypes.length > 0) {
      const likeMediaSet = new Set(opts.likeMediaTypes.map((m) => m.toLowerCase()));
      profile.explicitDislikes.mediaTypes = (profile.explicitDislikes.mediaTypes || []).filter(
        (m) => !likeMediaSet.has(m.toLowerCase())
      );
    }

    // 若用户说了喜欢某题材，自动从不喜欢列表移出该题材
    if (opts.likeGenres && opts.likeGenres.length > 0) {
      const likeSet = new Set(opts.likeGenres.map((g) => g.toLowerCase()));
      profile.explicitDislikes.genres = profile.explicitDislikes.genres.filter(
        (g) => !likeSet.has(g.toLowerCase())
      );
    }

    profile.updatedAt = Date.now();
    this.userManager.saveUserPlan(plan);

    // 若提供了“喜欢《某电影》”种子，后台异步补全该片特征并作为强正向事件写入
    if (opts.enrichSeedsAsync !== false && opts.favoriteSeeds && opts.favoriteSeeds.length > 0) {
      for (const seed of opts.favoriteSeeds.slice(0, 3)) {
        this.recordImplicitBehavior(userId, seed, 'save').catch(() => {});
      }
    }

    return profile;
  }

  /**
   * 记录用户隐式行为（转存/分享/搜索/换一批跳过）；缺省元数据时后台非阻塞补全豆瓣特征
   */
  public async recordImplicitBehavior(
    userId: string,
    title: string,
    action: ImplicitAction,
    meta?: {
      mediaType?: string;
      genres?: string[];
      region?: string;
      directors?: string[];
      actors?: string[];
      year?: string;
      episodesCount?: string;
      skipLookup?: boolean;
    }
  ): Promise<void> {
    const cleanTitle = (title || '').replace(/[《》]/g, '').trim();
    if (!cleanTitle || cleanTitle.length < 1) return;

    let genres = meta?.genres || [];
    let region = meta?.region;
    let directors = meta?.directors || [];
    let actors = meta?.actors || [];
    let decade = this.extractDecade(meta?.year);
    let episodesCount = meta?.episodesCount;

    if (genres.length === 0 && !region && !meta?.skipLookup) {
      try {
        const sub = await Promise.race([
          this.doubanService.searchAndEnrichSubjectByTitle(cleanTitle),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (sub) {
          genres = sub.types || genres;
          region = sub.region || region;
          episodesCount = sub.episodesCount || episodesCount;
          if (sub.directors) directors = sub.directors.split('/').map((s) => s.trim()).filter(Boolean);
          if (sub.actors) actors = sub.actors.split('/').map((s) => s.trim()).filter(Boolean);
          decade = this.extractDecade(sub.year) || decade;
        }
      } catch {}
    }

    const fallbackCategory =
      !meta?.mediaType && genres.length === 0 && !region
        ? CategoryClassifier.classify(cleanTitle)
        : meta?.mediaType;
    const inferredTypes = this.inferSubjectMediaTypes(
      { title: cleanTitle, types: genres, region, episodesCount },
      fallbackCategory
    );
    const primaryMediaType = inferredTypes[0];

    const plan = this.userManager.getUserPlan(userId);
    const profile = this.ensureProfile(plan);

    profile.implicitEvents.push({
      title: cleanTitle,
      action,
      mediaType: primaryMediaType,
      genres: genres.slice(0, 5),
      region,
      directors: directors.slice(0, 3),
      actors: actors.slice(0, 4),
      decade,
      timestamp: Date.now(),
    });

    if (profile.implicitEvents.length > 100) {
      profile.implicitEvents = profile.implicitEvents.slice(-100);
    }
    profile.updatedAt = Date.now();
    this.userManager.saveUserPlan(plan);
  }

  /**
   * 计算带 30 天指数时间衰减的用户个人口味特征向量
   */
  public static normalizeMediaType(raw: string): string {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^(?:动漫|动画片|番剧|国漫|日漫)$/i.test(s)) return '动画';
    if (/^(?:真人秀|脱口秀|恋综|音综)$/i.test(s)) return '综艺';
    if (/^(?:连续剧|剧集|网剧)$/i.test(s)) return '电视剧';
    if (/^(?:陆剧|大陆剧|内地剧|华语剧)$/i.test(s)) return '国产剧';
    return s;
  }

  /**
   * 推断任意作品所属的标准化全影视形态列表（支持电影、电视剧、国产剧、美剧、韩剧、日剧、英剧、港剧、台剧、泰剧、动画、综艺、纪录片、短剧）
   */
  public inferSubjectMediaTypes(subject: Partial<DoubanSubject>, explicitCategory?: string): string[] {
    const result: string[] = [];
    const pushMt = (mt: string) => {
      const norm = UserProfileService.normalizeMediaType(mt);
      if (norm && !result.includes(norm)) result.push(norm);
    };

    if (explicitCategory && explicitCategory !== '其他') {
      pushMt(explicitCategory);
    }

    const types = subject.types || [];
    const region = subject.region || '';
    const epNum = subject.episodesCount ? parseInt(String(subject.episodesCount), 10) : 0;
    const isSeries = Number.isFinite(epNum) && epNum > 1;

    if (types.some((t) => /动画|动漫/i.test(t))) {
      pushMt('动画');
    }
    if (types.some((t) => /真人秀|脱口秀|综艺/i.test(t))) {
      pushMt('综艺');
    }
    if (types.some((t) => /纪录片/i.test(t))) {
      pushMt('纪录片');
    }
    if (types.some((t) => /短片|短剧/i.test(t)) || /短剧/.test(subject.title || '')) {
      pushMt('短剧');
    }

    const isNonDramaFormat = result.some((r) => r === '动画' || r === '综艺' || r === '纪录片' || r === '短剧');
    if (!isNonDramaFormat && (isSeries || /剧/.test(explicitCategory || ''))) {
      if (/韩国/.test(region)) pushMt('韩剧');
      else if (/美国/.test(region)) pushMt('美剧');
      else if (/英国/.test(region)) pushMt('英剧');
      else if (/日本/.test(region)) pushMt('日剧');
      else if (/香港/.test(region)) pushMt('港剧');
      else if (/台湾/.test(region)) pushMt('台剧');
      else if (/泰国/.test(region)) pushMt('泰剧');
      else if (/中国大陆|内地|大陆/.test(region)) pushMt('国产剧');
      pushMt('电视剧');
    }

    if (result.length === 0) {
      pushMt('电影');
    }
    if (result.some((r) => ['国产剧', '美剧', '韩剧', '日剧', '英剧', '港剧', '台剧', '泰剧'].includes(r))) {
      pushMt('电视剧');
    }
    return result;
  }

  public computeTagVector(userId: string, nowMs: number = Date.now()): TagWeightVector {
    const profile = this.getProfile(userId);
    const vec: TagWeightVector = {
      mediaTypes: {},
      genres: {},
      regions: {},
      directors: {},
      actors: {},
      decades: {},
    };

    const addWeight = (bucket: Record<string, number>, key: string | undefined, delta: number) => {
      const k = (key || '').trim();
      if (!k) return;
      bucket[k] = Number(((bucket[k] || 0) + delta).toFixed(3));
    };

    // 1. 显式偏好（永久基础高权重 +5.0）
    for (const m of profile.explicitLikes.mediaTypes || []) {
      const norm = UserProfileService.normalizeMediaType(m);
      addWeight(vec.mediaTypes, norm, 5.0);
    }
    for (const g of profile.explicitLikes.genres) addWeight(vec.genres, g, 5.0);
    for (const r of profile.explicitLikes.regions) addWeight(vec.regions, r, 5.0);
    for (const d of profile.explicitLikes.directors) addWeight(vec.directors, d, 5.0);
    for (const a of profile.explicitLikes.actors) addWeight(vec.actors, a, 5.0);

    // 2. 隐式事件（指数时间衰减）
    for (const ev of profile.implicitEvents) {
      const ageMs = Math.max(0, nowMs - ev.timestamp);
      const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      const w = ACTION_BASE_WEIGHTS[ev.action] * decay;
      if (ev.mediaType) {
        const normMt = UserProfileService.normalizeMediaType(ev.mediaType);
        addWeight(vec.mediaTypes, normMt, w * 0.95);
        if (['国产剧', '美剧', '韩剧', '日剧', '英剧', '港剧', '台剧', '泰剧'].includes(normMt)) {
          addWeight(vec.mediaTypes, '电视剧', w * 0.35);
        }
      }
      for (const g of ev.genres) addWeight(vec.genres, g, w);
      if (ev.region) addWeight(vec.regions, ev.region, w * 0.8);
      for (const d of ev.directors || []) addWeight(vec.directors, d, w * 1.1);
      for (const a of ev.actors || []) addWeight(vec.actors, a, w * 0.6);
      if (ev.decade) addWeight(vec.decades, ev.decade, w * 0.5);
    }

    return vec;
  }

  /**
   * 计算单部候选作品与用户画像的匹配分（命中排雷项返回 -Infinity）
   */
  public scoreCandidate(userId: string, subject: DoubanSubject, nowMs: number = Date.now()): number {
    const plan = this.userManager.getUserPlan(userId);
    const profile = this.ensureProfile(plan);
    const types = subject.types || [];
    const inferredMediaTypes = this.inferSubjectMediaTypes(subject);

    // 1. 显式排雷过滤（题材 + 影视形态 + 特定片名）
    const dislikedMediaSet = new Set(
      (profile.explicitDislikes.mediaTypes || []).map((dm) => UserProfileService.normalizeMediaType(dm).toLowerCase())
    );
    if (inferredMediaTypes.some((mt) => dislikedMediaSet.has(mt.toLowerCase()))) {
      return -Infinity;
    }

    if (
      profile.explicitDislikes.genres.some((dg) =>
        types.some((t) => t.toLowerCase() === dg.toLowerCase())
      )
    ) {
      return -Infinity;
    }
    const cleanTitle = (subject.title || '').replace(/[《》]/g, '').trim().toLowerCase();
    if (profile.explicitDislikes.titles.some((dt) => dt.toLowerCase() === cleanTitle)) {
      return -Infinity;
    }

    const vec = this.computeTagVector(userId, nowMs);
    let matchScore = 0;

    // 影视形态匹配加权（电影 / 美剧 / 韩剧 / 日剧 / 国产剧 / 动画 / 综艺 / 纪录片 / 短剧）
    let bestMediaScore = 0;
    for (const mt of inferredMediaTypes) {
      const w = vec.mediaTypes[mt] || 0;
      if (w > bestMediaScore) bestMediaScore = w;
    }
    matchScore += bestMediaScore;

    for (const g of types) {
      if (vec.genres[g]) matchScore += vec.genres[g];
    }
    if (subject.region) {
      for (const [rKey, rWeight] of Object.entries(vec.regions)) {
        if (subject.region.includes(rKey) || rKey.includes(subject.region)) {
          matchScore += rWeight;
        }
      }
    }
    if (subject.directors) {
      for (const [dKey, dWeight] of Object.entries(vec.directors)) {
        if (subject.directors.includes(dKey)) matchScore += dWeight;
      }
    }
    if (subject.actors) {
      for (const [aKey, aWeight] of Object.entries(vec.actors)) {
        if (subject.actors.includes(aKey)) matchScore += aWeight;
      }
    }
    const dec = this.extractDecade(subject.year);
    if (dec && vec.decades[dec]) {
      matchScore += vec.decades[dec];
    }

    // 已经转存过的片适当降权，避免反复推荐已存电影
    const alreadySaved = plan.watchlist.some(
      (w) => w.status === 'completed' && w.title.trim().toLowerCase() === cleanTitle
    );
    if (alreadySaved) {
      matchScore -= 15;
    }

    return matchScore;
  }

  private calcSubjectSimilarity(a: DoubanSubject, b: DoubanSubject): number {
    const featA = new Set<string>([
      ...(a.types || []),
      ...(a.region ? [a.region] : []),
      ...(a.directors ? a.directors.split('/').map((s) => s.trim()) : []),
    ]);
    const featB = new Set<string>([
      ...(b.types || []),
      ...(b.region ? [b.region] : []),
      ...(b.directors ? b.directors.split('/').map((s) => s.trim()) : []),
    ]);
    if (featA.size === 0 || featB.size === 0) return 0;

    let inter = 0;
    for (const f of featA) {
      if (featB.has(f)) inter++;
    }
    const union = featA.size + featB.size - inter;
    return union > 0 ? inter / union : 0;
  }

  /**
   * MMR（Maximal Marginal Relevance）多样性重排：
   * 融合“上游热度分 + 个人画像匹配分”与“与已选片单的差异度”，防止推荐结果全部撞车同一题材/导演
   */
  public rerankWithMMR(
    userId: string | undefined,
    candidates: Array<{ subject: DoubanSubject; score: number }>,
    limit: number,
    lambda: number = 0.72
  ): DoubanSubject[] {
    if (!userId || candidates.length === 0) {
      return candidates.slice(0, limit).map((c) => c.subject);
    }

    const filtered: Array<{ subject: DoubanSubject; rel: number }> = [];
    for (const item of candidates) {
      const profileScore = this.scoreCandidate(userId, item.subject);
      if (profileScore === -Infinity) continue;
      // 归一化融合：上游基础分 + 个人画像匹配加权
      const rel = item.score + Math.max(-20, Math.min(45, profileScore * 2.5));
      filtered.push({ subject: item.subject, rel });
    }

    if (filtered.length <= 1) {
      return filtered.map((f) => f.subject);
    }

    const maxRel = Math.max(...filtered.map((f) => Math.abs(f.rel)), 1);
    const selected: Array<{ subject: DoubanSubject; rel: number }> = [];
    const remaining = [...filtered];

    while (selected.length < limit && remaining.length > 0) {
      let bestIdx = 0;
      let bestMmr = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const cand = remaining[i];
        const normRel = cand.rel / maxRel;
        let maxSim = 0;
        for (const picked of selected) {
          const sim = this.calcSubjectSimilarity(cand.subject, picked.subject);
          if (sim > maxSim) maxSim = sim;
        }
        const mmr = lambda * normRel - (1 - lambda) * maxSim;
        if (mmr > bestMmr) {
          bestMmr = mmr;
          bestIdx = i;
        }
      }

      selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected.map((s) => s.subject);
  }

  /**
   * 轻量级中文自然语言偏好解析器：
   * 从用户口语描述中自动抽取喜欢的/排雷的【影视形态（电影/电视剧/综艺/动漫/纪录片/短剧）、题材、地区、导演、代表作】
   */
  public parseNaturalLanguagePreference(text: string): ParsedNaturalPreference {
    const out: ParsedNaturalPreference = {
      likeMediaTypes: [],
      dislikeMediaTypes: [],
      likeGenres: [],
      dislikeGenres: [],
      likeRegions: [],
      likeDirectors: [],
      likeActors: [],
      favoriteSeeds: [],
      dislikeTitles: [],
    };

    const raw = String(text || '').trim();
    if (!raw) return out;

    const mediaDict: Array<[RegExp, string]> = [
      [/(?:电影|院线片|大片|影片|movie|韩影|日影|港片)/i, '电影'],
      [/(?:美剧|欧美剧)/i, '美剧'],
      [/(?:韩剧|韩国剧)/i, '韩剧'],
      [/(?:日剧|日本剧)/i, '日剧'],
      [/(?:英剧|英国剧)/i, '英剧'],
      [/(?:港剧|tvb剧)/i, '港剧'],
      [/(?:台剧|台湾剧)/i, '台剧'],
      [/(?:泰剧|泰国剧)/i, '泰剧'],
      [/(?:国产剧|陆剧|内地剧|大陆剧|华语剧)/i, '国产剧'],
      [/(?:电视剧|连续剧|剧集|网剧|追剧)/i, '电视剧'],
      [/(?:综艺|真人秀|脱口秀|恋综|音综|搞笑综艺|下饭综艺|晚会)/i, '综艺'],
      [/(?:动画|动漫|番剧|国漫|日漫|二次元)/i, '动画'],
      [/(?:纪录片|纪实)/i, '纪录片'],
      [/(?:短剧|微短剧|爽剧)/i, '短剧'],
    ];

    const genreDict: Array<[RegExp, string]> = [
      [/(?:悬疑|推理|烧脑|探案|破案)/i, '悬疑'],
      [/(?:科幻|太空|赛博|星际|未来)/i, '科幻'],
      [/(?:犯罪|警匪|黑帮|扫黑|刑侦)/i, '犯罪'],
      [/(?:动作|武侠|功夫|打戏|特工|枪战)/i, '动作'],
      [/(?:喜剧|搞笑|幽默|沙雕|下饭|轻松|欢乐)/i, '喜剧'],
      [/(?:爱情|恋爱|甜宠|浪漫|偶像|言情|恋综)/i, '爱情'],
      [/(?:剧情|文艺|现实|人性|口碑)/i, '剧情'],
      [/(?:战争|军事|谍战|抗战)/i, '战争'],
      [/(?:恐怖|鬼片|惊悚|灵异|吓人)/i, '恐怖'],
      [/(?:奇幻|魔幻|仙侠|玄幻|魔法)/i, '奇幻'],
      [/(?:古装|历史|宫斗|权谋|朝堂|武林)/i, '古装'],
      [/(?:家庭|伦理|亲情|治愈|温情|生活)/i, '家庭'],
      [/(?:真人秀|慢综艺|旅游|旅行|美食|竞速)/i, '真人秀'],
      [/(?:脱口秀|吐槽|单口|相声)/i, '脱口秀'],
      [/(?:音乐|音综|演唱会|歌舞)/i, '音乐'],
    ];

    const regionDict: Array<[RegExp, string]> = [
      [/(?:国产|内地|大陆|华语|国漫|国产剧)/i, '中国大陆'],
      [/(?:香港|港片|港剧|TVB)/i, '香港'],
      [/(?:台湾|台剧|台片)/i, '台湾'],
      [/(?:韩国|韩剧|韩影|韩综)/i, '韩国'],
      [/(?:日本|日剧|日影|日漫)/i, '日本'],
      [/(?:美国|美剧|好莱坞)/i, '美国'],
      [/(?:英国|英剧)/i, '英国'],
      [/(?:欧美|西方)/i, '欧美'],
      [/(?:泰国|泰剧|泰影)/i, '泰国'],
    ];

    const clauses = raw
      .split(/[，,。；;！!\n]|(?=(?:但是|不过|就是|除了|别给我|不要|不喜欢|不爱看|不看|讨厌|排雷))/)
      .map((s) => s.trim())
      .filter(Boolean);

    const negPrefixRegex = /(?:不喜欢|不爱看|不怎么看|不看|别推|别给我推|少推|不要|讨厌|害怕|受不了|拒绝|排雷)/;

    const pushUnique = (arr: string[], val: string) => {
      if (val && !arr.includes(val)) arr.push(val);
    };

    for (const clause of clauses) {
      const isNegative = negPrefixRegex.test(clause);

      for (const m of clause.matchAll(/《([^《》]{1,40})》/g)) {
        const title = m[1].trim();
        if (title) {
          pushUnique(isNegative ? out.dislikeTitles : out.favoriteSeeds, title);
        }
      }

      for (const [reg, label] of mediaDict) {
        if (reg.test(clause)) {
          pushUnique(isNegative ? out.dislikeMediaTypes : out.likeMediaTypes, label);
        }
      }

      for (const [reg, label] of genreDict) {
        if (reg.test(clause)) {
          pushUnique(isNegative ? out.dislikeGenres : out.likeGenres, label);
        }
      }

      if (!isNegative) {
        for (const [reg, label] of regionDict) {
          if (reg.test(clause)) {
            pushUnique(out.likeRegions, label);
          }
        }

        const dirMatch = clause.match(/导演\s*([A-Za-z\u4e00-\u9fa5·]{2,14})/);
        if (dirMatch && dirMatch[1]) {
          pushUnique(out.likeDirectors, dirMatch[1].trim());
        }
        const actorMatch = clause.match(/(?:演员|主演|明星)\s*([A-Za-z\u4e00-\u9fa5·]{2,14})/);
        if (actorMatch && actorMatch[1]) {
          pushUnique(out.likeActors, actorMatch[1].trim());
        }
      }
    }

    return out;
  }

  /**
   * 判断用户输入是否在主动表达个人影视偏好（而非直接搜片或发指令）
   */
  public static isNaturalPreferenceStatement(text: string): boolean {
    const trimmed = String(text || '').trim();
    if (!trimmed || trimmed.startsWith('/')) return false;
    // 排除明确搜片或定时/传话指令
    if (/(?:帮我找|搜一下|搜索|求资源|推荐一部|来一部|有什么好看|几分钟后|定时|追更|蹲守|传话)/.test(trimmed)) {
      return false;
    }
    const hasPrefVerb = /(?:我(?:平时|一般|比较|最|特别|挺|很|偏)?(?:喜欢|爱看|偏好|爱追|常看|迷上|钟爱|不喜欢|不爱看|不看|讨厌|害怕|排雷))|(?:别给我推|少给我推|平时爱看|个人口味)/.test(
      trimmed
    );
    if (!hasPrefVerb) return false;
    const hasMediaOrTaste = /(?:电影|电视剧|剧集|连续剧|网剧|综艺|真人秀|脱口秀|恋综|音综|动漫|动画|番剧|国漫|日漫|纪录片|短剧|悬疑|科幻|犯罪|动作|喜剧|搞笑|爱情|剧情|战争|恐怖|惊悚|奇幻|古装|家庭|韩剧|美剧|日剧|英剧|港剧|台剧|泰剧|国产剧|陆剧|国产|欧美|《)/.test(
      trimmed
    );
    return hasMediaOrTaste;
  }

  /**
   * 解析自然语言并更新用户画像，随后执行算法画像分析并返回结构化结果
   */
  public applyNaturalLanguagePreference(userId: string, text: string): {
    parsed: ParsedNaturalPreference;
    analysis: ProfileAnalysisResult;
  } {
    const parsed = this.parseNaturalLanguagePreference(text);
    this.recordExplicitPreference(userId, {
      likeMediaTypes: parsed.likeMediaTypes,
      dislikeMediaTypes: parsed.dislikeMediaTypes,
      likeGenres: parsed.likeGenres,
      dislikeGenres: parsed.dislikeGenres,
      likeRegions: parsed.likeRegions,
      likeDirectors: parsed.likeDirectors,
      likeActors: parsed.likeActors,
      favoriteSeeds: parsed.favoriteSeeds,
      dislikeTitles: parsed.dislikeTitles,
    });
    return {
      parsed,
      analysis: this.analyzeUserProfile(userId),
    };
  }

  /**
   * 算法分析用户画像：
   * 计算形态占比分布、偏好置信度、香农多样性熵与人物画像标签
   */
  public analyzeUserProfile(userId: string): ProfileAnalysisResult {
    const profile = this.getProfile(userId);
    const vec = this.computeTagVector(userId);
    const sortBucket = (b: Record<string, number>, topN = 5) =>
      Object.entries(b)
        .filter(([, v]) => v > 0.2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([name, score]) => ({ name, score: Number(score.toFixed(1)) }));

    const topMediaRaw = sortBucket(vec.mediaTypes, 6);
    const mediaSum = topMediaRaw.reduce((acc, item) => acc + item.score, 0);
    const mediaTypeDistribution = topMediaRaw.map((m) => ({
      name: m.name,
      weight: m.score,
      ratio: mediaSum > 0 ? Math.round((m.score / mediaSum) * 100) : 0,
    }));

    const topGenres = sortBucket(vec.genres, 6);
    const topRegions = sortBucket(vec.regions, 4);
    const topDirectors = sortBucket(vec.directors, 3);
    const topActors = sortBucket(vec.actors, 3);

    // 计算香农多样性熵（Normalized Shannon Entropy over genres）
    let diversityEntropy = 0;
    const genreSum = topGenres.reduce((acc, g) => acc + g.score, 0);
    if (topGenres.length > 1 && genreSum > 0) {
      let h = 0;
      for (const g of topGenres) {
        const p = g.score / genreSum;
        if (p > 0) h -= p * Math.log2(p);
      }
      diversityEntropy = Number((h / Math.log2(topGenres.length)).toFixed(2));
    }

    const diversityLabel =
      topGenres.length === 0
        ? '冷启动待建立'
        : diversityEntropy >= 0.85
          ? '多面探索派（涉猎广泛）'
          : diversityEntropy >= 0.55
            ? '均衡追片派（主次分明）'
            : '垂直硬核派（偏好高度聚焦）';

    // 画像置信度 (0~100%)
    const explicitSignals =
      (profile.explicitLikes.mediaTypes?.length || 0) +
      profile.explicitLikes.genres.length +
      profile.explicitLikes.regions.length +
      profile.explicitLikes.directors.length +
      profile.explicitLikes.actors.length +
      profile.explicitLikes.favoriteSeeds.length +
      profile.explicitDislikes.genres.length;
    const implicitSignals = profile.implicitEvents.length;
    const confidence = Math.min(100, Math.round(explicitSignals * 14 + implicitSignals * 4));

    // 生成算法画像定位标签
    const regionPart = topRegions[0]?.name ? `${topRegions[0].name}` : '';
    const genrePart = topGenres.slice(0, 2).map((g) => g.name).join('/');
    const mediaPart = mediaTypeDistribution.slice(0, 2).map((m) => m.name).join('·') || '影视';
    const personaCore = [regionPart, genrePart, mediaPart].filter(Boolean).join('');
    const personaLabel = personaCore ? `「${personaCore}偏好派」` : '「冷启动探索中」';

    const strategyParts: string[] = [];
    if (mediaTypeDistribution.length > 0) {
      strategyParts.push(`优先匹配 ${mediaTypeDistribution.map((m) => `${m.name}(${m.ratio}%)`).join(' / ')}`);
    }
    if (topGenres.length > 0) {
      strategyParts.push(`主推 ${topGenres.slice(0, 3).map((g) => g.name).join('、')} 题材`);
    }
    if (profile.explicitDislikes.genres.length > 0) {
      strategyParts.push(`自动屏蔽 ${profile.explicitDislikes.genres.join('、')}`);
    }
    const recommendationStrategy =
      strategyParts.length > 0
        ? `${strategyParts.join('，')}（MMR 多样性重排 λ=0.72）`
        : '当前采用豆瓣高分口碑冷启动策略';

    return {
      personaLabel,
      confidence,
      diversityEntropy,
      diversityLabel,
      mediaTypeDistribution,
      topGenres,
      topRegions,
      topDirectors,
      topActors,
      favoriteSeeds: profile.explicitLikes.favoriteSeeds,
      dislikedGenres: profile.explicitDislikes.genres,
      dislikedMediaTypes: profile.explicitDislikes.mediaTypes || [],
      eventCount: implicitSignals,
      recommendationStrategy,
    };
  }

  /**
   * 生成 Top 标签摘要（用于 Prompt 注入与前端可视化）
   */
  public getTopTags(userId: string): {
    topMediaTypes: Array<{ name: string; score: number }>;
    topGenres: Array<{ name: string; score: number }>;
    topRegions: Array<{ name: string; score: number }>;
    topDirectors: Array<{ name: string; score: number }>;
    favoriteSeeds: string[];
    dislikedGenres: string[];
    eventCount: number;
  } {
    const profile = this.getProfile(userId);
    const vec = this.computeTagVector(userId);
    const sortBucket = (b: Record<string, number>, topN = 5) =>
      Object.entries(b)
        .filter(([, v]) => v > 0.2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([name, score]) => ({ name, score: Number(score.toFixed(1)) }));

    return {
      topMediaTypes: sortBucket(vec.mediaTypes, 5),
      topGenres: sortBucket(vec.genres, 5),
      topRegions: sortBucket(vec.regions, 3),
      topDirectors: sortBucket(vec.directors, 3),
      favoriteSeeds: profile.explicitLikes.favoriteSeeds,
      dislikedGenres: profile.explicitDislikes.genres,
      eventCount: profile.implicitEvents.length,
    };
  }

  public buildProfileSummaryForPrompt(userId?: string): string {
    if (!userId) return '';
    const analysis = this.analyzeUserProfile(userId);
    const parts: string[] = [];
    if (analysis.mediaTypeDistribution.length > 0) {
      parts.push(`偏好形态：${analysis.mediaTypeDistribution.map((m) => `${m.name}(${m.ratio}%)`).join('、')}`);
    }
    if (analysis.topGenres.length > 0) {
      parts.push(`偏好题材：${analysis.topGenres.map((g) => g.name).join('、')}`);
    }
    if (analysis.topRegions.length > 0) {
      parts.push(`常看地区：${analysis.topRegions.map((r) => r.name).join('、')}`);
    }
    if (analysis.topDirectors.length > 0) {
      parts.push(`喜欢导演：${analysis.topDirectors.map((d) => d.name).join('、')}`);
    }
    if (analysis.favoriteSeeds.length > 0) {
      parts.push(`心头好代表作：${analysis.favoriteSeeds.slice(-3).map((t) => `《${t}》`).join('、')}`);
    }
    if (analysis.dislikedGenres.length > 0) {
      parts.push(`明确排雷不看：${analysis.dislikedGenres.join('、')}`);
    }
    if (analysis.dislikedMediaTypes.length > 0) {
      parts.push(`屏蔽形态：${analysis.dislikedMediaTypes.join('、')}`);
    }
    return parts.join('；');
  }

  public clearProfile(userId: string): void {
    const plan = this.userManager.getUserPlan(userId);
    delete plan.tasteProfile;
    this.userManager.saveUserPlan(plan);
  }

  public removeExplicitItem(
    userId: string,
    category:
      | 'likeMediaTypes'
      | 'dislikeMediaTypes'
      | 'likeGenres'
      | 'likeRegions'
      | 'likeDirectors'
      | 'likeActors'
      | 'favoriteSeeds'
      | 'dislikeGenres',
    value: string
  ): UserTasteProfile {
    const plan = this.userManager.getUserPlan(userId);
    const profile = this.ensureProfile(plan);
    const target = (value || '').trim().toLowerCase();
    const filterArr = (arr: string[]) => arr.filter((x) => x.trim().toLowerCase() !== target);

    if (category === 'likeMediaTypes') profile.explicitLikes.mediaTypes = filterArr(profile.explicitLikes.mediaTypes || []);
    else if (category === 'dislikeMediaTypes') {
      profile.explicitDislikes.mediaTypes = filterArr(profile.explicitDislikes.mediaTypes || []);
    }
    else if (category === 'likeGenres') profile.explicitLikes.genres = filterArr(profile.explicitLikes.genres);
    else if (category === 'likeRegions') profile.explicitLikes.regions = filterArr(profile.explicitLikes.regions);
    else if (category === 'likeDirectors') profile.explicitLikes.directors = filterArr(profile.explicitLikes.directors);
    else if (category === 'likeActors') profile.explicitLikes.actors = filterArr(profile.explicitLikes.actors);
    else if (category === 'favoriteSeeds') profile.explicitLikes.favoriteSeeds = filterArr(profile.explicitLikes.favoriteSeeds);
    else if (category === 'dislikeGenres') profile.explicitDislikes.genres = filterArr(profile.explicitDislikes.genres);

    profile.updatedAt = Date.now();
    this.userManager.saveUserPlan(plan);
    return profile;
  }

  public getDetailedProfileForWeb(userId: string) {
    const profile = this.getProfile(userId);
    const summary = this.getTopTags(userId);
    const analysis = this.analyzeUserProfile(userId);
    return {
      ...summary,
      personaLabel: analysis.personaLabel,
      confidence: analysis.confidence,
      diversityLabel: analysis.diversityLabel,
      mediaTypeDistribution: analysis.mediaTypeDistribution,
      explicitLikes: profile.explicitLikes,
      explicitDislikes: profile.explicitDislikes,
      recentEvents: [...profile.implicitEvents].reverse().slice(0, 15),
    };
  }

  public renderProfileCard(userId: string): string {
    const a = this.analyzeUserProfile(userId);
    if (
      a.mediaTypeDistribution.length === 0 &&
      a.topGenres.length === 0 &&
      a.topRegions.length === 0 &&
      a.favoriteSeeds.length === 0 &&
      a.dislikedGenres.length === 0 &&
      a.dislikedMediaTypes.length === 0
    ) {
      return [
        '🎯 【我的影视口味画像】',
        '----------------------------------------',
        '目前画像还在冷启动中哦~',
        '💡 你可以直接用自然语言跟我说：',
        '• “我平时喜欢看韩国悬疑电影和搞笑综艺”',
        '• “我很爱看《漫长的季节》这种悬疑剧，不喜欢恐怖片”',
        '• 或者平时搜片转存几部作品，算法就会自动分析你的画像！',
      ].join('\n');
    }

    const lines = [
      '🎯 【专属观影口味画像 · AI 算法分析】',
      '----------------------------------------',
      `🧠 画像定位：${a.personaLabel}（置信度 ${a.confidence}%）`,
      `📊 口味分布：${a.diversityLabel}`,
    ];
    if (a.mediaTypeDistribution.length > 0) {
      lines.push(`📺 影视形态：${a.mediaTypeDistribution.map((m) => `${m.name} ${m.ratio}%`).join(' · ')}`);
    }
    if (a.topGenres.length > 0) {
      lines.push(`🎭 偏好题材：${a.topGenres.map((g) => `${g.name}(${g.score})`).join(' · ')}`);
    }
    if (a.topRegions.length > 0) {
      lines.push(`🌍 常看地区：${a.topRegions.map((r) => `${r.name}(${r.score})`).join(' · ')}`);
    }
    if (a.topDirectors.length > 0) {
      lines.push(`🎬 钟爱导演：${a.topDirectors.map((d) => d.name).join('、')}`);
    }
    if (a.topActors.length > 0) {
      lines.push(`🌟 偏爱演员：${a.topActors.map((x) => x.name).join('、')}`);
    }
    if (a.favoriteSeeds.length > 0) {
      lines.push(`❤️ 心头好片：${a.favoriteSeeds.map((t) => `《${t}》`).join('、')}`);
    }
    if (a.dislikedGenres.length > 0 || a.dislikedMediaTypes.length > 0) {
      const blocks = [...a.dislikedMediaTypes, ...a.dislikedGenres];
      lines.push(`🚫 排雷屏蔽：${blocks.join('、')}`);
    }
    lines.push(`📈 推片策略：${a.recommendationStrategy}`);
    lines.push('----------------------------------------');
    lines.push('💡 随时说“我喜欢xxx / 不看xxx”即可动态更新；发 `/profile reset` 可清空重建。');
    return lines.join('\n');
  }
}
