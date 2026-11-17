import * as fs from 'fs';
import * as path from 'path';
import { ResourceSearcher } from './Searcher';
import { QuarkService } from './QuarkService';
import { DoubanService } from './DoubanService';
import { AiRecommender } from './AiRecommender';
import { SessionManager } from './SessionManager';
import { UserManager } from './UserManager';
import { CategoryClassifier, ResourceCategory } from './CategoryClassifier';
import { CloudResource } from '../types';
import { SerializedJsonStore } from '../utils/StorageQueue';
import { ScheduleTimeParser } from './scheduler/ScheduleTimeParser';

export type TaskType =
  | 'daily_recommend'   // 场景1：每日/周期定时推送指定类型影视推荐
  | 'resource_watch'    // 场景2：新片/未出资源全网蹲守监控（出资源通知或自动转存）
  | 'episode_chase'     // 扩展A：连载热播剧全自动追更入库 + 防和谐洗白
  | 'quality_upgrade'   // 扩展D：4K / REMUX / 杜比高画质洗版监控
  | 'friday_weekly'     // 扩展B：每周五晚周末观影片单周报
  | 'disk_guard'        // 扩展C：夸克网盘容量预警 + 定时防和谐静默巡检
  | 'watchlist_remind'  // 扩展E：个人待看片单周末温馨提醒
  | 'custom_reminder';  // 场景3：自定义计划任务（定时提醒/定时搜索/自定义周期任务）

export interface ScheduledTask {
  id: string;
  userId: string;
  type: TaskType;
  title: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastTriggeredDate?: string; // YYYY-MM-DD HH:mm 防同一分钟重复触发

  // 定时触发配置（适用于时间驱动型任务）
  scheduleTime?: string;      // "HH:mm" 格式，如 "08:00", "20:30"
  daysOfWeek?: number[];      // 0(周日)~6(周六)，不填或空数组表示每天
  oneShotDate?: string;       // "YYYY-MM-DD" 单次提醒日期（执行后自动标记完成）
  triggerAt?: number;         // 精确毫秒级触发时间戳（适用于“2分钟后”、“半小时后”等相对延时单次任务）
  intervalMinutes?: number;   // 轮询间隔分钟数（适用于蹲守/追更/4K监控，默认 30 分钟）

  // 业务参数
  keyword?: string;           // 监控或搜索的影视片名
  mediaType?: 'movie' | 'tv'; // 推荐类型
  tag?: string;               // 推荐标签（如 科幻、悬疑、韩剧、喜剧）
  query?: string;             // 推荐原始自然语言需求
  autoSave?: boolean;         // 命中后是否自动转存至夸克网盘
  lastEpisode?: number;       // 追更任务已转存/已知的最高集数
  knownShareIds?: string[];   // 已通知或已转存过的网盘 shareId 列表
  targetQualities?: string[]; // 洗版目标画质关键字（如 ['4K', '2160P', 'REMUX', '杜比']）
  minFreeGb?: number;         // 网盘低容量预警阈值（默认 5GB）
  customAction?: 'remind' | 'search' | 'recommend';
  customPayload?: string;     // 自定义提醒文案或指令内容
  status?: 'active' | 'completed' | 'paused';
}

export type PushMessageCallback = (userId: string, message: string) => Promise<boolean>;

export class SchedulerService {
  private static instance: SchedulerService;
  private tasksFilePath: string;
  private tasks: ScheduledTask[] = [];
  private timer: NodeJS.Timeout | null = null;
  private pushCallback: PushMessageCallback | null = null;
  private isTickRunning = false;

  private searcher: ResourceSearcher;
  private quarkService: QuarkService;
  private doubanService: DoubanService;
  private sessionManager: SessionManager;
  private userManager: UserManager;

  private constructor() {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.tasksFilePath = path.join(dataDir, 'schedules.json');
    this.searcher = new ResourceSearcher();
    this.quarkService = new QuarkService();
    this.doubanService = new DoubanService();
    this.sessionManager = SessionManager.getInstance();
    this.userManager = UserManager.getInstance();
    this.loadTasks();
  }

  public static getInstance(): SchedulerService {
    if (!SchedulerService.instance) {
      SchedulerService.instance = new SchedulerService();
    }
    return SchedulerService.instance;
  }

  private loadTasks(): void {
    try {
      if (fs.existsSync(this.tasksFilePath)) {
        const raw = fs.readFileSync(this.tasksFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const seenIds = new Set<string>();
          let repaired = false;
          this.tasks = parsed.map((t: any, idx: number) => {
            const rawId = typeof t?.id === 'string' ? t.id.trim() : '';
            if (!rawId || seenIds.has(rawId)) {
              repaired = true;
              const newId = `task_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
              seenIds.add(newId);
              return { ...t, id: newId };
            }
            seenIds.add(rawId);
            return t;
          });
          if (repaired) {
            this.saveTasks();
          }
        }
      }
    } catch (err: any) {
      console.error('[SchedulerService] 加载定时任务失败:', err.message);
      this.tasks = [];
    }
  }

  private saveTasks(): void {
    try {
      SerializedJsonStore.writeSync(this.tasksFilePath, this.tasks);
    } catch (err: any) {
      console.error('[SchedulerService] 保存定时任务失败:', err.message);
    }
  }

  public toggleUserTaskById(userId: string, taskId: string): ScheduledTask | null {
    const cleanId = String(taskId || '').trim();
    if (!cleanId) return null;
    const task = this.tasks.find((t) => t.userId === userId && t.id === cleanId);
    if (!task) return null;
    task.enabled = !task.enabled;
    task.status = task.enabled ? 'active' : 'paused';
    this.saveTasks();
    return task;
  }

  public deleteUserTaskById(userId: string, taskId: string): boolean {
    const cleanId = String(taskId || '').trim();
    if (!cleanId) return false;
    const idx = this.tasks.findIndex((t) => t.userId === userId && t.id === cleanId);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    this.saveTasks();
    return true;
  }

  /**
   * 供 Web 控制台片单页面创建电影蹲守 / 剧集追更 / 4K洗版任务，命中更新时通过微信 Bot 推送通知
   */
  public createPanelWatchTask(params: {
    userId: string;
    title: string;
    mode?: 'episode_chase' | 'resource_watch' | 'quality_upgrade';
    intervalMinutes?: number;
    autoSave?: boolean;
    runInitialCheck?: boolean;
  }): ScheduledTask {
    const cleanTitle = String(params.title || '').replace(/[《》]/g, '').trim();
    if (!cleanTitle) {
      throw new Error('请输入有效的影视作品名称');
    }

    const mode: 'episode_chase' | 'resource_watch' | 'quality_upgrade' =
      params.mode === 'episode_chase' || params.mode === 'quality_upgrade' ? params.mode : 'resource_watch';
    const rawInterval = Number(params.intervalMinutes);
    const intervalMinutes = Number.isFinite(rawInterval)
      ? Math.min(1440, Math.max(5, Math.round(rawInterval)))
      : 30;
    const autoSave = Boolean(params.autoSave);

    const taskTitle =
      mode === 'episode_chase'
        ? `追更《${cleanTitle}》`
        : mode === 'quality_upgrade'
          ? `《${cleanTitle}》4K高画质洗版监控`
          : `蹲守《${cleanTitle}》全网更新`;

    const task = this.addTask({
      userId: params.userId,
      type: mode,
      title: taskTitle,
      keyword: cleanTitle,
      enabled: true,
      intervalMinutes,
      autoSave,
      ...(mode === 'episode_chase' ? { lastEpisode: 0, knownShareIds: [] } : {}),
      ...(mode === 'quality_upgrade' ? { targetQualities: ['4K', '2160P', 'REMUX', '杜比', 'HDR'] } : {}),
    });

    this.userManager.addToWatchlist(params.userId, cleanTitle);

    if (params.runInitialCheck && this.pushCallback) {
      void this.triggerInitialPanelCheck(task).catch(() => {});
    }

    return task;
  }

  private async triggerInitialPanelCheck(task: ScheduledTask): Promise<void> {
    if (!task.enabled || task.status === 'completed') return;
    let msg: string | null = null;
    if (task.type === 'episode_chase') {
      msg = await this.runEpisodeChase(task, false);
    } else if (task.type === 'quality_upgrade') {
      msg = await this.runQualityUpgrade(task, false);
    } else if (task.type === 'resource_watch') {
      msg = await this.runResourceWatch(task, false);
    }
    if (msg && this.pushCallback) {
      await this.pushCallback(task.userId, msg);
    }
  }

  /**
   * 启动后台定时轮询引擎（每 10 秒检查一次精准延时触发、定点时间触发与资源轮询）
   */
  public start(pushCallback: PushMessageCallback): void {
    this.pushCallback = pushCallback;
    if (this.timer) {
      clearInterval(this.timer);
    }

    console.log(`[SchedulerService] ⏰ 智能定时与监控引擎已启动（当前共加载 ${this.tasks.length} 个任务）`);
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[SchedulerService] tick 执行异常:', err.message);
      });
    }, 10 * 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getCurrentTimeParts(): { dateStr: string; timeStr: string; dayOfWeek: number; minuteKey: string } {
    const { dateStr, timeStr, dayOfWeek, minuteKey } = ScheduleTimeParser.getBeijingParts();
    return { dateStr, timeStr, dayOfWeek, minuteKey };
  }

  /**
   * 核心调度 Tick：先同步筛选到期任务并落盘状态，再以有界并发执行，避免长耗时搜片阻塞定点任务
   */
  public async tick(): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;

    try {
      const { dateStr, timeStr, dayOfWeek, minuteKey } = this.getCurrentTimeParts();
      const nowMs = Date.now();
      const [curH, curM] = timeStr.split(':').map((n) => parseInt(n, 10));
      const curTotalMin = curH * 60 + curM;

      const dueTasks: ScheduledTask[] = [];
      let stateChanged = false;

      for (const task of this.tasks) {
        if (!task.enabled || task.status === 'completed' || task.status === 'paused') {
          continue;
        }

        // 0. 精准相对延时单次任务
        if (task.triggerAt) {
          if (nowMs >= task.triggerAt) {
            const staleMs = nowMs - task.triggerAt;
            task.lastTriggeredDate = minuteKey;
            task.lastRunAt = nowMs;
            task.status = 'completed';
            task.enabled = false;
            stateChanged = true;
            // 若因长时间停机已过期超过 2 小时，静默关闭而不突兀补发过时提醒
            if (staleMs <= 2 * 60 * 60 * 1000) {
              dueTasks.push(task);
            }
          }
          continue;
        }

        // 1. 时间定点触发型任务（允许 0~1 分钟补偿窗口，防止跨分钟漏触发）
        if (task.scheduleTime) {
          if (task.oneShotDate && task.oneShotDate < dateStr) {
            task.status = 'completed';
            task.enabled = false;
            stateChanged = true;
            continue;
          }
          if (task.oneShotDate && task.oneShotDate !== dateStr) {
            continue;
          }
          if (task.daysOfWeek && task.daysOfWeek.length > 0 && !task.daysOfWeek.includes(dayOfWeek)) {
            continue;
          }

          const [schedH, schedM] = task.scheduleTime.split(':').map((n) => parseInt(n, 10));
          const schedTotalMin = schedH * 60 + schedM;
          const diffMin = curTotalMin - schedTotalMin;
          const dayTriggerKey = `${dateStr} ${task.scheduleTime}`;

          if (diffMin >= 0 && diffMin <= 1 && task.lastTriggeredDate !== dayTriggerKey) {
            task.lastTriggeredDate = dayTriggerKey;
            task.lastRunAt = nowMs;
            if (task.oneShotDate) {
              task.status = 'completed';
              task.enabled = false;
            }
            stateChanged = true;
            dueTasks.push(task);
          }
          continue;
        }

        // 2. 周期轮询型任务
        if (task.intervalMinutes || ['resource_watch', 'episode_chase', 'quality_upgrade'].includes(task.type)) {
          const intervalMs = (task.intervalMinutes || 30) * 60 * 1000;
          const lastRun = task.lastRunAt || 0;
          if (nowMs - lastRun >= intervalMs) {
            task.lastRunAt = nowMs;
            stateChanged = true;
            dueTasks.push(task);
          }
        }
      }

      if (stateChanged) {
        this.saveTasks();
      }

      // 有界并发执行到期任务（最多 4 并发），防止单一慢搜片任务卡死整个调度队列
      const CONCURRENCY = 4;
      for (let i = 0; i < dueTasks.length; i += CONCURRENCY) {
        const batch = dueTasks.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map(async (task) => {
            const msg = await this.executeTask(task, false);
            if (msg && this.pushCallback) {
              await this.pushCallback(task.userId, msg);
            }
          })
        );
      }
    } finally {
      this.isTickRunning = false;
    }
  }

  /**
   * 立即执行指定任务（用于用户手动测试 `/task-run 1` 或刚创建监控任务时的首次即时巡检）
   * @param task 任务对象
   * @param isManual 是否为用户手动触发（手动触发时若暂未出资源也会返回当前检测进展报告）
   */
  public async executeTask(task: ScheduledTask, isManual: boolean = true): Promise<string | null> {
    try {
      switch (task.type) {
        case 'daily_recommend':
          return await this.runDailyRecommend(task);
        case 'resource_watch':
          return await this.runResourceWatch(task, isManual);
        case 'episode_chase':
          return await this.runEpisodeChase(task, isManual);
        case 'quality_upgrade':
          return await this.runQualityUpgrade(task, isManual);
        case 'friday_weekly':
          return await this.runFridayWeekly(task);
        case 'disk_guard':
          return await this.runDiskGuard(task, isManual);
        case 'watchlist_remind':
          return await this.runWatchlistRemind(task);
        case 'custom_reminder':
          return await this.runCustomReminder(task);
        default:
          return null;
      }
    } catch (err: any) {
      console.error(`[SchedulerService] 执行任务 ${task.id} (${task.title}) 异常:`, err.message);
      return isManual ? `⚠️ 执行任务「${task.title}」时遇到一点小波动：${err.message}` : null;
    }
  }

  /**
   * 场景 1：每日/周期定时荐片
   */
  private async runDailyRecommend(task: ScheduledTask): Promise<string> {
    const recommender = AiRecommender.getInstance();
    const mediaType = task.mediaType || 'movie';
    const tag = task.tag || '热门';
    const randomPage = Math.floor(Math.random() * 3) + 1;
    const query = task.query || `推荐一部高分好看的${tag}${mediaType === 'movie' ? '电影' : '电视剧'}`;

    const result = await recommender.generateXiaohongshuNote({
      query,
      type: mediaType,
      tag,
      page: randomPage,
      userId: task.userId,
    });

    this.sessionManager.setHot(task.userId, mediaType, result.subjects, tag, randomPage, 6, query);

    let autoSaveNotice = '';
    if (task.autoSave && result.subjects && result.subjects.length > 0) {
      const topSubject = result.subjects[0];
      const saveInfo = await this.tryAutoSaveByTitle(task.userId, topSubject.title, mediaType === 'movie' ? '电影' : '国产剧');
      if (saveInfo) {
        autoSaveNotice = `\n\n${saveInfo}`;
      }
    }

    return [
      `⏰ 【定时荐片 · ${task.title}】`,
      `─────────────────────────`,
      result.formattedNote,
      autoSaveNotice,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 检查搜索结果条目是否真实匹配目标片名（过滤掉搜索引擎降级返回的无关凑数结果）
   */
  private isStrictTitleMatch(item: { title: string; rawText?: string }, keyword: string): boolean {
    const cleanKey = keyword.replace(/[《》\s:：·.,，。！!？?]/g, '').toLowerCase();
    if (!cleanKey) return true;
    const hay = `${item.title} ${item.rawText || ''}`.replace(/[《》\s:：·.,，。！!？?]/g, '').toLowerCase();
    return hay.includes(cleanKey);
  }

  /** 自动转存使用更严格的标题证据；正文提及目标或搜索词兜底标题都不足以授权自动操作。 */
  private isStrongAutoSaveMatch(item: CloudResource, keyword: string): boolean {
    const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const key = normalize(keyword || '');
    const title = normalize(item.title || '');
    if (!key || !title || item.titleSource === 'keyword_fallback' || item.titleSource === 'matched_line') return false;
    // 两字片名仅允许标题精确一致；短名称的子串命中太容易误中其他作品。
    if (key.length <= 2) return title === key;
    if (item.titleSource === 'labeled') return title.includes(key);
    return title.startsWith(key);
  }

  /**
   * 场景 2：新片/未出资源全网蹲守监控
   */
  private async runResourceWatch(task: ScheduledTask, isManual: boolean): Promise<string | null> {
    const keyword = task.keyword || task.title;
    const res = await this.searcher.search({ keyword });
    const rawItems = res.items || [];
    const items = rawItems.filter((i) => this.isStrongAutoSaveMatch(i, keyword));

    if (items.length === 0) {
      if (isManual) {
        const freqText = SchedulerService.formatInterval(task.intervalMinutes || 30);
        return [
          `🛰️ 【全网蹲守巡检报告】《${keyword}》`,
          `─────────────────────────`,
          `📡 刚刚已轮询 50+ 资源频道，目前暂未发现《${keyword}》的有效网盘活链。`,
          `✅ 蹲守任务持续运行中（${freqText}自动巡检一次），一旦全网出资源我会在第一时间微信通知你${task.autoSave ? '并自动转存进你的夸克网盘' : ''}！`,
        ].join('\n');
      }
      return null;
    }

    // 优先选夸克资源，且支持死链自动顺延重试（最多尝试前 3 条夸克活链）
    this.sessionManager.setSearch(task.userId, keyword, items, 8);

    let saveMsg = '';
    if (task.autoSave) {
      const autoRes = await this.trySaveQuarkCandidates(items, task.userId, '电影', keyword);
      if (autoRes.success && autoRes.item) {
        const tip = autoRes.attempt > 1 ? `（第 1 条失效，已自动顺延第 ${autoRes.attempt} 条活链入库）` : '';
        saveMsg = `\n🎉 已按你的预约，全自动转存至夸克网盘：【${autoRes.targetPath}】！${tip}\n${autoRes.message}`;
      } else if (autoRes.message) {
        saveMsg = `\n💡 自动转存尝试提示：${autoRes.message}（可直接回复数字 1~${Math.min(5, items.length)} 尝试其他候选活链）`;
      }
    }

    // 蹲守命中后标记为已完成，防止重复轰炸
    task.status = 'completed';
    task.enabled = false;
    this.saveTasks();

    const previewList = items
      .slice(0, 4)
      .map((item, idx) => `${idx + 1}. [${item.panType === 'quark' ? '夸克' : '网盘'}] ${item.title}`)
      .join('\n');

    return [
      `🎉 【蹲守命中提醒】你预约的《${keyword}》出资源啦！`,
      `─────────────────────────`,
      `🔍 全网共检索到 ${items.length} 条有效活链：`,
      previewList,
      saveMsg,
      `─────────────────────────`,
      `💬 直接回复数字序号（如「1」或「2」）即可一键转存对应版本！`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 扩展 A：连载热播剧全自动追更入库
   */
  public static extractEpisodeInfo(text: string): { maxEp: number; isComplete: boolean; label: string } {
    // 剔除 URL 链接与年份（如 2024/2025/2026）及分辨率（1080P/2160P/4K/60帧），防止把链接 hash（如 e496）或年份误判为集数
    const cleanText = text
      .replace(/https?:\/\/[^\s]+/gi, ' ')
      .replace(/\b(?:19|20)\d{2}\b/g, ' ')
      .replace(/\b(?:1080|2160|720|480)[pP]?\b/g, ' ');

    let maxEp = 0;
    let isComplete = false;

    if (/(?:全集|完结|全\s*\d+\s*集)/i.test(cleanText)) {
      isComplete = true;
    }

    const patterns = [
      /(?:更至|更新至|更新到|更到|至)\s*(?:第)?\s*(\d{1,3})\s*[集话期]/gi,
      /第\s*(\d{1,3})\s*-\s*(\d{1,3})\s*[集话期]/gi,
      /(?:0?1)\s*-\s*(\d{1,3})\s*[集话期]/gi,
      /第\s*(\d{1,3})\s*[集话期]/gi,
      /[Ss]\d{1,2}\s*[Ee]\d{1,3}\s*-\s*[Ee]?(\d{1,3})/g,
      /[Ss]\d{1,2}\s*[Ee](\d{1,3})/g,
      /(?:^|[\s\[\(【\-_])[Ee][Pp]?(\d{1,2})(?=$|[\s\]\)】\-_])/g,
      /全\s*(\d{1,3})\s*[集话期]/gi,
    ];

    for (const reg of patterns) {
      let m: RegExpExecArray | null;
      while ((m = reg.exec(cleanText)) !== null) {
        const numStr = m[2] || m[1];
        const ep = parseInt(numStr, 10);
        if (!isNaN(ep) && ep > 0 && ep < 300 && ep > maxEp) {
          maxEp = ep;
        }
      }
    }

    const label = maxEp > 0 ? `第 ${maxEp} 集${isComplete ? '（已完结）' : ''}` : isComplete ? '全集完结版' : '最新资源';
    return { maxEp, isComplete, label };
  }

  private async runEpisodeChase(task: ScheduledTask, isManual: boolean): Promise<string | null> {
    const keyword = task.keyword || task.title;
    const res = await this.searcher.search({ keyword });
    const rawItems = res.items || [];
    const items = rawItems.filter((i) => this.isStrongAutoSaveMatch(i, keyword));

    if (items.length === 0) {
      if (isManual) {
        const freqText = SchedulerService.formatInterval(task.intervalMinutes || 30);
        return `📺 【智能追更巡检】《${keyword}》目前暂未检索到网盘资源，后台将${freqText}持续为你盯梢更新！`;
      }
      return null;
    }

    const quarkItems = items.filter(
      (i) => (i.panType === 'quark' || i.shareUrl.includes('pan.quark.cn')) && this.isStrongAutoSaveMatch(i, keyword)
    );
    const candidates = quarkItems.length > 0 ? quarkItems : items;

    let bestCandidate = candidates[0];
    let highestEp = 0;
    let completeFlag = false;

    for (const item of candidates) {
      const info = SchedulerService.extractEpisodeInfo(`${item.title} ${item.linkContext ?? item.rawText ?? ''}`);
      if (info.maxEp > highestEp) {
        highestEp = info.maxEp;
        bestCandidate = item;
        completeFlag = info.isComplete;
      } else if (info.maxEp === highestEp && info.isComplete) {
        completeFlag = true;
      }
    }

    const prevEp = task.lastEpisode || 0;
    const knownIds = new Set(task.knownShareIds || []);

    // 查询豆瓣剧集总集数与完结进度，辅助判断全集完结并展示官方进度
    const epProg = await Promise.race([
      new DoubanService().getEpisodeProgress(keyword).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2200)),
    ]);
    if (epProg?.isFinished && epProg.episodesCount && highestEp >= epProg.episodesCount) {
      completeFlag = true;
    }
    const doubanEpLine = epProg
      ? `📖 豆瓣官方进度：${epProg.episodesInfo || (epProg.episodesCount ? `共 ${epProg.episodesCount} 集` : '连载中')}${epProg.isFinished ? '（已完结）' : ''}`
      : '';

    // 判断是否有新集数更新（仅当明确识别到更高集数，或首次完全未见过资源时才触发通知，避免无集号分享换链接反复轰炸）
    const hasNewEpisode = highestEp > prevEp || (prevEp === 0 && knownIds.size === 0);

    if (!hasNewEpisode) {
      if (isManual) {
        this.sessionManager.setSearch(task.userId, keyword, items, 8);
        return [
          `📺 【智能追更状态】《${keyword}》`,
          `─────────────────────────`,
          `📌 当前全网最新进度：${highestEp > 0 ? `更至第 ${highestEp} 集` : '暂无明确集数标号（已为你备好当前活链）'}`,
          doubanEpLine,
          `✅ 你已同步过该进度（上次记录：${prevEp > 0 ? `第 ${prevEp} 集` : '已收录'}）。`,
          `💡 一旦后续放出第 ${highestEp + 1} 集或新更新包，我会自动为你转存网盘并推送微信消息！`,
        ]
          .filter(Boolean)
          .join('\n');
      }
      return null;
    }

    this.sessionManager.setSearch(task.userId, keyword, items, 8);

    // 发现新集数更新！先执行自动转存，再持久化进度与完结状态，避免转存失败导致进度被提前锁死
    let saveDetail = '';
    let saveSucceeded = task.autoSave === false;
    if (task.autoSave !== false) {
      const prioritized = [bestCandidate, ...candidates.filter((c) => c.shareId !== bestCandidate.shareId)];
      const inferredCategory =
        bestCandidate.category || CategoryClassifier.classify(bestCandidate.title, bestCandidate.rawText || '') || '国产剧';
      const autoRes = await this.trySaveQuarkCandidates(prioritized, task.userId, inferredCategory, keyword);
      if (autoRes.success) {
        saveSucceeded = true;
        saveDetail = `\n📂 已自动转存至夸克网盘：【${autoRes.targetPath}】\n${autoRes.message}`;
      } else {
        saveDetail = `\n🔗 最新分享链接：${bestCandidate.shareUrl}（回复「1」可手动转存）`;
      }
    }

    task.knownShareIds = [...Array.from(knownIds), bestCandidate.shareId].slice(-20);
    if (saveSucceeded || highestEp > prevEp) {
      task.lastEpisode = Math.max(prevEp, highestEp);
      if (completeFlag && highestEp > 0 && saveSucceeded) {
        task.status = 'completed';
        task.enabled = false;
      }
    }
    this.saveTasks();

    const epText = highestEp > 0 ? `最新第 ${highestEp} 集${completeFlag ? '（全集完结）' : ''}` : '最新资源包';
    return [
      `📣 【热播追更提醒】你追的《${keyword}》更新啦！`,
      `─────────────────────────`,
      `🆕 最新进度：${epText}`,
      doubanEpLine,
      `🎬 资源版本：${bestCandidate.title}`,
      saveDetail,
      `─────────────────────────`,
      `💡 回复「1」可再次手动转存，发送「/tasks」可管理追更列表。`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 扩展 D：4K / REMUX / 杜比高画质洗版监控
   */
  private async runQualityUpgrade(task: ScheduledTask, isManual: boolean): Promise<string | null> {
    const keyword = task.keyword || task.title;
    const res = await this.searcher.search({ keyword });
    const rawItems = res.items || [];
    const items = rawItems.filter((i) => this.isStrongAutoSaveMatch(i, keyword));

    const hqItems = items.filter((item) => {
      const tags = item.qualityTags;
      return tags?.resolution === '4K' || tags?.codec === '原盘/REMUX' || Boolean(tags?.hdr);
    });

    if (hqItems.length === 0) {
      if (isManual) {
        const freqText = SchedulerService.formatInterval(task.intervalMinutes || 30);
        return [
          `💎 【4K 高画质洗版监控】《${keyword}》`,
          `─────────────────────────`,
          `🔍 当前共检索到 ${items.length} 条普通资源，暂未发现标注有「4K / 2160P / REMUX / 杜比视界」的高规格洗版片源。`,
          `⏳ 后台将继续（${freqText}）为你蹲守高码率 4K 版本，出片即刻自动入库并通知你！`,
        ].join('\n');
      }
      return null;
    }

    const bestHq = hqItems.find((i) => i.panType === 'quark' || i.shareUrl.includes('pan.quark.cn')) || hqItems[0];
    this.sessionManager.setSearch(task.userId, keyword, hqItems, 8);

    let saveDetail = '';
    if (task.autoSave !== false) {
      const autoRes = await this.trySaveQuarkCandidates(hqItems, task.userId, '电影', keyword);
      if (autoRes.success) {
        saveDetail = `\n📂 已自动为你洗版转存至夸克网盘：【${autoRes.targetPath}】\n${autoRes.message}`;
      }
    }

    task.status = 'completed';
    task.enabled = false;
    this.saveTasks();

    return [
      `💎 【4K 洗版命中】《${keyword}》高规格画质出炉啦！`,
      `─────────────────────────`,
      `🎬 命中片源：${bestHq.title}`,
      `🔗 资源链接：${bestHq.shareUrl}`,
      saveDetail,
      `─────────────────────────`,
      `💬 已为你放入当前搜索会话，直接回复「1」也可以一键操作！`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 扩展 B：每周五晚周末观影片单周报
   */
  private async runFridayWeekly(task: ScheduledTask): Promise<string> {
    const recommender = AiRecommender.getInstance();
    const query = '推荐3部适合周末放松看的近期高分热门电影或口碑好剧';
    const result = await recommender.generateXiaohongshuNote({
      query,
      type: 'movie',
      tag: '热门',
      page: 1,
      userId: task.userId,
    });

    this.sessionManager.setHot(task.userId, 'movie', result.subjects, '热门', 1, 6, query);

    return [
      `🍿 【周五下班 · 周末观影精选周报】`,
      `辛苦一周啦！为你挑好了这周末最值得窝在沙发里看的好片：`,
      `─────────────────────────`,
      result.formattedNote,
    ].join('\n');
  }

  /**
   * 扩展 C：夸克网盘容量预警 + 定时防和谐静默巡检
   */
  private async runDiskGuard(task: ScheduledTask, isManual: boolean): Promise<string | null> {
    const userPlan = this.userManager.getUserPlan(task.userId);
    const customCookie = userPlan.quarkCookie;

    if (!this.quarkService.isConfigured(customCookie)) {
      return isManual
        ? '⚠️ 尚未配置夸克网盘 Cookie，请先发送 `/set-quark <Cookie>` 绑定后再执行网盘守护巡检哦！'
        : null;
    }

    const info = await this.quarkService.getUserInfo(customCookie);
    const userRootDir = userPlan.saveRootDir || this.quarkService.getDefaultRootDir();
    const cleanRes = await this.quarkService.cleanUserWorkspace(userRootDir, {
      userId: task.userId,
      customCookie,
    });

    const allRenamed = cleanRes.renamedItems;
    const totalScanned = cleanRes.scannedCount;

    // 解析剩余空间是否低于阈值
    let isLowSpace = false;
    const minFreeGb = task.minFreeGb || 5;
    if (info && info.freeCapacity) {
      const gbMatch = info.freeCapacity.match(/([\d.]+)\s*GB/i);
      const mbMatch = info.freeCapacity.match(/([\d.]+)\s*MB/i);
      const tbMatch = info.freeCapacity.match(/([\d.]+)\s*TB/i);
      if (mbMatch && !tbMatch && !gbMatch) {
        isLowSpace = true;
      } else if (gbMatch && parseFloat(gbMatch[1]) < minFreeGb) {
        isLowSpace = true;
      }
    }

    // 如果是后台静默运行，且空间充足、也没有新和谐文件被改名，则保持安静或仅在有动作时推送
    if (!isManual && !isLowSpace && allRenamed.length === 0) {
      return null;
    }

    const lines: string[] = [
      `🛡️ 【夸克网盘定时守护巡检报告】`,
      `─────────────────────────`,
    ];

    if (info) {
      lines.push(`👤 账号昵称：${info.nickname}`);
      lines.push(`💾 容量状态：剩余 ${info.freeCapacity} / 总计 ${info.totalCapacity}`);
      if (isLowSpace) {
        lines.push(`🚨 【低容量预警】你的网盘剩余空间已不足 ${minFreeGb}GB，建议清理看过的旧片以免影响后续自动追更转存哦！`);
      } else {
        lines.push(`🟢 空间充裕，可随时放心自动追更转存。`);
      }
    }

    lines.push(`🔍 防和谐巡检：共扫描 ${totalScanned} 个目录/文件`);
    if (allRenamed.length > 0) {
      lines.push(`✨ 已自动为你洗白还原 ${allRenamed.length} 处混淆剧名：`);
      for (const item of allRenamed.slice(0, 5)) {
        lines.push(`  • 「${item.original}」➜ 《${item.restored}》`);
      }
    } else {
      lines.push(`✅ 当前网盘内剧名均十分规整，无火星文或拼音缩写混淆。`);
    }

    return lines.join('\n');
  }

  /**
   * 扩展 E：个人待看片单周末温馨翻牌提醒
   */
  private async runWatchlistRemind(task: ScheduledTask): Promise<string> {
    const plan = this.userManager.getUserPlan(task.userId);
    const list = plan.watchlist || [];

    if (list.length === 0) {
      // 如果追剧清单为空，自动降级为推送一部周末高分佳片
      return await this.runFridayWeekly(task);
    }

    // 优先选 planned / saving 状态或最近加入的一部
    const pendingList = list.filter((w) => w.status !== 'completed');
    const targetPool = pendingList.length > 0 ? pendingList : list;
    const picked = targetPool[Math.floor(Math.random() * targetPool.length)];

    const searchRes = await this.searcher.search({ keyword: picked.title });
    const items = (searchRes.items || []).filter((i) => this.isStrictTitleMatch(i, picked.title));
    if (items.length > 0) {
      this.sessionManager.setSearch(task.userId, picked.title, items, 8);
    }

    return [
      `📌 【你的待看片单 · 周末翻牌提醒】`,
      `─────────────────────────`,
      `还记得你之前收藏进片单的《${picked.title}》吗？今天正好有空，不如把它刷完吧！🎬`,
      items.length > 0
        ? `✅ 已为你备好 ${items.length} 条有效网盘活链，直接回复「1」即可一键转存到夸克网盘观看~`
        : `💡 直接发片名给我即可随时搜寻最新片源！`,
      `📋 你当前片单共有 ${list.length} 部作品，发送「/追剧」可查看完整片单。`,
    ].join('\n');
  }

  /**
   * 场景 3：自定义计划任务 / 定时提醒 / 定时搜片
   */
  private async runCustomReminder(task: ScheduledTask): Promise<string> {
    if (task.oneShotDate) {
      task.status = 'completed';
      task.enabled = false;
      this.saveTasks();
    }

    const payload = task.customPayload || task.title;

    if (task.customAction === 'search' && task.keyword) {
      // 若开启了自动转存，直接自动转存入夸克网盘
      if (task.autoSave) {
        const autoSaveResult = await this.tryAutoSaveByTitle(task.userId, task.keyword, '电影');
        if (autoSaveResult) {
          return [
            `⏰ 【延时转存完成】《${task.keyword}》`,
            `─────────────────────────`,
            `🎉 ${autoSaveResult}`,
            `📂 已为你整理入库至夸克网盘，随时打开手机即可观看！`,
          ].join('\n');
        }
      }

      const res = await this.searcher.search({ keyword: task.keyword });
      const items = (res.items || []).filter((i) => this.isStrictTitleMatch(i, task.keyword!));
      if (items.length > 0) {
        this.sessionManager.setSearch(task.userId, task.keyword, items, 8);
        const topList = items
          .slice(0, 4)
          .map((i, idx) => `${idx + 1}. [${i.panType === 'quark' ? '夸克' : '网盘'}] ${i.title}`)
          .join('\n');
        return [
          `⏰ 【定时搜片任务】《${task.keyword}》`,
          `─────────────────────────`,
          topList,
          `─────────────────────────`,
          `💬 回复数字序号（如「1」）即可一键转存！`,
        ].join('\n');
      }
    }

    // 检查提醒内容里是否带有《片名》，如果有则顺便帮用户把片源准备好
    const bookMatch = payload.match(/《([^》]+)》/);
    let extraResourceTip = '';
    if (bookMatch && bookMatch[1]) {
      const movieTitle = bookMatch[1].trim();
      const res = await this.searcher.search({ keyword: movieTitle });
      const validItems = (res.items || []).filter((i) => this.isStrictTitleMatch(i, movieTitle));
      if (validItems.length > 0) {
        this.sessionManager.setSearch(task.userId, movieTitle, validItems, 8);
        extraResourceTip = `\n\n🎬 我还顺手帮你搜好了《${movieTitle}》的 ${validItems.length} 条网盘活链，直接回复「1」就能一键转存到网盘看啦！`;
      }
    }

    return [
      `⏰ 【电视搭子 TVdazi 贴心定时提醒】`,
      `─────────────────────────`,
      `🔔 ${payload}${extraResourceTip}`,
    ].join('\n');
  }

  private async trySaveQuarkCandidates(
    items: CloudResource[],
    userId: string,
    defaultCategory: ResourceCategory,
    standardTitle: string,
    maxAttempts: number = 3
  ): Promise<{ success: boolean; targetPath?: string; message?: string; item?: CloudResource; attempt: number }> {
    const quarkItems = items.filter(
      (i) => (i.panType === 'quark' || i.shareUrl.includes('pan.quark.cn')) && this.isStrongAutoSaveMatch(i, standardTitle)
    );
    if (quarkItems.length === 0) {
      return { success: false, attempt: 0 };
    }

    const userPlan = this.userManager.getUserPlan(userId);
    const limit = Math.min(maxAttempts, quarkItems.length);
    let lastMsg = '';

    for (let i = 0; i < limit; i++) {
      const item = quarkItems[i];
      const category = item.category || CategoryClassifier.classify(item.title, item.rawText || '') || defaultCategory;
      const saveRes = await this.quarkService.saveShareFiles(item.shareId, item.passcode || '', category, {
        customCookie: userPlan.quarkCookie,
        rootDir: userPlan.saveRootDir,
        standardTitle,
        userId,
      });
      if (saveRes.success) {
        this.userManager.recordSave(userId, standardTitle, item.shareUrl, category);
        return {
          success: true,
          targetPath: saveRes.targetPath,
          message: saveRes.message,
          item,
          attempt: i + 1,
        };
      }
      lastMsg = saveRes.message;
    }

    return { success: false, message: lastMsg, attempt: limit };
  }

  private async tryAutoSaveByTitle(userId: string, title: string, defaultCategory: ResourceCategory): Promise<string | null> {
    const userPlan = this.userManager.getUserPlan(userId);
    const searchRes = await this.searcher.search({
      keyword: title,
      quality: userPlan.preferences?.preferredQuality,
    });
    const validItems = (searchRes.items || []).filter((i) => this.isStrictTitleMatch(i, title));
    if (validItems.length === 0) return null;

    const autoRes = await this.trySaveQuarkCandidates(validItems, userId, defaultCategory, title);
    if (autoRes.success) {
      return `⚡ 已为你把《${title}》自动转存进夸克网盘：【${autoRes.targetPath}】！`;
    }
    return null;
  }

  // ==================== 任务增删改查管理 API ====================

  public getUserTasks(userId: string): ScheduledTask[] {
    return this.tasks.filter((t) => t.userId === userId);
  }

  public addTask(taskData: Omit<ScheduledTask, 'id' | 'createdAt'>): ScheduledTask {
    // 防止完全重复的同类型任务叠加，若存在同名同类型任务则更新它
    const existing = this.tasks.find(
      (t) =>
        t.userId === taskData.userId &&
        t.type === taskData.type &&
        t.title === taskData.title &&
        t.status !== 'completed'
    );
    if (existing) {
      Object.assign(existing, taskData, { enabled: true, status: 'active' });
      this.saveTasks();
      return existing;
    }

    const newTask: ScheduledTask = {
      ...taskData,
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      status: taskData.status || 'active',
    };
    this.tasks.push(newTask);
    this.saveTasks();
    return newTask;
  }

  public deleteUserTaskByIndex(userId: string, index1Based: number): { success: boolean; task?: ScheduledTask; message: string } {
    const userTasks = this.getUserTasks(userId);
    if (index1Based < 1 || index1Based > userTasks.length) {
      return {
        success: false,
        message: `序号【${index1Based}】超出范围啦，你当前共有 ${userTasks.length} 个定时任务（发送 /tasks 可查看序号）。`,
      };
    }
    const target = userTasks[index1Based - 1];
    this.tasks = this.tasks.filter((t) => t.id !== target.id);
    this.saveTasks();
    return {
      success: true,
      task: target,
      message: `🗑️ 已为你删除第 ${index1Based} 个定时任务：【${target.title}】`,
    };
  }

  public clearUserTasks(userId: string): number {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.userId !== userId);
    this.saveTasks();
    return before - this.tasks.length;
  }

  public toggleUserTaskByIndex(
    userId: string,
    index1Based: number,
    enable: boolean
  ): { success: boolean; message: string } {
    const userTasks = this.getUserTasks(userId);
    if (index1Based < 1 || index1Based > userTasks.length) {
      return {
        success: false,
        message: `序号【${index1Based}】超出范围啦，你当前共有 ${userTasks.length} 个任务。`,
      };
    }
    const target = userTasks[index1Based - 1];
    target.enabled = enable;
    target.status = enable ? 'active' : 'paused';
    this.saveTasks();
    return {
      success: true,
      message: enable
        ? `▶️ 已恢复开启任务 #${index1Based}：【${target.title}】`
        : `⏸️ 已暂停任务 #${index1Based}：【${target.title}】`,
    };
  }

  public async runUserTaskByIndex(userId: string, index1Based: number): Promise<string> {
    const userTasks = this.getUserTasks(userId);
    if (index1Based < 1 || index1Based > userTasks.length) {
      return `序号【${index1Based}】超出范围啦，你当前共有 ${userTasks.length} 个定时任务，发送「/tasks」查看任务序号吧！`;
    }
    const target = userTasks[index1Based - 1];
    target.lastRunAt = Date.now();
    this.saveTasks();
    const res = await this.executeTask(target, true);
    return res || `✅ 已执行任务 #${index1Based}：【${target.title}】`;
  }

  /**
   * 格式化轮询间隔描述（如 10 -> "每 10 分钟"，60 -> "每 1 小时 (60分钟)"，120 -> "每 2 小时 (120分钟)"）
   */
  public static formatInterval(minutes: number): string {
    const m = Math.max(1, Math.round(minutes || 30));
    if (m >= 60 && m % 60 === 0) {
      return `每 ${m / 60} 小时（${m} 分钟）`;
    }
    return `每 ${m} 分钟`;
  }

  /**
   * 从自然语言或指令中解析轮询间隔（返回分钟数，支持“每10分钟”、“每隔2小时”、“半小时一次”、“15min”、“2h”等）
   */
  public static parseIntervalMinutes(text: string): number | undefined {
    const parseVal = (raw: string): number => {
      return ScheduleTimeParser.parseChineseNumber(raw);
    };

    // 1. 特殊口语：半小时 / 半个小时 / 一个半小时
    if (/(?:每|每隔|间隔)?\s*一个半\s*小时|(?:一个半小时)\s*(?:一次|一轮|一扫|巡检|扫描)?/.test(text)) {
      return 90;
    }
    if (/(?:每|每隔|间隔)?\s*半\s*个?\s*小时|(?:半个?小时)\s*(?:一次|一轮|一扫|巡检|扫描)?/.test(text)) {
      return 30;
    }
    if (/(?:每|每隔)\s*小时|(?:每|每隔)\s*个\s*小时/.test(text)) {
      return 60;
    }

    // 2. 匹配 分钟：每X分钟 / 每隔X分钟 / 间隔X分钟 / X分钟一次 / X分钟扫描一次 / 改为X分钟 / 设为X分钟 / Xmin / Xm
    const minMatch = text.match(
      /(?:(?:每|每隔|间隔|改成|改为|设为|设置成|设置为|调整为|调成)\s*)?(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅]+)\s*(?:分钟|分(?!钟|辨|享|类|数|析|集|季|片|账)|min(?:utes?)?|m\b)\s*(?:一次|一轮|一扫|巡检|扫描|检测|轮询)?/i
    );
    // 排除把“早上8点15分”里的“15分”误判为轮询间隔
    const isClockPoint = /(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:点|时|:|：)\s*(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*分/.test(
      text
    );
    if (minMatch && !isClockPoint) {
      const hasIntervalContext =
        /(?:每|每隔|间隔|轮询|扫描|巡检|检测|一次|一轮|频率|周期|改成|改为|设为|调整|调成|\/task-interval)/i.test(text);
      if (hasIntervalContext) {
        const val = parseVal(minMatch[1]);
        if (!isNaN(val) && val > 0) {
          return Math.max(1, Math.min(10080, Math.round(val)));
        }
      }
    }

    // 3. 匹配 小时：每X小时 / 每隔X个小时 / 间隔X小时 / X小时一次 / 改为X小时 / Xh
    const hourMatch = text.match(
      /(?:(?:每|每隔|间隔|改成|改为|设为|设置成|设置为|调整为|调成)\s*)?(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅]+)\s*(?:个?\s*小时|钟头|hours?|hr|h\b)\s*(?:一次|一轮|一扫|巡检|扫描|检测|轮询)?/i
    );
    if (hourMatch) {
      const hasIntervalContext =
        /(?:每|每隔|间隔|轮询|扫描|巡检|检测|一次|一轮|频率|周期|改成|改为|设为|调整|调成|\/task-interval)/i.test(text);
      if (hasIntervalContext) {
        const val = parseVal(hourMatch[1]);
        if (!isNaN(val) && val > 0) {
          return Math.max(1, Math.min(10080, Math.round(val * 60)));
        }
      }
    }

    return undefined;
  }

  /**
   * 动态修改已有任务的轮询间隔（支持按任务序号、按片名关键词或全部轮询任务批量修改）
   */
  public updateUserTaskInterval(
    userId: string,
    selector: { index1Based?: number; keyword?: string; all?: boolean },
    intervalMinutes: number
  ): { success: boolean; message: string } {
    const userTasks = this.getUserTasks(userId);
    if (userTasks.length === 0) {
      return {
        success: false,
        message: '你当前还没有创建任何定时或监控任务哦！可以先发「帮我追更《今天是太阳雨》」或「每10分钟蹲守《奥德赛》」来创建任务~',
      };
    }

    const safeMinutes = Math.max(1, Math.min(10080, Math.round(intervalMinutes)));
    const freqDesc = SchedulerService.formatInterval(safeMinutes);

    // 1. 按序号精准修改
    if (selector.index1Based !== undefined) {
      const idx = selector.index1Based;
      if (idx < 1 || idx > userTasks.length) {
        return {
          success: false,
          message: `序号【${idx}】超出范围啦，你当前共有 ${userTasks.length} 个任务（发送「/tasks」可查看任务序号）。`,
        };
      }
      const target = userTasks[idx - 1];
      target.intervalMinutes = safeMinutes;
      // 若原本是定点任务被用户主动改为轮询间隔模式，清除固定时刻使其按间隔运行
      if (target.scheduleTime) {
        delete target.scheduleTime;
        delete target.daysOfWeek;
        delete target.oneShotDate;
      }
      this.saveTasks();
      return {
        success: true,
        message: `⏱️ 已将任务 #${idx}【${target.title}】的扫描轮询间隔更新为：**${freqDesc}巡检一次**！`,
      };
    }

    // 2. 按片名/关键词匹配修改
    if (selector.keyword) {
      const cleanKey = selector.keyword.replace(/[《》\s]/g, '').toLowerCase();
      const matched = userTasks.filter(
        (t) =>
          (t.keyword && t.keyword.toLowerCase().includes(cleanKey)) ||
          t.title.toLowerCase().includes(cleanKey)
      );
      if (matched.length > 0) {
        for (const t of matched) {
          t.intervalMinutes = safeMinutes;
          if (t.scheduleTime) {
            delete t.scheduleTime;
          }
        }
        this.saveTasks();
        const names = matched.map((t) => `【${t.title}】`).join('、');
        return {
          success: true,
          message: `⏱️ 已将 ${names} 的扫描轮询间隔更新为：**${freqDesc}巡检一次**！`,
        };
      }
      return {
        success: false,
        message: `未找到与「${selector.keyword}」相关的监控任务，请发送「/tasks」查看当前任务序号后再试~`,
      };
    }

    // 3. 默认批量更新用户的轮询监控类任务（若无轮询任务则更新最后一条任务）
    const pollingTasks = userTasks.filter(
      (t) =>
        ['resource_watch', 'episode_chase', 'quality_upgrade'].includes(t.type) ||
        Boolean(t.intervalMinutes)
    );
    const targets = pollingTasks.length > 0 ? pollingTasks : [userTasks[userTasks.length - 1]];

    for (const t of targets) {
      t.intervalMinutes = safeMinutes;
      if (selector.all && t.scheduleTime) {
        delete t.scheduleTime;
      }
    }
    this.saveTasks();

    const names = targets.map((t) => `【${t.title}】`).join('、');
    return {
      success: true,
      message: `⏱️ 已将你的 ${targets.length} 个监控任务（${names}）轮询间隔统一调整为：**${freqDesc}巡检一次**！`,
    };
  }

  /**
   * 格式化展示用户的全部定时与监控任务列表
   */
  public renderUserTasks(userId: string): string {
    const userTasks = this.getUserTasks(userId);
    if (userTasks.length === 0) {
      return [
        '⏰ 【你的智能定时与监控中心】',
        '─────────────────────────',
        '你目前还没有创建定时或监控任务哦！可以直接像平时聊天一样对我说：',
        '',
        '🎬 1. 每日定时荐片：',
        '  • 「每天早上8点推送一部科幻电影给我」',
        '  • 「每天晚上9点推一部轻松韩剧」',
        '🛰️ 2. 新片资源全网蹲守（支持自定义轮询间隔）：',
        '  • 「《流浪地球3》有资源了通知我」',
        '  • 「每10分钟帮我蹲守《奥德赛》」',
        '📺 3. 热播剧全自动追更（支持自定义轮询间隔）：',
        '  • 「帮我追更《今天是太阳雨》」',
        '  • 「每隔15分钟追更《小城良方》」',
        '💎 4. 4K 高画质洗版监控：',
        '  • 「等《奥德赛》出4K了帮我存一下」',
        '🛡️ 5. 周报 / 网盘巡检 / 任意自定义任务：',
        '  • 「开启全套智能守护」（一键配齐早报+周报+网盘巡检+周末提醒）',
        '  • 「每天晚上10点提醒我看《小城良方》」',
      ].join('\n');
    }

    const typeBadges: Record<TaskType, string> = {
      daily_recommend: '🌅 每日荐片',
      resource_watch: '🛰️ 资源蹲守',
      episode_chase: '📺 自动追更',
      quality_upgrade: '💎 4K洗版',
      friday_weekly: '🍿 周五周报',
      disk_guard: '🛡️ 网盘守护',
      watchlist_remind: '📌 片单提醒',
      custom_reminder: '🔔 计划提醒',
    };

    const lines: string[] = [
      `⏰ 【你的智能定时与监控任务 (${userTasks.length}个)】`,
      `─────────────────────────`,
    ];

    userTasks.forEach((t, idx) => {
      const badge = typeBadges[t.type] || '⏰ 定时任务';
      const stateIcon =
        t.status === 'completed' ? '✅已完成' : t.enabled ? '🟢运行中' : '⏸️已暂停';
      let scheduleDesc = '';
      if (t.scheduleTime) {
        if (t.oneShotDate) {
          scheduleDesc = `${t.oneShotDate} ${t.scheduleTime}`;
        } else if (t.daysOfWeek && t.daysOfWeek.length > 0) {
          const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
          scheduleDesc = `每${t.daysOfWeek.map((d) => dayNames[d]).join('/')} ${t.scheduleTime}`;
        } else {
          scheduleDesc = `每天 ${t.scheduleTime}`;
        }
      } else {
        scheduleDesc = `${SchedulerService.formatInterval(t.intervalMinutes || 30)}巡检`;
      }

      const extraInfo =
        t.type === 'episode_chase' && t.lastEpisode
          ? ` (已追至第${t.lastEpisode}集)`
          : t.autoSave
          ? ' [自动转存]'
          : '';

      lines.push(`${idx + 1}. [${badge}] ${t.title}${extraInfo}`);
      lines.push(`   ⏱️ 触发：${scheduleDesc} | 状态：${stateIcon}`);
    });

    lines.push(`─────────────────────────`);
    lines.push(`💡 快捷操作指令：`);
    lines.push(`• 发「执行任务 1」或「/task-run 1」：立即测试触发第1个任务`);
    lines.push(`• 发「把任务1间隔改成10分钟」或「/task-interval 1 10」：修改轮询间隔`);
    lines.push(`• 发「删除任务 1」或「/task-del 1」：删除对应任务`);
    lines.push(`• 发「暂停任务 1」/「恢复任务 1」：暂停或恢复任务`);
    return lines.join('\n');
  }

  /**
   * 一键开启全套推荐智能定时方案（当用户说“开启全套智能守护”或“我全都要”时）
   */
  public setupFullSuiteForUser(userId: string): ScheduledTask[] {
    const created: ScheduledTask[] = [];

    // 1. 每天早上 08:00 晨间高分电影推荐
    created.push(
      this.addTask({
        userId,
        type: 'daily_recommend',
        title: '每天早上08:00精选高分电影推送',
        enabled: true,
        scheduleTime: '08:00',
        mediaType: 'movie',
        tag: '豆瓣高分',
        query: '推荐一部适合今天看的豆瓣高分口碑电影',
        autoSave: false,
      })
    );

    // 2. 每周五晚上 19:00 周末观影片单周报
    created.push(
      this.addTask({
        userId,
        type: 'friday_weekly',
        title: '每周五19:00周末观影热播片单周报',
        enabled: true,
        scheduleTime: '19:00',
        daysOfWeek: [5],
      })
    );

    // 3. 每天早上 09:00 夸克网盘容量预警与防和谐静默巡检
    created.push(
      this.addTask({
        userId,
        type: 'disk_guard',
        title: '每日夸克网盘容量预警与防和谐洗白巡检',
        enabled: true,
        scheduleTime: '09:00',
        minFreeGb: 5,
      })
    );

    // 4. 每周六晚上 20:00 个人待看片单温馨翻牌提醒
    created.push(
      this.addTask({
        userId,
        type: 'watchlist_remind',
        title: '每周六20:00个人待看片单温馨提醒',
        enabled: true,
        scheduleTime: '20:00',
        daysOfWeek: [6],
      })
    );

    return created;
  }

  // ==================== 自然语言识别与解析器 ====================

  /**
   * 快速嗅探用户输入是否属于定时/延时/蹲守/追更/任务管理意图
   */
  public isScheduleIntent(text: string): boolean {
    const trimmed = text.trim();
    if (
      /^(?:\/tasks|\/schedule|\/定时|\/watch|\/追更|\/蹲守|\/task-run|\/task-del|\/task-all|\/task-interval|定时任务|计划任务|我的任务|我的定时|查看任务|任务列表|执行任务\s*\d+|测试任务\s*\d+|删除任务\s*\d+|取消任务\s*\d+|暂停任务\s*\d+|恢复任务\s*\d+|清空任务|开启全套)/i.test(
        trimmed
      ) ||
      /(?:设置|创建|新建|加个|定个|设个).*(?:定时任务|计划任务|定时提醒|闹钟)/i.test(trimmed)
    ) {
      return true;
    }

    // 修改轮询间隔意图：把任务1间隔改成10分钟 / 修改扫描间隔为15分钟 / 轮询频率设为1小时
    if (
      /(?:把|将|修改|设置|调整|改|设).*?(?:任务\s*\d+|轮询|扫描|巡检|监控|追更|蹲守|间隔|频率|周期).*?(?:改成|改为|设为|设置成|调整为|调成|间隔|频率)?.*?(?:\d+|[零〇一二两三四五六七八九十百千万廿卅半]+)\s*(?:分钟|分|个?小时|min|m\b|h\b)/i.test(
        trimmed
      ) ||
      /^(?:轮询间隔|扫描间隔|巡检间隔|监控间隔|追更间隔|蹲守间隔)\s*(?:改成|改为|设为|设置成)?\s*(?:\d+|[零〇一二两三四五六七八九十百千万廿卅半]+)/i.test(
        trimmed
      )
    ) {
      return true;
    }

    // 带有“每X分钟 / 每隔X小时”的轮询创建意图
    if (
      /(?:每|每隔|间隔)\s*(?:\d+|[零〇一二两三四五六七八九十百千万廿卅半]+)\s*(?:分钟|分|个?小时|钟头|min|m\b|h\b).*?(?:蹲|追更|订阅|监控|扫描|巡检|检测|查|搜|推|发|荐|提醒|叫我|通知)/i.test(
        trimmed
      )
    ) {
      return true;
    }

    // 相对延时意图（兼容省略“后”字的口语，如“两分钟给我推荐一部好看的电影”、“半小时转存到网盘”、“10分钟后提醒我”）
    const hasDurationFilter = /(?:\d+|[零〇一二两三四五六七八九十百千万廿卅半]+)\s*(?:分钟|分|个?小时|秒)\s*(?:以内|以上|以下|左右|的(?:电影|剧|片|动漫))/i.test(
      trimmed
    );
    if (!hasDurationFilter) {
      if (
        /^(?:请|麻烦)?(?:帮我|给我)?(?:等|过)?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅半]+)\s*(?:个?\s*(?:小时|钟头)|分钟|分(?!钟|辨|享|类|数|析|集|季|片|账)|秒钟?|min|sec|h\b|m\b|s\b)\s*(?:之?后|再|内)?\s*(?:给我|帮我|替我|向我|为我)?.*?(?:推|发|荐|提醒|叫|通知|搜|查|转存|存|入库|看|来)/i.test(
          trimmed
        ) ||
        /(?:等|过)?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅半]+)\s*(?:个?\s*(?:小时|钟头)|分钟|分(?!钟|辨|享|类|数|析|集|季|片|账)|秒钟?|min|sec)\s*(?:之?后|再).*?(?:推|发|荐|提醒|叫|通知|搜|查|转存|存|入库|看|来)/i.test(
          trimmed
        ) ||
        /(?:推|发|荐|提醒|叫|通知|搜|转存|存).*?(?:等|过)?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅半]+)\s*(?:个?\s*(?:小时|钟头)|分钟|分|秒钟?|min|sec)\s*(?:之?后|再)/i.test(
          trimmed
        )
      ) {
        return true;
      }
    }

    // 场景1 & 场景3：定点/周期/单日时间 + 动作（支持每天/每周/工作日/周末/明天/后天/今晚/今天，也支持直接写时刻如“8点半提醒我”、“晚上9点推荐一部电影”、“18:30帮我存”）
    const hasExplicitDayPrefix =
      /(?:每天|每日|每晚|每早|每周[一二三四五六日天末]?|周[一二三四五六日天末]|工作日|周末|明天|明早|明晚|后天|今晚|今早|今天)/i.test(
        trimmed
      );
    const hasExplicitClock =
      /(?:\d{1,2}\s*[:：]\s*\d{1,2}|(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:点|时)(?:\s*(?:\d{1,2}|半|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*分?)?|(?:早上|早晨|上午|中午|下午|傍晚|晚上|夜里|凌晨)\s*(?:(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:点|时)?)?)/i.test(
        trimmed
      );
    const hasScheduleVerb = /(?:推|发|荐|提醒|叫我|通知|搜|查|转存|存|入库|检查|巡检)/i.test(trimmed);

    if (hasExplicitDayPrefix && hasExplicitClock && hasScheduleVerb) {
      return true;
    }

    // 省略“每天/今天”但带具体钟点+定时动作（如“晚上9点推荐一部悬疑剧”、“17:30提醒我下班”、“早上8点半帮我搜《三体》”）
    const hasConcreteClock =
      /\d{1,2}\s*[:：]\s*\d{1,2}|(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:点|时)(?:半|\s*(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*分?)?/i.test(
        trimmed
      );
    if (
      hasConcreteClock &&
      !/豆瓣\s*\d+\s*点|\d+\s*点\s*\d+\s*分制|几\s*点|八点档|黄金档|午夜档/.test(trimmed) &&
      /(?:推|发|荐|提醒|叫我|通知|准时|定时)/.test(trimmed)
    ) {
      return true;
    }

    // 明确“提醒我/叫我/通知我”且不是纯提问（排除“怎么通知我”之类）
    if (/(?:^|每天|每周|明天|今晚|后天|早上|晚上|点|后)\s*(?:提醒我|叫我|通知我)/i.test(trimmed) && !/[？?]$/.test(trimmed)) {
      return true;
    }

    // 场景2：有资源了通知我 / 蹲守 / 出资源了帮我存
    if (
      /(?:有资源了|出资源了|出了资源|资源出了|有片源了|出片了|上线了|放出来了|有了).*?(?:推送|通知|告诉我|发给我|提醒|帮我存|自动存|转存|存一下)/i.test(
        trimmed
      ) ||
      /(?:帮我|给我|替我)?(?:蹲守|蹲一下|蹲一个|盯着|监控)\s*《?[^》]+》?/i.test(trimmed) ||
      /^蹲\s*《?[^》]+》?/i.test(trimmed)
    ) {
      return true;
    }

    // 扩展A：连载追更
    if (
      /(?:^|请|帮我|给我|我要|自动)(?:追更|订阅更新)/i.test(trimmed) ||
      /(?:更新了|有更新|出新集|更了).*?(?:通知|提醒|存|转存|推|告诉)/i.test(trimmed)
    ) {
      return true;
    }

    // 扩展D：4K 洗版监控（要求含明确监控/等待条件，避免把立即搜/存4K资源误判为后台监控）
    if (
      /(?:出\s*4[kK]|有\s*4[kK]\s*了|出\s*(?:高画质|原盘|杜比)|洗版).*?(?:通知|提醒|帮我存|自动存|转存|告诉我|蹲|监控)/i.test(
        trimmed
      ) ||
      /(?:蹲守|蹲|监控|等).*?(?:4[kK]|高画质|洗版|原盘|杜比)/i.test(trimmed)
    ) {
      return true;
    }

    // 扩展 B / C / E 快捷开启
    if (
      /(?:开启|打开|设置|订阅).*?(?:周末.*?周报|观影.*?周报|片单.*?周报|网盘.*?巡检|防和谐.*?巡检|容量.*?预警|网盘.*?守护|待看.*?提醒|片单.*?提醒|全套.*?定时|全套.*?守护)/i.test(
        trimmed
      )
    ) {
      return true;
    }

    return false;
  }

  /**
   * 结合当前用户的榜单/搜索/近期讨论上下文，把“10 / 第10部 / 本页第1个 / 这部”准确还原成真实影视片名，
   * 绝不允许把纯数字或“第X部”直接当成片名创建监控任务。
   */
  private resolveTargetMovieTitle(userId: string, rawInput: string): { title?: string; error?: string } {
    const clean = SchedulerService.extractCleanMovieTitle(rawInput);
    if (!clean) return {};

    // 1. 明确包含书名号《片名》时直接信任
    if (/《[^》]+》/.test(rawInput)) {
      return { title: clean };
    }

    // 2. 指代词（“这部 / 那部 / 它 / 上面那部 / 刚才那部”）
    if (/^(?:这部|这个|它|那部|那个|上面那部|刚才那部|最新那部)$/i.test(clean)) {
      const recent = this.sessionManager.getRecentTargetTitle(userId);
      if (recent) return { title: recent };
      return { error: '还没确定你说的是哪一部呀，直接把片名发给我，比如「蹲守《复仇者联盟5》」~' };
    }

    // 3. 序号引用（“10”、“第10部”、“第1个”、“本页第2部”）
    const strippedForSel = clean.replace(/(?:这个|这部|那部|那个)$/, '').trim();
    const sel = SessionManager.parseSelection(strippedForSel);
    const ordinalMatch = clean.match(/^(?:本页|当前页|这页)?\s*(?:第)?\s*([0-9]{1,3}|[一二两三四五六七八九十]+)\s*(?:个|条|部|名)?$/);
    const parsedIndex = sel?.index ?? (ordinalMatch ? SessionManager.parseNumberSelection(ordinalMatch[0]) : null);

    if (parsedIndex !== null && (sel || ordinalMatch || /^\d{1,3}$/.test(clean))) {
      const lastType = this.sessionManager.getLastActiveType(userId);
      const hotSess = this.sessionManager.getHot(userId);
      const searchSess = this.sessionManager.getSearch(userId);

      const targetList: Array<{ title: string }> | undefined =
        lastType === 'hot' && hotSess?.items?.length
          ? hotSess.items
          : searchSess?.items?.length
          ? searchSess.items
          : hotSess?.items?.length
          ? hotSess.items
          : undefined;

      if (!targetList || targetList.length === 0) {
        return {
          error: `没找到对应的第 ${parsedIndex} 部片单记录哦，请直接发片名给我（比如「蹲守《复仇者联盟5》」），或先查一下待映/热榜~`,
        };
      }

      const activePage = lastType === 'hot' || !searchSess ? hotSess?.page || 1 : searchSess.page || 1;
      const activeSize = lastType === 'hot' || !searchSess ? hotSess?.pageSize || 10 : searchSess.pageSize || 8;
      const finalIdx = sel?.isPageRelative && activePage > 1 ? (activePage - 1) * activeSize + parsedIndex : parsedIndex;

      if (finalIdx < 1 || finalIdx > targetList.length) {
        return {
          error: `当前列表一共只有 ${targetList.length} 部，序号 ${finalIdx} 超出范围啦~ 请选 1~${targetList.length} 之间的数字，或直接发片名给我。`,
        };
      }

      const pickedTitle = String(targetList[finalIdx - 1]?.title || '').replace(/[《》]/g, '').trim();
      if (!pickedTitle) {
        return { error: `第 ${finalIdx} 项没有取到有效片名，麻烦直接发片名给我~` };
      }
      return { title: pickedTitle };
    }

    // 4. 兜底拦截裸数字
    if (/^\d{1,4}$/.test(clean)) {
      return { error: `没找到序号「${clean}」对应的影视作品，麻烦直接把片名告诉我哦~` };
    }

    return { title: clean };
  }

  /**
   * 从自然语言文本中解析时间（委托给 ScheduleTimeParser 模块）
   */
  public static parseTimeFromText(text: string): {
    timeStr: string;
    daysOfWeek?: number[];
    oneShotDate?: string;
    isRelative?: boolean;
    triggerAt?: number;
    invalid?: boolean;
  } {
    return ScheduleTimeParser.parseTimeFromText(text);
  }

  /**
   * 提取自然语言中的目标片名（委托给 ScheduleTimeParser 模块）
   */
  public static extractCleanMovieTitle(text: string): string {
    return ScheduleTimeParser.extractCleanMovieTitle(text);
  }

  /**
   * 供 LLM 工具调用的结构化创建定时/延时任务入口
   */
  public async createStructuredTask(
    userId: string,
    params: {
      action_type?: string;
      instruction?: string;
      delay_minutes?: number;
      schedule_time?: string;
      interval_minutes?: number;
      one_shot?: boolean;
      keyword?: string;
      content?: string;
      auto_save?: boolean;
    }
  ): Promise<string> {
    const rawInstruction = (params.instruction || '').trim();
    const hasDelay = typeof params.delay_minutes === 'number' && Number.isFinite(params.delay_minutes) && params.delay_minutes > 0;
    const hasInterval = typeof params.interval_minutes === 'number' && Number.isFinite(params.interval_minutes) && params.interval_minutes > 0;
    const scheduleMatch = (params.schedule_time || '').trim().match(/^(\d{1,2})[:：](\d{1,2})$/);
    if (params.schedule_time && !scheduleMatch) return '⏰ 时间格式无法识别，请使用 24 小时制格式，例如 08:30。';
    if (scheduleMatch && (Number(scheduleMatch[1]) > 23 || Number(scheduleMatch[2]) > 59)) {
      return '⏰ 时间超出有效范围，请填写 00:00 至 23:59 之间的时间。';
    }

    // 管理类或无结构化字段时，交回自然语言命令管道处理
    if (
      !params.action_type &&
      !hasDelay &&
      !hasInterval &&
      !scheduleMatch &&
      rawInstruction
    ) {
      return this.handleNaturalLanguageCommand(rawInstruction, userId);
    }
    if (
      rawInstruction &&
      /^(?:\/tasks|\/schedule|\/定时|定时任务|我的任务|我的定时|查看任务|任务列表|\/task-|执行任务|测试任务|运行任务|删除任务|取消任务|移除任务|清空|暂停任务|恢复任务|开启任务|开启全套)/i.test(rawInstruction)
    ) {
      return this.handleNaturalLanguageCommand(rawInstruction, userId);
    }

    const computeFutureBeijing = (offsetMs: number) => {
      const targetMs = Date.now() + offsetMs;
      const bj = new Date(targetMs + new Date(targetMs).getTimezoneOffset() * 60000 + 8 * 3600000);
      const y = bj.getFullYear();
      const mo = String(bj.getMonth() + 1).padStart(2, '0');
      const d = String(bj.getDate()).padStart(2, '0');
      const h = String(bj.getHours()).padStart(2, '0');
      const mi = String(bj.getMinutes()).padStart(2, '0');
      return { triggerAt: targetMs, oneShotDate: `${y}-${mo}-${d}`, timeStr: `${h}:${mi}` };
    };

    const parsedFromText = rawInstruction ? SchedulerService.parseTimeFromText(rawInstruction) : undefined;
    if (parsedFromText?.invalid && !hasDelay && !hasInterval && !scheduleMatch) {
      return '⏰ 我没有识别出有效时间，请检查小时、分钟或延时时长后再试。';
    }
    let timeStr = parsedFromText?.timeStr || '20:00';
    let oneShotDate = parsedFromText?.oneShotDate;
    let triggerAt = parsedFromText?.triggerAt;
    let isRelative = Boolean(parsedFromText?.isRelative);
    let intervalMinutes = hasInterval ? Math.max(1, Math.min(10080, Math.round(params.interval_minutes!))) : undefined;

    if (hasDelay) {
      const future = computeFutureBeijing(Math.round(params.delay_minutes! * 60000));
      timeStr = future.timeStr;
      oneShotDate = future.oneShotDate;
      triggerAt = future.triggerAt;
      isRelative = true;
      intervalMinutes = undefined;
    } else if (scheduleMatch) {
      const hh = Math.max(0, Math.min(23, parseInt(scheduleMatch[1], 10)));
      const mm = Math.max(0, Math.min(59, parseInt(scheduleMatch[2], 10)));
      timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      if (params.one_shot && !oneShotDate) {
        const now = new Date();
        const bj = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
        if (bj.getHours() > hh || (bj.getHours() === hh && bj.getMinutes() >= mm)) {
          bj.setDate(bj.getDate() + 1);
        }
        oneShotDate = `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}-${String(bj.getDate()).padStart(2, '0')}`;
      }
    }

    const actionType = params.action_type || (hasDelay && /(?:转存|存到网盘|存入网盘)/.test(rawInstruction) ? 'delayed_transfer' : hasDelay && /(?:推荐|推送|电影|剧)/.test(rawInstruction) ? 'delayed_recommend' : 'custom_reminder');

    if (actionType === 'delayed_transfer') {
      let targetTitle = (params.keyword || '').trim();
      if (!targetTitle && rawInstruction) {
        targetTitle = SchedulerService.extractCleanMovieTitle(rawInstruction);
      }
      if (!targetTitle || /^(?:这部|这个|它|片子|电影|剧集|网盘|夸克网盘|夸克)$/.test(targetTitle)) {
        targetTitle = this.sessionManager.getRecentTargetTitle(userId) || '';
      }
      if (!targetTitle) {
        return '🤔 我暂时没找到你最近看过或搜索过的具体片名。\n请带上片名再说一次，例如：「半小时后把《流浪地球2》转存到网盘」。';
      }
      const task = this.addTask({
        userId,
        type: 'custom_reminder',
        title: `延时转存：《${targetTitle}》到夸克网盘`,
        enabled: true,
        scheduleTime: intervalMinutes ? undefined : timeStr,
        intervalMinutes,
        oneShotDate: intervalMinutes ? undefined : oneShotDate,
        triggerAt: intervalMinutes ? undefined : triggerAt,
        customAction: 'search',
        keyword: targetTitle,
        autoSave: true,
        customPayload: rawInstruction || `转存《${targetTitle}》到网盘`,
      });
      return [
        `记好啦！到 ${oneShotDate ? `${oneShotDate} ${timeStr}` : `每天 ${timeStr}`} 我就去帮你翻《${targetTitle}》的好源存进网盘~`,
        `想查进度或者取消，随时发 /tasks 看一眼就成。`,
      ].join('\n');
    }

    if (actionType === 'daily_recommend' || actionType === 'delayed_recommend') {
      const refText = (params.content || rawInstruction || '推荐一部好看的电影').trim();
      const isMovie = /(?:电影|大片|院线|影史|片)/i.test(refText) && !/(?:电视剧|剧集|韩剧|美剧|日剧|国产剧)/i.test(refText);
      const mediaType: 'movie' | 'tv' = isMovie ? 'movie' : 'tv';
      const typeLabel = mediaType === 'movie' ? '高分电影' : '热门好剧';
      const useInterval = Boolean(intervalMinutes && !isRelative && !scheduleMatch);
      const task = this.addTask({
        userId,
        type: 'daily_recommend',
        title: isRelative || oneShotDate
          ? `延时任务：${timeStr} 推送一部${typeLabel}`
          : useInterval
          ? `${SchedulerService.formatInterval(intervalMinutes!)}推送一部${typeLabel}`
          : `每天 ${timeStr} 推送一部${typeLabel}`,
        enabled: true,
        scheduleTime: useInterval ? undefined : timeStr,
        intervalMinutes: useInterval ? intervalMinutes : undefined,
        oneShotDate: useInterval ? undefined : oneShotDate,
        triggerAt: useInterval ? undefined : triggerAt,
        mediaType,
        tag: '热门',
        query: params.content || `推荐一部好看的${typeLabel}`,
        autoSave: Boolean(params.auto_save),
      });
      return [
        `好嘞！${useInterval ? SchedulerService.formatInterval(intervalMinutes!) : oneShotDate ? `${oneShotDate} ${timeStr}` : `每天 ${timeStr}`} 我准时给你挑${typeLabel}发过来~`,
        `（记在「${task.title}」里了，随时发 /tasks 能管理）`,
      ].join('\n');
    }

    if (actionType === 'resource_watch' || actionType === 'episode_chase' || actionType === 'quality_upgrade') {
      const synthesized = `${intervalMinutes ? `每${intervalMinutes}分钟` : ''}${actionType === 'episode_chase' ? '追更' : actionType === 'quality_upgrade' ? '出4K了存' : '蹲守'}${params.keyword ? `《${params.keyword}》` : rawInstruction}`;
      return this.handleNaturalLanguageCommand(synthesized, userId);
    }

    if (actionType === 'custom_reminder') {
      const reminderText = (params.content || rawInstruction || '定时提醒').trim();
      const useInterval = Boolean(intervalMinutes && !isRelative && !scheduleMatch);
      const task = this.addTask({
        userId,
        type: 'custom_reminder',
        title: isRelative || oneShotDate ? `延时任务：${reminderText}` : `定时任务：${reminderText}`,
        enabled: true,
        scheduleTime: useInterval ? undefined : timeStr,
        intervalMinutes: useInterval ? intervalMinutes : undefined,
        oneShotDate: useInterval ? undefined : oneShotDate,
        triggerAt: useInterval ? undefined : triggerAt,
        customAction: 'remind',
        keyword: (params.keyword || '').trim() || undefined,
        autoSave: Boolean(params.auto_save),
        customPayload: reminderText,
      });
      return [
        `收到！已经给你备忘好「${reminderText}」，${useInterval ? `${SchedulerService.formatInterval(intervalMinutes!)}喊你一次` : oneShotDate ? `${oneShotDate} ${timeStr} 准时叫你` : `每天 ${timeStr} 准时提醒你`}~`,
      ].join('\n');
    }

    return this.handleNaturalLanguageCommand(rawInstruction || params.content || '', userId);
  }

  /**
   * 统一处理自然语言定时任务创建与管理
   */
  public async handleNaturalLanguageCommand(text: string, userId: string): Promise<string> {
    const trimmed = text.trim();

    // 1. 查看任务列表
    if (/^(?:\/tasks|\/schedule|\/定时|定时任务|我的任务|我的定时|查看任务|任务列表)$/i.test(trimmed)) {
      return this.renderUserTasks(userId);
    }

    // 2. 立即执行测试某条任务
    const runMatch = trimmed.match(/^(?:\/task-run|执行任务|测试任务|运行任务)\s*(\d+)$/i);
    if (runMatch) {
      const idx = parseInt(runMatch[1], 10);
      return await this.runUserTaskByIndex(userId, idx);
    }

    // 3. 删除某条任务或清空任务
    const delMatch = trimmed.match(/^(?:\/task-del|删除任务|取消任务|移除任务)\s*(\d+)$/i);
    if (delMatch) {
      const idx = parseInt(delMatch[1], 10);
      return this.deleteUserTaskByIndex(userId, idx).message;
    }
    if (/^(?:清空任务|清空定时任务|删除所有任务)$/i.test(trimmed)) {
      const count = this.clearUserTasks(userId);
      return `🗑️ 已为你清空全部 ${count} 个定时与监控任务！`;
    }

    // 4. 暂停 / 恢复任务
    const pauseMatch = trimmed.match(/^(?:暂停任务)\s*(\d+)$/i);
    if (pauseMatch) {
      return this.toggleUserTaskByIndex(userId, parseInt(pauseMatch[1], 10), false).message;
    }
    const resumeMatch = trimmed.match(/^(?:恢复任务|开启任务)\s*(\d+)$/i);
    if (resumeMatch) {
      return this.toggleUserTaskByIndex(userId, parseInt(resumeMatch[1], 10), true).message;
    }

    // 4.5 修改已有任务的轮询间隔：
    // 支持 `/task-interval 1 10`、`/task-interval all 15`、或自然语言「把任务1的间隔改成10分钟」「把《奥德赛》扫描间隔改为15分钟」「把追更间隔设为20分钟」
    const cmdIntervalMatch = trimmed.match(/^\/task-interval\s+(all|\d+)\s+(.+)$/i);
    if (cmdIntervalMatch) {
      const targetArg = cmdIntervalMatch[1].toLowerCase();
      const rawInterval = cmdIntervalMatch[2].trim();
      const parsedMin =
        SchedulerService.parseIntervalMinutes(`每${rawInterval}`) ||
        (/^\d+$/.test(rawInterval) ? parseInt(rawInterval, 10) : undefined);
      if (!parsedMin) {
        return '⚠️ 请提供有效的轮询间隔时长哦，例如：`/task-interval 1 10`（10分钟）或 `/task-interval 1 2h`（2小时）';
      }
      if (targetArg === 'all') {
        return this.updateUserTaskInterval(userId, { all: true }, parsedMin).message;
      }
      return this.updateUserTaskInterval(userId, { index1Based: parseInt(targetArg, 10) }, parsedMin).message;
    }

    const isModifyIntervalIntent =
      /(?:把|将|修改|设置|调整|改|设).*?(?:任务\s*\d+|轮询|扫描|巡检|监控|追更|蹲守|间隔|频率|周期).*?(?:改成|改为|设为|设置成|调整为|调成|间隔|频率)/i.test(
        trimmed
      ) ||
      /^(?:轮询间隔|扫描间隔|巡检间隔|监控间隔|追更间隔|蹲守间隔)\s*(?:改成|改为|设为|设置成)?/i.test(trimmed);

    const parsedInterval = SchedulerService.parseIntervalMinutes(trimmed);
    if (isModifyIntervalIntent && parsedInterval) {
      const taskIdxMatch = trimmed.match(/(?:任务|序号|#)\s*(\d+)/);
      const bookMatch = trimmed.match(/《([^》]+)》/);
      if (taskIdxMatch) {
        return this.updateUserTaskInterval(userId, { index1Based: parseInt(taskIdxMatch[1], 10) }, parsedInterval).message;
      }
      if (bookMatch && bookMatch[1]) {
        return this.updateUserTaskInterval(userId, { keyword: bookMatch[1] }, parsedInterval).message;
      }
      return this.updateUserTaskInterval(userId, { all: /全部|所有/.test(trimmed) }, parsedInterval).message;
    }

    // 5. 一键开启全套智能守护
    if (/^(?:\/task-all|开启全套|开启全套智能守护|开启全部定时)$/i.test(trimmed)) {
      this.setupFullSuiteForUser(userId);
      return [
        `🎉 已为你一键配齐【电视搭子 (TVdazi) 全套智能定时守护】！`,
        `─────────────────────────`,
        this.renderUserTasks(userId),
      ].join('\n\n');
    }

    const wantAutoSave = /(?:自动存|自动转存|帮我存|存进网盘|存入网盘|存到网盘|直接存)/i.test(trimmed);
    const activeInterval = parsedInterval || 30;
    const activeFreqText = SchedulerService.formatInterval(activeInterval);

    // 6. 扩展 D：4K / 高画质洗版监控
    if (/(?:出\s*4[kK]|有\s*4[kK]|4[kK]\s*资源|4[kK]\s*原盘|高画质|洗版)/i.test(trimmed)) {
      const resolvedTarget = this.resolveTargetMovieTitle(userId, trimmed);
      if (resolvedTarget.error) return resolvedTarget.error;
      const movieTitle = resolvedTarget.title;
      if (movieTitle) {
        const task = this.addTask({
          userId,
          type: 'quality_upgrade',
          title: `《${movieTitle}》4K高画质洗版监控`,
          keyword: movieTitle,
          enabled: true,
          intervalMinutes: activeInterval,
          autoSave: true,
          targetQualities: ['4K', '2160P', 'REMUX', '杜比', 'HDR'],
        });
        const firstCheck = await this.runQualityUpgrade(task, true);
        if (task.status === 'completed') {
          return firstCheck || `💎 《${movieTitle}》已命中 4K 高规格片源！`;
        }
        return [
          `**💎 已帮你盯上《${movieTitle}》的 4K 高画质版**（${activeFreqText}巡检一次，出 4K / 原盘 / 杜比资源就自动帮你存网盘并喊你~）`,
          firstCheck ? `\n${firstCheck}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
    }

    // 7. 扩展 A：连载热播剧全自动追更入库
    if (
      /(?:^\/追更|帮我追更|给我追更|自动追更|追更|订阅更新)/i.test(trimmed) ||
      /(?:更新了|出新集了).*?(?:推送|通知|告诉我|发给我|提醒|帮我存|自动存|转存)/i.test(trimmed)
    ) {
      const resolvedTarget = this.resolveTargetMovieTitle(userId, trimmed.replace(/^\/追更\s*/i, ''));
      if (resolvedTarget.error) return resolvedTarget.error;
      const movieTitle = resolvedTarget.title;
      if (!movieTitle) {
        return '想追更哪部剧直接把片名或序号发我就行，比如「帮我追更《今天是太阳雨》」或「追更第1部」~';
      }
      const task = this.addTask({
        userId,
        type: 'episode_chase',
        title: `追更《${movieTitle}》`,
        keyword: movieTitle,
        enabled: true,
        intervalMinutes: activeInterval,
        autoSave: true,
        lastEpisode: 0,
        knownShareIds: [],
      });
      // 同时加入个人追剧片单
      this.userManager.addToWatchlist(userId, movieTitle);
      const firstCheck = await this.runEpisodeChase(task, true);
      if (task.status === 'completed') {
        return firstCheck || `📺 《${movieTitle}》全集已追更完毕并入库！`;
      }
      return [
        `**📺 已经开始帮你自动追更《${movieTitle}》啦**（${activeFreqText}巡检一次新集数，一有更新自动存网盘并通知你~）`,
        firstCheck ? `\n${firstCheck}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    // 8. 场景 2：某部未出资源电影/剧集全网蹲守监控
    if (
      /(?:^\/watch|^\/蹲守|帮我蹲守|帮我蹲|给我蹲|蹲守|蹲一下|蹲一个|^蹲\s*)/i.test(trimmed) ||
      /(?:有资源了|出资源了|出了资源|资源出了|有片源了|上线了).*?(?:推送|通知|告诉我|发给我|提醒|帮我存|自动存|转存)/i.test(trimmed)
    ) {
      const resolvedTarget = this.resolveTargetMovieTitle(userId, trimmed.replace(/^\/(?:watch|蹲守)\s*/i, ''));
      if (resolvedTarget.error) return resolvedTarget.error;
      const movieTitle = resolvedTarget.title;
      if (!movieTitle) {
        return '想蹲哪部片直接发片名或列表序号就行，比如「蹲守《复仇者联盟5》」或「蹲一下第1部」~';
      }
      const notifyOnly = /(?:通知我|提醒我|告诉我|发给我)/.test(trimmed) && !wantAutoSave;
      const task = this.addTask({
        userId,
        type: 'resource_watch',
        title: `蹲守《${movieTitle}》全网首发资源`,
        keyword: movieTitle,
        enabled: true,
        intervalMinutes: activeInterval,
        autoSave: wantAutoSave || !notifyOnly,
      });
      const firstCheck = await this.runResourceWatch(task, true);
      if (task.status === 'completed') {
        return firstCheck || `🎉 你蹲守的《${movieTitle}》已经有资源啦！`;
      }
      return [
        `**🛰️ 没问题，帮你把《${movieTitle}》挂上蹲守啦！**`,
        `后台每${activeFreqText.replace(/^每/, '')}自动帮你扫一遍全网频道，一旦出片源立刻微信喊你${task.autoSave ? '并自动存进夸克网盘' : ''}~`,
        firstCheck ? `\n${firstCheck}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    // 9. 扩展 B / C / E 专项开启
    if (/(?:周末周报|观影周报|片单周报|周五片单)/i.test(trimmed)) {
      const parsedTime = SchedulerService.parseTimeFromText(trimmed.includes('点') ? trimmed : '晚上7点');
      if (parsedTime.invalid) return '⏰ 我没有识别出有效时间，请检查时间后再设置任务。';
      const { timeStr } = parsedTime;
      const task = this.addTask({
        userId,
        type: 'friday_weekly',
        title: `每周五${timeStr}周末观影精选周报`,
        enabled: true,
        scheduleTime: timeStr,
        daysOfWeek: [5],
      });
      return `🍿 已开启【${task.title}】！每周五下班准时为你推送当周豆瓣高分新片与热剧榜单（发送「/tasks」可随时管理或发「执行任务 1」立即预览）。`;
    }

    if (/(?:网盘.*?巡检|防和谐.*?巡检|容量.*?预警|网盘.*?守护)/i.test(trimmed)) {
      if (parsedInterval && !trimmed.includes('点')) {
        const task = this.addTask({
          userId,
          type: 'disk_guard',
          title: `${activeFreqText}夸克网盘容量预警与防和谐巡检`,
          enabled: true,
          intervalMinutes: parsedInterval,
          minFreeGb: 5,
        });
        return `🛡️ 已开启【${task.title}】！后台将${activeFreqText}为你检查网盘剩余容量并自动清洗火星文混淆剧名。`;
      }
      const parsedTime = SchedulerService.parseTimeFromText(trimmed.includes('点') ? trimmed : '早上9点');
      if (parsedTime.invalid) return '⏰ 我没有识别出有效时间，请检查时间后再设置任务。';
      const { timeStr } = parsedTime;
      const task = this.addTask({
        userId,
        type: 'disk_guard',
        title: `每天${timeStr}夸克网盘容量预警与防和谐巡检`,
        enabled: true,
        scheduleTime: timeStr,
        minFreeGb: 5,
      });
      return `🛡️ 已开启【${task.title}】！每天定时为你检查网盘剩余容量并自动清洗火星文混淆剧名。`;
    }

    if (/(?:待看提醒|片单提醒)/i.test(trimmed)) {
      const parsedTime = SchedulerService.parseTimeFromText(trimmed.includes('点') ? trimmed : '晚上8点');
      if (parsedTime.invalid) return '⏰ 我没有识别出有效时间，请检查时间后再设置任务。';
      const { timeStr } = parsedTime;
      const task = this.addTask({
        userId,
        type: 'watchlist_remind',
        title: `每周末${timeStr}个人待看片单温馨提醒`,
        enabled: true,
        scheduleTime: timeStr,
        daysOfWeek: [6, 0],
      });
      return `📌 已开启【${task.title}】！每逢周末准时从你的「/追剧」片单中挑出好片提醒你观看。`;
    }

    // 10. 场景 1：每天/周期指定时间（或指定轮询间隔、相对延时）推送某类型电影或剧集推荐
    if (/(?:推荐|推送|推一部|推几部|发一部|来一部|安利)/i.test(trimmed)) {
      const parsedTime = SchedulerService.parseTimeFromText(trimmed);
      if (parsedTime.invalid) return '⏰ 我没有识别出有效时间，请检查时间后再设置任务。';
      const { timeStr, daysOfWeek, oneShotDate, isRelative, triggerAt } = parsedTime;
      const useIntervalMode = Boolean(
        parsedInterval && !isRelative && !/(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:点|时|:|：)/.test(trimmed)
      );
      const isMovie = /(?:电影|大片|院线|影史|片)/i.test(trimmed) && !/(?:电视剧|剧集|韩剧|美剧|日剧|国产剧)/i.test(trimmed);
      const mediaType: 'movie' | 'tv' = isMovie ? 'movie' : 'tv';

      // 提取类型标签
      const tagCandidates = [
        '科幻', '悬疑', '喜剧', '动作', '爱情', '犯罪', '恐怖', '惊悚', '治愈', '动画', '动漫',
        '纪录片', '家庭', '历史', '战争', '奇幻', '武侠', '古装', '韩剧', '美剧', '英剧', '日剧', '国产剧', '港片', '豆瓣高分',
      ];
      let matchedTag = '热门';
      for (const t of tagCandidates) {
        if (trimmed.includes(t)) {
          matchedTag = t;
          break;
        }
      }

      const typeLabel = matchedTag !== '热门' ? `${matchedTag}${mediaType === 'movie' ? '电影' : '剧集'}` : mediaType === 'movie' ? '高分电影' : '热门好剧';
      const strippedQuery = trimmed
        .replace(/^(?:请|帮我|给我|麻烦)?(?:设置|创建一个|定个|加个)?(?:定时任务|计划任务)?[：:\s]*/i, '')
        .replace(/^(?:(?:每|每隔|间隔)\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅半]{1,3})\s*(?:秒钟?|分钟?|分|个?小时|钟头|sec|s\b|min|m\b|h\b)\s*(?:一次|一轮)?)\s*(?:准时)?/i, '')
        .replace(/^(?:(?:过|等|在)?\s*(?:半\s*个?\s*(?:小时|钟头)|(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:个?半\s*(?:小时|钟头)|个?\s*小时|钟头|分钟?|秒钟?|min|m\b|sec|s\b|h\b))\s*(?:之?[后内]|以后|再)?)\s*(?:准时)?/i, '')
        .replace(/^(?:每天|每日|每晚|每早|每周[一二三四五六日天末]?|后天|明天|明早|今晚|今天)\s*(?:早上|上午|中午|下午|晚上|凌晨)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})?\s*(?:点|时|:|：)?(?:\d{1,2}|半)?\s*分?\s*(?:准时)?/i, '')
        .replace(/^(?:早上|上午|中午|下午|晚上|凌晨)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:点|时|:|：)(?:\d{1,2}|半)?\s*分?\s*(?:准时)?/i, '')
        .replace(/^(?:帮我|给我|请|麻烦)+/, '')
        .trim();
      const cleanQuery = strippedQuery && /(?:推荐|推送|推一部|推几部|发一部|来一部|安利)/.test(strippedQuery)
        ? strippedQuery
        : `推荐一部好看的${typeLabel}`;

      const task = this.addTask({
        userId,
        type: 'daily_recommend',
        title: isRelative
          ? `延时任务：${timeStr} 推送一部${typeLabel}`
          : useIntervalMode
          ? `${activeFreqText}推送一部${typeLabel}`
          : `每天 ${timeStr} 推送一部${typeLabel}`,
        enabled: true,
        scheduleTime: useIntervalMode ? undefined : timeStr,
        intervalMinutes: useIntervalMode ? parsedInterval : undefined,
        daysOfWeek: useIntervalMode || isRelative ? undefined : daysOfWeek,
        oneShotDate: useIntervalMode ? undefined : oneShotDate,
        triggerAt: useIntervalMode ? undefined : triggerAt,
        mediaType,
        tag: matchedTag,
        query: cleanQuery,
        autoSave: wantAutoSave,
      });

      const delayHint = isRelative ? `（${oneShotDate} ${timeStr} 准时送达）` : '';
      return [
        `⏰ 已为你设定好【${isRelative ? '延时' : '定时'}荐片任务】！`,
        `─────────────────────────`,
        `📌 任务名称：${task.title}`,
        `🕒 触发时间：${isRelative ? `${oneShotDate} ${timeStr}（准时推送）` : useIntervalMode ? `${activeFreqText}循环推送` : oneShotDate ? `${oneShotDate} ${timeStr}` : `每天 ${timeStr} 准时推送`}`,
        `🎬 推荐偏好：${typeLabel}${wantAutoSave ? '（并自动转存至夸克网盘）' : '（收到推送后回复 1 即可一键转存）'}`,
        `─────────────────────────`,
        `💡 任务已就绪${delayHint}，发送「/tasks」可随时查看任务进度。`,
      ].join('\n');
    }

    // 11. 场景 3：自定义计划任务 / 定时提醒 / 定时搜片 / 延时转存（支持定点、自定义轮询间隔与相对延时）
    const parsedTime = SchedulerService.parseTimeFromText(trimmed);
    if (parsedTime.invalid) return '⏰ 我没有识别出有效时间，请检查时间后再设置任务。';
    const { timeStr, daysOfWeek, oneShotDate, isRelative, triggerAt } = parsedTime;
    const useIntervalMode = Boolean(
      parsedInterval && !isRelative && !/(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:点|时|:|：)/.test(trimmed)
    );
    const isSearchAction = /(?:帮我搜|搜一下|搜索)/i.test(trimmed);
    const isTransferAction = /(?:转存|存到网盘|存进网盘|帮我存|自动存|存入网盘|存一下|存下|保存到网盘)/i.test(trimmed);
    let extractedTitle = SchedulerService.extractCleanMovieTitle(trimmed);

    // 如果是转存动作但文字里没写具体片名（如“半个小时后转存到网盘”），按最近时间优先从上下文嗅探目标片名
    if (isTransferAction && (!extractedTitle || /^(?:这部|这个|它|片子|电影|剧集|网盘|夸克网盘|夸克)$/.test(extractedTitle))) {
      extractedTitle = this.sessionManager.getRecentTargetTitle(userId) || '';
      if (!extractedTitle) {
        return '🤔 我暂时没找到你最近看过或搜索过的具体片名。\n请带上片名再说一次，例如：「半小时后把《流浪地球2》转存到网盘」。';
      }
    }

    const cleanReminder = trimmed
      .replace(/^(?:请|帮我|给我|麻烦)?(?:设置|创建一个|定个|加个)?(?:定时任务|计划任务)?[：:\s]*/i, '')
      .replace(/^(?:(?:每|每隔|间隔)\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅半]{1,3})\s*(?:秒钟?|分钟?|分|个?小时|钟头|sec|s\b|min|m\b|h\b)\s*(?:一次|一轮)?)\s*(?:准时)?(?:提醒我|叫我|通知我)?/i, '')
      .replace(/^(?:(?:过|等|在)?\s*(?:半\s*个?\s*(?:小时|钟头)|(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:个?半\s*(?:小时|钟头)|个?\s*小时|钟头|分钟?|秒钟?|min|m\b|sec|s\b|h\b))\s*(?:之?[后内]|以后|再)?)\s*(?:准时)?(?:提醒我|叫我|通知我)?/i, '')
      .replace(/^(?:每天|每日|每晚|每早|每周[一二三四五六日天末]?|后天|明天|明早|今晚|今天)\s*(?:早上|上午|中午|下午|晚上|凌晨)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})?\s*(?:点|时|:|：)?(?:\d{1,2}|半)?\s*分?\s*(?:准时)?(?:提醒我|叫我|通知我)?/i, '')
      .replace(/^(?:早上|上午|中午|下午|晚上|凌晨)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]{1,3})\s*(?:点|时|:|：)(?:\d{1,2}|半)?\s*分?\s*(?:准时)?(?:提醒我|叫我|通知我)?/i, '')
      .trim() || trimmed;

    const taskTitle = isTransferAction && extractedTitle
      ? `延时转存：《${extractedTitle}》到夸克网盘`
      : isRelative
      ? `延时任务：${cleanReminder}`
      : `定时任务：${cleanReminder}`;

    const task = this.addTask({
      userId,
      type: 'custom_reminder',
      title: taskTitle,
      enabled: true,
      scheduleTime: useIntervalMode ? undefined : timeStr,
      intervalMinutes: useIntervalMode ? parsedInterval : undefined,
      daysOfWeek: useIntervalMode || isRelative ? undefined : daysOfWeek,
      oneShotDate: useIntervalMode ? undefined : oneShotDate,
      triggerAt: useIntervalMode ? undefined : triggerAt,
      customAction: isTransferAction ? 'search' : isSearchAction ? 'search' : 'remind',
      keyword: extractedTitle || undefined,
      autoSave: isTransferAction || wantAutoSave,
      customPayload: cleanReminder,
    });

    const triggerDesc = isRelative
      ? `${oneShotDate} ${timeStr}（单次延时触发）`
      : useIntervalMode
      ? `${activeFreqText}循环执行`
      : oneShotDate
      ? `${oneShotDate} ${timeStr}（单次触发）`
      : `每天 ${timeStr} 准时执行`;

    return [
      `🔔 已为你创建【${isRelative ? '延时' : '定时'}计划任务】！`,
      `─────────────────────────`,
      `📌 任务内容：${task.title}`,
      `🕒 触发时间：${triggerDesc}`,
      isTransferAction && extractedTitle ? `💾 动作预定：到点将自动搜寻《${extractedTitle}》最佳活链并转存入你的网盘` : '',
      `─────────────────────────`,
      `💡 发送「/tasks」可管理你的全部任务，发送「执行任务 ${this.getUserTasks(userId).length}」可立即触发测试！`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}
