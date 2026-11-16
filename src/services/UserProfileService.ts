import { UserManager, UserPlan } from './UserManager';
import { DoubanService, DoubanSubject } from './DoubanService';

export type ImplicitAction = 'save' | 'share' | 'search' | 'skip';

export interface UserTasteProfile {
  explicitLikes: {
    genres: string[];
    regions: string[];
    directors: string[];
    actors: string[];
    favoriteSeeds: string[];
  };
  explicitDislikes: {
    genres: string[];
    titles: string[];
  };
  implicitEvents: Array<{
    title: string;
    action: ImplicitAction;
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
  genres: Record<string, number>;
  regions: Record<string, number>;
  directors: Record<string, number>;
  actors: Record<string, number>;
  decades: Record<string, number>;
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
          genres: [],
          regions: [],
          directors: [],
          actors: [],
          favoriteSeeds: [],
        },
        explicitDislikes: {
          genres: [],
          titles: [],
        },
        implicitEvents: [],
        updatedAt: Date.now(),
      };
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

    this.mergeUnique(profile.explicitLikes.genres, opts.likeGenres, 15);
    this.mergeUnique(profile.explicitLikes.regions, opts.likeRegions, 10);
    this.mergeUnique(profile.explicitLikes.directors, opts.likeDirectors, 15);
    this.mergeUnique(profile.explicitLikes.actors, opts.likeActors, 15);
    this.mergeUnique(profile.explicitLikes.favoriteSeeds, opts.favoriteSeeds, 20);
    this.mergeUnique(profile.explicitDislikes.genres, opts.dislikeGenres, 15);
    this.mergeUnique(profile.explicitDislikes.titles, opts.dislikeTitles, 30);

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
      genres?: string[];
      region?: string;
      directors?: string[];
      actors?: string[];
      year?: string;
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

    if (genres.length === 0 && !region && !meta?.skipLookup) {
      try {
        const sub = await Promise.race([
          this.doubanService.searchAndEnrichSubjectByTitle(cleanTitle),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (sub) {
          genres = sub.types || genres;
          region = sub.region || region;
          if (sub.directors) directors = sub.directors.split('/').map((s) => s.trim()).filter(Boolean);
          if (sub.actors) actors = sub.actors.split('/').map((s) => s.trim()).filter(Boolean);
          decade = this.extractDecade(sub.year) || decade;
        }
      } catch {}
    }

    const plan = this.userManager.getUserPlan(userId);
    const profile = this.ensureProfile(plan);

    profile.implicitEvents.push({
      title: cleanTitle,
      action,
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
  public computeTagVector(userId: string, nowMs: number = Date.now()): TagWeightVector {
    const profile = this.getProfile(userId);
    const vec: TagWeightVector = {
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
    for (const g of profile.explicitLikes.genres) addWeight(vec.genres, g, 5.0);
    for (const r of profile.explicitLikes.regions) addWeight(vec.regions, r, 5.0);
    for (const d of profile.explicitLikes.directors) addWeight(vec.directors, d, 5.0);
    for (const a of profile.explicitLikes.actors) addWeight(vec.actors, a, 5.0);

    // 2. 隐式事件（指数时间衰减）
    for (const ev of profile.implicitEvents) {
      const ageMs = Math.max(0, nowMs - ev.timestamp);
      const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      const w = ACTION_BASE_WEIGHTS[ev.action] * decay;
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

    // 1. 显式排雷过滤
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
   * 生成 Top 标签摘要（用于 Prompt 注入与前端可视化）
   */
  public getTopTags(userId: string): {
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
    const summary = this.getTopTags(userId);
    const parts: string[] = [];
    if (summary.topGenres.length > 0) {
      parts.push(`偏好题材：${summary.topGenres.map((g) => g.name).join('、')}`);
    }
    if (summary.topRegions.length > 0) {
      parts.push(`常看地区：${summary.topRegions.map((r) => r.name).join('、')}`);
    }
    if (summary.topDirectors.length > 0) {
      parts.push(`喜欢导演：${summary.topDirectors.map((d) => d.name).join('、')}`);
    }
    if (summary.favoriteSeeds.length > 0) {
      parts.push(`心头好代表作：${summary.favoriteSeeds.slice(-3).map((t) => `《${t}》`).join('、')}`);
    }
    if (summary.dislikedGenres.length > 0) {
      parts.push(`明确排雷不看：${summary.dislikedGenres.join('、')}`);
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
    category: 'likeGenres' | 'likeRegions' | 'likeDirectors' | 'likeActors' | 'favoriteSeeds' | 'dislikeGenres',
    value: string
  ): UserTasteProfile {
    const plan = this.userManager.getUserPlan(userId);
    const profile = this.ensureProfile(plan);
    const target = (value || '').trim().toLowerCase();
    const filterArr = (arr: string[]) => arr.filter((x) => x.trim().toLowerCase() !== target);

    if (category === 'likeGenres') profile.explicitLikes.genres = filterArr(profile.explicitLikes.genres);
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
    return {
      ...summary,
      explicitLikes: profile.explicitLikes,
      explicitDislikes: profile.explicitDislikes,
      recentEvents: [...profile.implicitEvents].reverse().slice(0, 15),
    };
  }

  public renderProfileCard(userId: string): string {
    const s = this.getTopTags(userId);
    if (
      s.topGenres.length === 0 &&
      s.topRegions.length === 0 &&
      s.favoriteSeeds.length === 0 &&
      s.dislikedGenres.length === 0
    ) {
      return [
        '🎯 【我的观影口味画像】',
        '----------------------------------------',
        '目前画像还在空白冷启动中哦~',
        '💡 你可以直接跟我说：',
        '• “我喜欢看悬疑、科幻、诺兰的电影”',
        '• “我很喜欢《星际穿越》，不喜欢恐怖片”',
        '• 或者平时搜片转存几部电影，我就会自动记住你的口味啦！',
      ].join('\n');
    }

    const lines = [
      '🎯 【我的专属观影口味画像】',
      '----------------------------------------',
    ];
    if (s.topGenres.length > 0) {
      lines.push(`🎭 偏好题材：${s.topGenres.map((g) => `${g.name}(${g.score})`).join(' · ')}`);
    }
    if (s.topRegions.length > 0) {
      lines.push(`🌍 常看地区：${s.topRegions.map((r) => `${r.name}(${r.score})`).join(' · ')}`);
    }
    if (s.topDirectors.length > 0) {
      lines.push(`🎬 钟爱导演：${s.topDirectors.map((d) => d.name).join('、')}`);
    }
    if (s.favoriteSeeds.length > 0) {
      lines.push(`❤️ 心头好片：${s.favoriteSeeds.map((t) => `《${t}》`).join('、')}`);
    }
    if (s.dislikedGenres.length > 0) {
      lines.push(`🚫 排雷屏蔽：${s.dislikedGenres.join('、')}`);
    }
    lines.push(`📈 已分析行为：${s.eventCount} 条（含 30 天时间衰减加权）`);
    lines.push('----------------------------------------');
    lines.push('💡 随时说“我喜欢xxx / 不看xxx”即可调整；发 `/profile reset` 可清空重建。');
    return lines.join('\n');
  }
}
