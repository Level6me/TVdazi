import { ResourceSearcher } from '../services/Searcher';
import { QuarkService } from '../services/QuarkService';
import { DoubanService } from '../services/DoubanService';
import { ChannelManager } from '../services/ChannelManager';
import { SessionManager } from '../services/SessionManager';
import { UserManager } from '../services/UserManager';
import { AiCorrector } from '../services/AiCorrector';
import { AiRecommender } from '../services/AiRecommender';
import { CategoryClassifier, ResourceCategory } from '../services/CategoryClassifier';
import { SchedulerService } from '../services/SchedulerService';
import { MetadataResolver, ResolvedMediaInfo } from '../services/MetadataResolver';
import { getPanRegistry } from '../services/pan';
import { WebhookService } from '../services/WebhookService';
import { RelayService } from '../services/RelayService';
import { UserProfileService } from '../services/UserProfileService';
import { WatchlistService } from '../services/WatchlistService';
import { pickVariant } from '../utils/HumanTone';
import { handleExtendedCommand } from './ExtendedCommands';
import { CloudResource } from '../types';
import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';

export class CommandHandler {
  private searcher: ResourceSearcher;
  private quarkService: QuarkService;
  private doubanService: DoubanService;
  private channelManager: ChannelManager;
  private sessionManager: SessionManager;
  private userManager: UserManager;
  private aiCorrector: AiCorrector;

  constructor() {
    this.searcher = new ResourceSearcher();
    this.quarkService = new QuarkService();
    this.doubanService = new DoubanService();
    this.channelManager = new ChannelManager();
    this.sessionManager = SessionManager.getInstance();
    this.userManager = UserManager.getInstance();
    this.aiCorrector = AiCorrector.getInstance();
  }

  private isFriendInviteIntent(trimmed: string): boolean {
    if (/^\/(?:share|invite)\b/i.test(trimmed)) return true;
    if (/https?:\/\/|pan\.quark\.cn|alipan\.com|aliyundrive\.com|drive\.uc\.cn|baidu\.com/i.test(trimmed)) {
      return false;
    }
    // 分享具体影视作品给好友时，不误判为生成机器人邀请二维码
    if (/(?:电影|电视剧|剧集|动漫|影片|这部|那部|第\s*\d+\s*部|《[^》]+》)/.test(trimmed) && !/(?:机器人|二维码|额度)/.test(trimmed)) {
      return false;
    }
    return (
      /^(?:分享|邀请|二维码|分享机器人|邀请二维码)$/.test(trimmed) ||
      /(?:推荐给朋友|分享给朋友|分享给好友|把你推荐给|加机器人|邀请好友|邀请朋友|好友邀请|生成邀请|邀请码|机器人二维码|授权二维码)/.test(
        trimmed
      )
    );
  }

  private hasDirectQuarkLink(trimmed: string): boolean {
    return !trimmed.startsWith('/') && /https?:\/\/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/i.test(trimmed);
  }

  isCommand(text: string, userId: string = 'default_user'): boolean {
    const trimmed = text.trim();

    if (this.userManager.getPendingSharePrompt(userId)) {
      return true;
    }

    if (this.hasDirectQuarkLink(trimmed)) {
      return true;
    }

    if (SchedulerService.getInstance().isScheduleIntent(trimmed)) {
      return true;
    }

    if (
      trimmed.startsWith('/') ||
      /^(?:配置|帮助|排行榜|热门|热映|正在热映|待映|即将上映|口碑榜|一周口碑榜|top250|豆瓣top250|追剧|追剧清单|我的追剧|片单|我的片单|查看片单|片单抽签|修改目录|设置目录|保存目录|转存目录|画质偏好|设置画质|控制台|找字幕|通讯录|用户列表|我的画像|观影画像|我的口味|网盘文件)(?:\s+.*)?$/i.test(
        trimmed
      ) ||
      /^(?:我叫|叫我|我的名字叫|我的名字是)\s*[^\s，。！!？?]{1,20}$/.test(trimmed) ||
      this.isFriendInviteIntent(trimmed)
    ) {
      return true;
    }

    if (
      RelayService.getInstance().getPendingReply(userId) &&
      /^(?:你)?(?:跟他说|告诉他|回复他|跟她说|告诉她|回复她|回他|回她|转告他|转告她)[：:，,\s]*.+$/i.test(trimmed)
    ) {
      return true;
    }

    if (SessionManager.parsePagination(trimmed)) {
      if (this.sessionManager.getSearch(userId) || this.sessionManager.getHot(userId)) {
        return true;
      }
    }

    const selection = SessionManager.parseSelection(trimmed);
    if (selection !== null) {
      if (this.sessionManager.getSearch(userId) || this.sessionManager.getHot(userId)) {
        return true;
      }
    }

    if (SessionManager.isCancelCommand(trimmed)) {
      if (
        this.sessionManager.getSearch(userId) ||
        this.sessionManager.getHot(userId) ||
        this.userManager.getPendingSharePrompt(userId)
      ) {
        return true;
      }
    }

    return false;
  }

  async handle(
    text: string,
    userId: string = 'default_user',
    onProgress?: (msg: string) => Promise<void>
  ): Promise<string> {
    const trimmed = text.trim();

    // 0. 处理取消/退出指令
    if (SessionManager.isCancelCommand(trimmed)) {
      if (this.userManager.getPendingSharePrompt(userId)) {
        this.userManager.clearPendingSharePrompt(userId);
        return '好嘞，已经取消生成邀请二维码啦！有需要随时再跟我说~';
      }

      const hasSearch = Boolean(this.sessionManager.getSearch(userId));
      const hasHot = Boolean(this.sessionManager.getHot(userId));

      if (hasSearch || hasHot) {
        this.sessionManager.clearSession(userId);
        return [
          '👌 已为你退出当前找片转存会话！',
          '----------------------------------------',
          '想看其他电影或电视剧时，随时发送片名告诉我（例如“流浪地球”或“星际穿越”），我再为你全网搜活链~',
        ].join('\n');
      }

      return '好的，随时有想看的片子直接发我片名就好啦！';
    }

    // 1. 处理“分享给朋友”的确认流程
    if (this.userManager.getPendingSharePrompt(userId)) {
      const lower = trimmed.toLowerCase();
      if (['共享', '共用', '1', '是', 'yes', 'y', '允许共享', '我要共享', '好的', '好', '可以'].includes(lower)) {
        this.userManager.clearPendingSharePrompt(userId);
        return await this.generateFriendInviteQr(userId, true);
      } else if (['独立', '不共享', '2', '否', 'no', 'n', '各用各的', '自理', '不用'].includes(lower)) {
        this.userManager.clearPendingSharePrompt(userId);
        return await this.generateFriendInviteQr(userId, false);
      } else if (['取消', '算了', 'exit', 'quit'].includes(lower)) {
        this.userManager.clearPendingSharePrompt(userId);
        return pickVariant(
          [
            '行，那先不生成啦，啥时候想拉朋友一起用直接叫我~',
            '好嘞先收起来了，回头想推荐给朋友了再喊我一声就行。',
            '没问题，先取消啦，有需要随时说~',
          ],
          `invite_cancel:${userId}`
        );
      }
    }

    // 2. 翻页与换一批指令
    const pageNav = SessionManager.parsePagination(trimmed);
    if (pageNav) {
      return await this.handlePagination(pageNav, userId);
    }

    // 3. 序号选择指令（兼容列表全局序号与“本页第X个”相对序号）
    const selected = SessionManager.parseSelection(trimmed);
    if (selected !== null) {
      return await this.handleSelection(selected, userId);
    }

    // 3.5 直接粘贴夸克网盘分享链接或口令自动转存
    if (this.hasDirectQuarkLink(trimmed)) {
      const linkMatch = trimmed.match(/https?:\/\/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)(?:\?(?:[^#\s"']*?\b)?pwd=([a-zA-Z0-9]{4}))?/i);
      if (linkMatch && linkMatch[1]) {
        const pwdId = linkMatch[1];
        const codeMatch = trimmed.match(/(?:提取码|密码|访问码|口令)[：:\s]*([a-zA-Z0-9]{4})/i);
        const passcode = linkMatch[2] || (codeMatch ? codeMatch[1] : '');
        const titleMatch = trimmed.match(/「([^」]+)」|《([^》]+)》/);
        const extractedTitle = titleMatch ? (titleMatch[1] || titleMatch[2] || '').trim() : undefined;
        const category = extractedTitle ? CategoryClassifier.classify(extractedTitle, trimmed) : '电影';
        const userPlan = this.userManager.getUserPlan(userId);
        const res = await this.quarkService.saveShareFiles(pwdId, passcode, category, {
          customCookie: userPlan.quarkCookie,
          rootDir: userPlan.saveRootDir,
          standardTitle: extractedTitle,
          userId,
        });
        if (res.success) {
          this.userManager.recordSave(userId, extractedTitle, `https://pan.quark.cn/s/${pwdId}`, category);
        }
        return res.message;
      }
    }

    // 4. 用户表达分享意向时提问
    if (this.isFriendInviteIntent(trimmed)) {
      this.userManager.setPendingSharePrompt(userId);
      const userPlan = this.userManager.getUserPlan(userId);
      const quotaNote = userPlan.deepseekApiKey
        ? '你现在用的是自己的额度'
        : '现在走的是公共额度';

      return pickVariant(
        [
          `好呀，随时欢迎拉朋友一起来玩！不过生成二维码前先问你一嘴，${quotaNote}，你是想回个「共享」让朋友直接蹭你的额度一起找片，还是回「独立」让他扫码后各用各的？`,
          `妥妥的，这就准备给你出二维码~ 先确认个小事：${quotaNote}，好友扫码后你想直接「共享」额度带他一起用，还是「独立」开他自己的号各用各的？直接回我“共享”或“独立”就行。`,
          `行啊，帮我安利给朋友太感谢了哈哈！先跟你说下，${quotaNote}，回「共享」的话朋友扫码就能直接用不用折腾，回「独立」就是各算各的额度。你选哪种呀？`,
        ],
        `invite_ask:${userId}`
      );
    }

    // 4.5 定时任务、全网蹲守、连载追更与智能监控指令处理
    if (SchedulerService.getInstance().isScheduleIntent(trimmed)) {
      return await SchedulerService.getInstance().handleNaturalLanguageCommand(trimmed, userId);
    }

    // 4.6 跨用户传话口语直达（"我叫xxx" / "你跟他说..."）
    const selfNameMatch = trimmed.match(/^(?:我叫|叫我|我的名字叫|我的名字是)\s*([^\s，。！!？?]{1,20})$/);
    if (selfNameMatch && selfNameMatch[1]) {
      return RelayService.getInstance().setMyNickname(userId, selfNameMatch[1]).message;
    }

    const quickReplyMatch = trimmed.match(
      /^(?:你)?(?:跟他说|告诉他|回复他|跟她说|告诉她|回复她|回他|回她|转告他|转告她)[：:，,\s]*(.+)$/i
    );
    if (quickReplyMatch && quickReplyMatch[1] && RelayService.getInstance().getPendingReply(userId)) {
      const res = await RelayService.getInstance().replyToLastSender(userId, quickReplyMatch[1]);
      return res.replyToReplier;
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (['/start', '/help', '/guide', '/欢迎', '/帮助', '帮助'].includes(cmd)) {
      return this.renderHelp(userId);
    }

    if (['/config', '/配置', '配置'].includes(cmd)) {
      return this.renderConfig(userId);
    }

    if (['/watchlist', '/plan', '/追剧', '追剧', '追剧清单', '我的追剧', '/片单', '片单', '我的片单', '查看片单'].includes(cmd)) {
      return this.renderWatchlist(userId, args);
    }

    if (['/片单抽签', '片单抽签'].includes(cmd)) {
      return this.renderWatchlist(userId, ['pick', ...args]);
    }

    if (['/hot', '/discover', '/排行', '排行榜', '/热门', '热门'].includes(cmd)) {
      const subType = args[0] ? args[0].toLowerCase() : 'movie';
      let type: 'movie' | 'tv' = 'movie';
      let tag = '热门';

      if (['tv', '电视剧', '剧集'].includes(subType)) {
        type = 'tv';
        tag = args[1] || '热门';
      } else if (['韩剧', '美剧', '日剧', '国产剧', '动漫', '综艺'].includes(subType)) {
        type = 'tv';
        tag = subType;
      } else if (['movie', '电影'].includes(subType)) {
        type = 'movie';
        tag = args[1] || '热门';
      } else if (['最新', '高分'].includes(subType)) {
        tag = subType === '高分' ? '豆瓣高分' : subType;
      }

      return await this.renderHot(type, tag, userId);
    }

    if (['/热映', '热映', '正在热映'].includes(cmd)) {
      const list = await this.doubanService.getNowPlaying(25);
      const heading = '🎟️ 大陆院线正在热映（豆瓣实时）';
      const hint = '👉 想看哪部直接回数字（如 **「1」**）搜资源或加入蹲守~';
      this.sessionManager.setHot(userId, 'movie', list, '正在热映', 1, 10, undefined, {
        mode: 'chart',
        chartHeading: heading,
        showWishOrDate: true,
        chartHint: hint,
      });
      const pageData = this.sessionManager.getHotPage(userId, 1);
      return DoubanService.formatChartMarkdown(heading, pageData?.items || list, {
        showWishOrDate: true,
        hint,
        page: pageData?.page,
        pageSize: pageData?.pageSize,
        total: pageData?.total,
        startIdx: pageData?.startIdx,
      });
    }

    if (['/待映', '待映', '即将上映'].includes(cmd)) {
      const list = await this.doubanService.getUpcomingMovies(25);
      const heading = '🎬 大陆院线即将上映（豆瓣待映）';
      const hint = '👉 想提前盯哪部新片？直接说 **「蹲守第1部」** 或回数字先搜看看~';
      this.sessionManager.setHot(userId, 'movie', list, '即将上映', 1, 10, undefined, {
        mode: 'chart',
        chartHeading: heading,
        showWishOrDate: true,
        chartHint: hint,
      });
      const pageData = this.sessionManager.getHotPage(userId, 1);
      return DoubanService.formatChartMarkdown(heading, pageData?.items || list, {
        showWishOrDate: true,
        hint,
        page: pageData?.page,
        pageSize: pageData?.pageSize,
        total: pageData?.total,
        startIdx: pageData?.startIdx,
      });
    }

    if (['/口碑榜', '口碑榜', '一周口碑榜'].includes(cmd)) {
      const list = await this.doubanService.getDoubanChart('movie_weekly_best', 20, 0);
      const heading = '🏆 豆瓣一周口碑电影榜';
      this.sessionManager.setHot(userId, 'movie', list, '一周口碑榜', 1, 10, undefined, {
        mode: 'chart',
        chartHeading: heading,
      });
      const pageData = this.sessionManager.getHotPage(userId, 1);
      return DoubanService.formatChartMarkdown(heading, pageData?.items || list, {
        page: pageData?.page,
        pageSize: pageData?.pageSize,
        total: pageData?.total,
        startIdx: pageData?.startIdx,
      });
    }

    if (['/top250', 'top250', '豆瓣top250'].includes(cmd)) {
      const randomStart = Math.floor(Math.random() * 10) * 10;
      const list = await this.doubanService.getDoubanChart('movie_top250', 20, randomStart);
      const heading = '💎 豆瓣电影 Top 250 精选';
      this.sessionManager.setHot(userId, 'movie', list, '豆瓣Top250', 1, 10, undefined, {
        mode: 'chart',
        chartHeading: heading,
      });
      const pageData = this.sessionManager.getHotPage(userId, 1);
      return DoubanService.formatChartMarkdown(heading, pageData?.items || list, {
        page: pageData?.page,
        pageSize: pageData?.pageSize,
        total: pageData?.total,
        startIdx: pageData?.startIdx,
      });
    }

    if (['/search', '/搜索', '搜', '搜索'].includes(cmd)) {
      const keyword = args.join(' ').trim();
      if (!keyword) {
        return '想搜什么片子呀？直接告诉我片名就可以，例如发送：庆余年 或 /search 周星驰功夫';
      }
      return await this.renderSearch(keyword, userId, { onProgress });
    }

    if (cmd === '/transfer-quark') {
      let pwdId = args[0] || '';
      const rawTail = args.slice(1).join(' ');
      const urlPwdMatch = pwdId.match(/\bpwd=([a-zA-Z0-9]{4})/i);
      const tailCodeMatch = rawTail.match(/(?:提取码|密码|访问码|口令)[：:\s]*([a-zA-Z0-9]{4})|^([a-zA-Z0-9]{4})$/i);
      const passcode = (urlPwdMatch ? urlPwdMatch[1] : '') || (tailCodeMatch ? tailCodeMatch[1] || tailCodeMatch[2] || '' : '');

      if (!pwdId) {
        return '请给我夸克网盘的分享链接或链接里的那串字母哦！例如：/transfer-quark https://pan.quark.cn/s/xxxx';
      }

      const match = pwdId.match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/);
      if (match) pwdId = match[1];

      const userPlan = this.userManager.getUserPlan(userId);
      const res = await this.quarkService.saveShareFiles(pwdId, passcode, '电影', {
        customCookie: userPlan.quarkCookie,
        rootDir: userPlan.saveRootDir,
        userId: userId,
      });
      if (res.success) {
        this.userManager.recordSave(userId, undefined, `https://pan.quark.cn/s/${pwdId}`, '电影');
      }
      return res.message;
    }

    if (cmd === '/transfer-115') {
      const extReply = await handleExtendedCommand(cmd, args, userId, {
        userManager: this.userManager,
        quarkService: this.quarkService,
        channelManager: this.channelManager,
        searcher: this.searcher,
      });
      if (extReply !== null) return extReply;
    }

    if (cmd === '/set-quark') {
      const cookie = args.join(' ').trim();
      if (!cookie) {
        return '要把你的夸克 Cookie 发给我才能绑定哦！格式：/set-quark 你的Cookie';
      }
      this.userManager.setUserQuarkCookie(userId, cookie);
      return '🎉 太棒了，你的夸克网盘 Cookie 已经绑定成功！以后转存的资源都会存进你自己的网盘里。发送 /status 就可以看剩余空间啦~';
    }

    if (cmd === '/set-deepseek' || cmd === '/set-key') {
      const key = args.join(' ').trim();
      if (!key) {
        return '请提供你的 DeepSeek API Key 哦，格式：\n• `/set-key sk-xxxx`（绑定自己的私有 Key）\n• `/set-key reset`（恢复共享公共 Key）';
      }
      this.userManager.setUserDeepSeekKey(userId, key);
      const isReset = ['reset', 'clear', '重置', '恢复'].includes(key);
      return isReset
        ? '已为你切回【共享系统 Key】模式啦！不用担心额度，大家一起用~'
        : '🎉 个人专属 DeepSeek API Key 绑定成功！以后的找片和对话都会使用你的独立额度。';
    }

    if (cmd === '/set-dir' || cmd === '设置目录' || cmd === '修改目录' || cmd === '保存目录' || cmd === '转存目录') {
      let dir = args.join(' ').trim();
      if (!dir) {
        const userPlan = this.userManager.getUserPlan(userId);
        const currentDir = userPlan.saveRootDir || this.quarkService.getDefaultRootDir();
        return [
          `📂 当前夸克网盘转存目录为：【${currentDir}】`,
          '----------------------------------------',
          '💡 修改方法非常简单，直接发：',
          '• `/set-dir /我的影视`',
          '• 或直接发：`修改目录 /追剧专用`',
          '• 或发：`保存目录 恢复默认`（重置为 /我的资源）',
        ].join('\n');
      }

      if (['reset', 'default', '恢复', '重置', '恢复默认'].includes(dir.toLowerCase())) {
        const defaultDir = process.env.DEFAULT_SAVE_DIR || '/我的资源';
        this.userManager.setUserRootDir(userId, defaultDir);
        return `✅ 已为你恢复默认保存目录：【${defaultDir}】啦！`;
      }

      // 自动补齐前缀斜杠
      if (!dir.startsWith('/')) {
        dir = `/${dir}`;
      }

      this.userManager.setUserRootDir(userId, dir);
      return [
        `🎉 夸克网盘保存目录已修改成功！`,
        '----------------------------------------',
        `📂 新保存目录：【${dir}】`,
        `💡 之后所有一键转存的电影、电视剧，都会自动归类存入这个文件夹下啦~`,
      ].join('\n');
    }

    if (['/prefer', '/quality', '画质偏好', '设置画质'].includes(cmd)) {
      const rawPref = args.join(' ').trim();
      if (!rawPref) {
        const current = this.userManager.getUserPlan(userId).preferences?.preferredQuality || 'any';
        return [
          `🎞️ 当前搜片画质偏好：【${current === 'any' ? '自动默认（不限画质）' : current}】`,
          '----------------------------------------',
          '💡 可发送以下命令切换画质优先排序（支持任意自然语言组合）：',
          '• `/prefer 4K`          优先置顶 4K / 杜比 / HDR 片源',
          '• `/prefer 4K杜比`      优先置顶 4K + 杜比视界/HDR',
          '• `/prefer 原盘`        优先置顶 REMUX / 蓝光原盘',
          '• `/prefer 体积小1080P` 优先置顶省流小体积 1080P',
          '• `/prefer 自动`        恢复默认排序',
        ].join('\n');
      }
      const upper = rawPref.toUpperCase();
      const target = ['ANY', 'AUTO', '自动', '默认', '不限', '重置'].includes(upper) ? 'any' : rawPref;

      this.userManager.setUserPreferredQuality(userId, target);
      return target === 'any'
        ? '✅ 已恢复默认搜片排序（自动综合相关度与夸克优先）。'
        : `🎉 已为你设置首选画质为【${target}】！后续搜片与榜单搜存将优先为你置顶匹配 ${target} 片源~`;
    }

    if (['/channels', '/频道'].includes(cmd)) {
      return this.renderChannels();
    }

    if (cmd === '/add-channel') {
      const channelInput = args.join(' ').trim();
      if (!channelInput) {
        return '请提供要添加的频道链接或名字哦，例如：`/add-channel @频道名`';
      }
      const res = this.channelManager.addChannel(channelInput);
      return res.success ? `✅ 成功加入搜索源：${res.message}` : `⚠️ ${res.message}`;
    }

    if (['/status', '/info', '/状态'].includes(cmd)) {
      return await this.renderStatus(userId);
    }

    if (['/clean-names', '/rename-clean', '/防和谐还原', '/还原剧名', '/防和谐'].includes(cmd)) {
      const userPlan = this.userManager.getUserPlan(userId);
      if (!this.quarkService.isConfigured(userPlan.quarkCookie)) {
        return '你还没有绑定夸克网盘 Cookie 哦！请先发送 /set-quark <你的Cookie> 绑定后再试~';
      }

      // 全面扫描网盘根目录、用户保存根目录及其下全部已存在影视分类目录
      const userRootDir = userPlan.saveRootDir || this.quarkService.getDefaultRootDir();
      const cleanRes = await this.quarkService.cleanUserWorkspace(userRootDir, {
        userId,
        customCookie: userPlan.quarkCookie,
      });

      const allRenamed = cleanRes.renamedItems;
      if (allRenamed.length === 0) {
        return `🎉 扫描完成（共全面巡检 ${cleanRes.scannedCount} 个文件/目录）！\n当前网盘中的资源名称都很规整，未检测到火星文或防版权混淆文件~`;
      }

      let reply = `🎉 智能防和谐治理完成（共扫描 ${cleanRes.scannedCount} 项，发现并还原 ${allRenamed.length} 处混淆剧名）：\n----------------------------------------`;
      for (const item of allRenamed) {
        reply += `\n• 原名：「${item.original}」\n  ➜ 还原为：《${item.restored}》`;
      }
      reply += '\n\n💡 以后每次转存新资源时，我也会全自动实时检测并规整为正常片名哦！';
      return reply;
    }

    const extReply = await handleExtendedCommand(cmd, args, userId, {
      userManager: this.userManager,
      quarkService: this.quarkService,
      channelManager: this.channelManager,
      searcher: this.searcher,
    });
    if (extReply !== null) {
      return extReply;
    }

    return `没太明白「${cmd}」是什么意思呢 😅 发送「帮助」或者 /help 可以查看我支持的全部玩法！`;
  }

  private async generateFriendInviteQr(inviterUserId: string, shareApiKey: boolean): Promise<string> {
    try {
      const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
      const BOT_TYPE = '3';
      const uint32 = crypto.randomBytes(4).readUInt32BE(0);
      const wechatUin = Buffer.from(String(uint32), 'utf-8').toString('base64');
      const headers = {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'X-WECHAT-UIN': wechatUin,
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '132106',
      };

      // 导入 WeixinBot 单例，传入所有已知 token 保证多 bot 并行鉴权
      let localTokens: string[] = [];
      try {
        const { WeixinBot } = require('../wechat/WeixinBot');
        localTokens = WeixinBot.getInstance().getAllBotTokens();
      } catch {}

      const res = await axios.post(
        `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
        { local_token_list: localTokens },
        { headers, timeout: 8000 }
      );

      const qrcode = res.data?.qrcode;
      const qrcodeUrl = res.data?.qrcode_img_content;

      if (!qrcode || !qrcodeUrl) {
        throw new Error('微信服务器返回二维码为空');
      }

      this.userManager.registerInvite(qrcode, inviterUserId, shareApiKey);

      // 后台异步启动扫码监听，扫码确认后自动加入轮询与继承 Key
      let sentQrImage = false;
      try {
        const { WeixinBot } = require('../wechat/WeixinBot');
        const bot = WeixinBot.getInstance();
        bot.waitForLogin(qrcode, 300000).then((auth: any) => {
          if (auth && auth.userId) {
            this.userManager.applyInvite(auth.userId, qrcode);
            console.log(`[CommandHandler] 好友 ${auth.userId} 扫码绑定成功，已继承配置并接入消息监听！`);
          }
        }).catch(() => {});

        const qrTmpDir = path.resolve(__dirname, '../../data');
        if (!fs.existsSync(qrTmpDir)) {
          fs.mkdirSync(qrTmpDir, { recursive: true });
        }
        const qrPath = path.join(qrTmpDir, `invite_qr_${Date.now()}.png`);
        await QRCode.toFile(qrPath, qrcodeUrl, { width: 360, margin: 2 });
        try {
          sentQrImage = await bot.sendImageMessage(inviterUserId, qrPath);
        } finally {
          try {
            if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
          } catch {}
        }
      } catch {}

      const shareText = shareApiKey ? '扫码后直接共享你的额度' : '扫码后各自独立使用额度';

      if (sentQrImage) {
        return pickVariant(
          [
            `二维码刚发到上面啦，5 分钟内有效，你直接长按转给朋友扫一扫就行（${shareText}）。要是图片那边打不开，也可以点这个备用链接：${qrcodeUrl}`,
            `搞定啦，专属二维码在上面那张图里，5 分钟内让朋友长按扫一下就能用上啦（${shareText}）。万一图片糊了打不开，补一个链接放这儿：${qrcodeUrl}`,
            `上面那张二维码就是给你朋友准备的，5 分钟内有效，直接转发过去让他扫码绑定就行（${shareText}）。备用链接也留这儿以防万一：${qrcodeUrl}`,
          ],
          `invite_done_img:${inviterUserId}`
        );
      }

      return pickVariant(
        [
          `二维码刚才没发出去，你直接把这个链接转给朋友，5 分钟内点开微信扫一下就能绑定啦（${shareText}）：\n${qrcodeUrl}`,
          `图片这边稍微卡了下，麻烦直接把下面这个链接甩给朋友吧，5 分钟内扫码就能连上（${shareText}）：\n${qrcodeUrl}`,
        ],
        `invite_done_url:${inviterUserId}`
      );
    } catch (err: any) {
      return `哎呀，向微信服务器申请邀请二维码时走神了：${err.message || '网络超时'}，请稍后再试一次哦！`;
    }
  }

  private async handlePagination(
    nav: { action: 'next' | 'prev' | 'goto' | 'refresh'; page?: number },
    userId: string
  ): Promise<string> {
    const lastType = this.sessionManager.getLastActiveType(userId);
    const searchSession = this.sessionManager.getSearch(userId);
    const hotSession = this.sessionManager.getHot(userId);

    // 优先根据最后活跃的会话类型（热榜推荐 vs 搜索结果）进行换一批或翻页
    if (lastType === 'hot' && hotSession) {
      return await this.handleHotPagination(nav, userId, hotSession);
    }

    if (searchSession && searchSession.items.length > 0) {
      return this.handleSearchPagination(nav, userId, searchSession);
    }

    if (hotSession) {
      return await this.handleHotPagination(nav, userId, hotSession);
    }

    return '当前没有正在查看的片单或搜索结果哦，直接告诉我你想看的电影、电视剧（例如“最近热门韩剧”或“庆余年”），我立马为你搜寻！';
  }

  private handleSearchPagination(
    nav: { action: 'next' | 'prev' | 'goto' | 'refresh'; page?: number },
    userId: string,
    searchSession: any
  ): string {
    let targetPage = searchSession.page;
    if (nav.action === 'next' || nav.action === 'refresh') targetPage += 1;
    else if (nav.action === 'prev') targetPage -= 1;
    else if (nav.action === 'goto' && nav.page !== undefined) targetPage = nav.page;

    const totalPages = Math.max(1, Math.ceil(searchSession.items.length / searchSession.pageSize));
    if (targetPage > totalPages) {
      // 已经到最后一页且用户选择换一批，自动循环回第一页
      targetPage = 1;
    }

    const pageData = this.sessionManager.getSearchPage(userId, targetPage);
    if (!pageData) {
      return '翻页遇到了一点小问题，请稍后再试一下。';
    }

    return this.formatSearchResultPage(pageData);
  }

  private async handleHotPagination(
    nav: { action: 'next' | 'prev' | 'goto' | 'refresh'; page?: number },
    userId: string,
    hotSession: any
  ): Promise<string> {
    if (hotSession.mode === 'chart' && Array.isArray(hotSession.items) && hotSession.items.length > 0) {
      const pageSize = Math.max(1, hotSession.pageSize || 10);
      const totalPages = Math.max(1, Math.ceil(hotSession.items.length / pageSize));
      const curPage = Math.max(1, hotSession.page || 1);
      let targetPage = curPage;

      if (nav.action === 'next' || nav.action === 'refresh') {
        if (curPage >= totalPages) {
          return `**${hotSession.chartHeading || hotSession.tag || '当前片单'}** 全部 ${hotSession.items.length} 部都已经看完啦~ 看中哪部直接回数字（如 **「1」**）搜资源，或回 **「上一页」** 往前看。`;
        }
        targetPage = curPage + 1;
      } else if (nav.action === 'prev') {
        if (curPage <= 1) {
          return `当前已经是第 1 页啦，回复 **「还有吗」** 或 **「下一页」** 可以继续往下看~`;
        }
        targetPage = curPage - 1;
      } else if (nav.action === 'goto' && nav.page !== undefined) {
        targetPage = Math.min(totalPages, Math.max(1, nav.page));
      }

      const pageData = this.sessionManager.getHotPage(userId, targetPage);
      if (!pageData) {
        return '当前榜单已过期，重新跟我说想看的榜单名称就行~';
      }
      return DoubanService.formatChartMarkdown(hotSession.chartHeading || hotSession.tag || '豆瓣榜单', pageData.items, {
        showWishOrDate: hotSession.showWishOrDate,
        hint: hotSession.chartHint,
        page: pageData.page,
        pageSize: pageData.pageSize,
        total: pageData.total,
        startIdx: pageData.startIdx,
      });
    }

    let targetPage = (hotSession.page || 1);
    if (nav.action === 'next' || nav.action === 'refresh') {
      if (nav.action === 'refresh' && Array.isArray(hotSession.items) && hotSession.items[0]) {
        const skipped = hotSession.items[0];
        UserProfileService.getInstance()
          .recordImplicitBehavior(userId, skipped.title, 'skip', {
            mediaType: hotSession.type === 'movie' ? '电影' : hotSession.tag && hotSession.tag !== '热门' ? hotSession.tag : undefined,
            genres: skipped.types || [],
            region: skipped.region,
            year: skipped.year,
            episodesCount: skipped.episodesCount,
            skipLookup: true,
          })
          .catch(() => {});
      }
      targetPage += 1;
    } else if (nav.action === 'prev') {
      targetPage = Math.max(1, targetPage - 1);
    } else if (nav.action === 'goto' && nav.page !== undefined) {
      targetPage = Math.max(1, nav.page);
    }

    if (targetPage > 5) {
      targetPage = 1;
    }

    return await this.renderHot(
      hotSession.type,
      hotSession.tag || '热门',
      userId,
      targetPage,
      undefined,
      hotSession.query
    );
  }

  private async handleSelection(
    selection: number | { index: number; isPageRelative: boolean },
    userId: string
  ): Promise<string> {
    const parsed = typeof selection === 'number' ? { index: selection, isPageRelative: false } : selection;
    const rawIndex = parsed.index;
    const lastType = this.sessionManager.getLastActiveType(userId);
    const searchSession = this.sessionManager.getSearch(userId);
    const hotSession = this.sessionManager.getHot(userId);
    const userPlan = this.userManager.getUserPlan(userId);

    // 若用户刚刚触发的是影视推荐 (hot)，优先从推荐列表中按序号搜存，避免被旧的搜索会话抢占
    if (lastType === 'hot' && hotSession && hotSession.items.length > 0) {
      const hotPage = Math.max(1, hotSession.page || 1);
      const hotSize = Math.max(1, hotSession.pageSize || 10);
      const hotIndex = parsed.isPageRelative && hotPage > 1 ? (hotPage - 1) * hotSize + rawIndex : rawIndex;
      return await this.handleHotSelection(hotIndex, userId, hotSession, userPlan);
    }

    if (searchSession && searchSession.items.length > 0) {
      const currentPage = Math.max(1, searchSession.page || 1);
      const pageSize = Math.max(1, searchSession.pageSize || 8);
      const startIdx = (currentPage - 1) * pageSize;
      const currentPageCount = Math.min(pageSize, Math.max(0, searchSession.items.length - startIdx));

      let index = rawIndex;
      let relativeLabel = '';
      if (parsed.isPageRelative && currentPage > 1) {
        if (rawIndex < 1 || rawIndex > currentPageCount) {
          return `当前第 ${currentPage} 页共有 ${currentPageCount} 个结果，请回复「本页第1个」~「本页第${currentPageCount}个」，或直接回复列表中对应的数字 ${startIdx + 1}~${startIdx + currentPageCount}！`;
        }
        index = startIdx + rawIndex;
        relativeLabel = `（第 ${currentPage} 页第 ${rawIndex} 个）`;
      }

      const itemIndex = index - 1;
      if (itemIndex < 0 || itemIndex >= searchSession.items.length) {
        return `序号【${index}】超出范围啦，当前一共有 ${searchSession.items.length} 个结果，请回复 1~${searchSession.items.length} 之间的数字哦！`;
      }

      const item = searchSession.items[itemIndex];
      const category = item.category || CategoryClassifier.classify(item.title, item.rawText);
      const standardTitle = searchSession.keyword || item.title;
      const saveTitle =
        MetadataResolver.extractMediaQuery(standardTitle).title ||
        MetadataResolver.extractMediaQuery(item.title).title ||
        standardTitle;

      if (item.panType === 'quark' || item.shareUrl.includes('pan.quark.cn')) {
        const res = await this.quarkService.saveShareFiles(item.shareId, item.passcode || '', category, {
          customCookie: userPlan.quarkCookie,
          rootDir: userPlan.saveRootDir,
          standardTitle,
          userId: userId,
        });
        if (res.success) {
          this.userManager.recordSave(userId, saveTitle, item.shareUrl, category, res.targetPath);
          UserProfileService.getInstance()
            .recordImplicitBehavior(userId, saveTitle, 'save', {
              mediaType: category,
            })
            .catch(() => {});
          WebhookService.notifyMediaSaved(userPlan.webhookUrl, {
            userId,
            title: item.title,
            category,
            panType: 'quark',
            targetPath: res.targetPath,
            shareUrl: item.shareUrl,
          }).catch(() => {});
          return [
            `🎬 收到！正在为你转存第 ${index} 个资源${relativeLabel}：`,
            `《${item.title}》`,
            `📂 已为你整理放入网盘：【${res.targetPath}】`,
            '----------------------------------------',
            res.message,
            `🔗 原链接：${item.shareUrl}`,
          ].join('\n');
        }

        // 转存失败时的友好降级与引导分支
        return [
          `🎬 正在为你转存第 ${index} 个资源${relativeLabel}：`,
          `《${item.title}》`,
          '----------------------------------------',
          `⚠️ 转存未能成功：${res.message}`,
          `🔗 目标链接：${item.shareUrl}`,
          '----------------------------------------',
          '💡 该分享链接可能已被分享者删除或已失效，别担心：',
          `👉 您可以继续回复列表中的其他序号（1~${searchSession.items.length}，如回复“2”或“3”）尝试其他有效版本；`,
          '👉 也可以回复「换一批」浏览更多候选资源；',
          '👉 若不想继续转存，直接回复「取消」即可退出当前找片。',
        ].join('\n');
      }

      // 若用户已绑定阿里云盘或 115 凭证，自动调用对应网盘适配器直接转存
      if ((item.panType === 'aliyun' || item.panType === '115') && item.shareId) {
        const provider = getPanRegistry().get(item.panType);
        const credential = item.panType === 'aliyun' ? userPlan.aliyunToken : userPlan.pan115Cookie;
        if (provider && provider.isConfigured(credential)) {
          const panRes = await provider.saveShare(item.shareId, item.passcode || '', category, {
            credential,
            rootDir: userPlan.saveRootDir,
            standardTitle,
            userId,
          });
          if (panRes.success) {
            this.userManager.recordSave(userId, saveTitle, item.shareUrl, category);
            WebhookService.notifyMediaSaved(userPlan.webhookUrl, {
              userId,
              title: item.title,
              category,
              panType: item.panType,
              targetPath: panRes.targetPath,
              shareUrl: item.shareUrl,
            }).catch(() => {});
            return [
              `🎬 已通过 ${provider.displayName} 自动转存第 ${index} 个资源${relativeLabel}：`,
              `《${item.title}》`,
              panRes.message,
              `🔗 原链接：${item.shareUrl}`,
            ].join('\n');
          }
        }
      }

      const panName =
        item.panType === 'aliyun'
          ? '阿里云盘'
          : item.panType === '115'
          ? '115网盘'
          : item.panType === 'uc'
          ? 'UC网盘'
          : item.panType === 'baidu'
          ? '百度网盘'
          : '第三方网盘';
      return [
        `🎬 已为你找到第 ${index} 个资源${relativeLabel}《${item.title}》：`,
        `📦 资源类型：${panName}（分类：${category}）`,
        `🔗 完整链接：${item.shareUrl}`,
        '----------------------------------------',
        `💡 小贴士：复制上面的链接在 ${panName} App 中打开即可保存；也可以发 /set-aliyun 或 /set-115 绑定后一键直存！`,
      ].join('\n');
    }

    if (hotSession && hotSession.items.length > 0) {
      const hotPage = Math.max(1, hotSession.page || 1);
      const hotSize = Math.max(1, hotSession.pageSize || 10);
      const hotIndex = parsed.isPageRelative && hotPage > 1 ? (hotPage - 1) * hotSize + rawIndex : rawIndex;
      return await this.handleHotSelection(hotIndex, userId, hotSession, userPlan);
    }

    return '还没有在搜索或者看榜单呢~ 告诉我你想看的片名（如“流浪地球2”），或者发送“热门”先挑挑看吧！';
  }

  private async handleHotSelection(
    index: number,
    userId: string,
    hotSession: any,
    userPlan: any
  ): Promise<string> {
    const itemIndex = index - 1;
    if (itemIndex < 0 || itemIndex >= hotSession.items.length) {
      return `序号【${index}】超出范围啦，当前推荐共有 ${hotSession.items.length} 部，回复数字（比如 1）就可以选啦！`;
    }

    const subject = hotSession.items[itemIndex];
    const title = subject.title;

    const preferredQuality = userPlan.preferences?.preferredQuality;
    const searchRes = await this.searcher.search({ keyword: title, quality: preferredQuality });
    if (!searchRes.items || searchRes.items.length === 0) {
      return [
        `🔍 正在全网为你搜寻《${title}》的资源...`,
        '----------------------------------------',
        `暂时还没找到《${title}》的有效网盘活链资源 😿`,
        '💡 这部剧可能刚刚上映或还没有公开流，可以回复「换一部」看看其他好剧，或者告诉我你想看的其他片子吧！',
      ].join('\n');
    }

    this.sessionManager.setSearch(userId, title, searchRes.items, 8);

    const resolveCategory = (item: CloudResource): ResourceCategory => {
      let category: ResourceCategory = item.category || CategoryClassifier.classify(item.title, item.rawText || '');
      if (hotSession.type === 'tv' && category === '电影') {
        const tag = `${hotSession.tag || ''} ${subject.region || ''} ${(subject.types || []).join(' ')}`;
        if (tag.includes('韩')) category = '韩剧';
        else if (tag.includes('美') || tag.includes('英') || tag.includes('欧美')) category = '美剧';
        else if (tag.includes('日') && !tag.includes('动画') && !tag.includes('动漫')) category = '日剧';
        else if (tag.includes('动画') || tag.includes('动漫')) category = '动漫';
        else if (tag.includes('综艺') || tag.includes('真人秀')) category = '综艺';
        else if (tag.includes('纪录')) category = '纪录片';
        else category = '国产剧';
      }
      return category;
    };

    const quarkCandidates = searchRes.items.filter(
      (i) => i.panType === 'quark' || i.shareUrl.includes('pan.quark.cn')
    );

    if (quarkCandidates.length > 0) {
      const maxAttempts = Math.min(3, quarkCandidates.length);
      let lastSaveMsg = '';
      let lastCandidate = quarkCandidates[0];

      // 自动死链顺延容错：若第 1 条夸克链接已失效，自动顺延尝试第 2、第 3 条直到转存成功
      for (let idx = 0; idx < maxAttempts; idx++) {
        const cand = quarkCandidates[idx];
        lastCandidate = cand;
        const category = resolveCategory(cand);
        const saveRes = await this.quarkService.saveShareFiles(cand.shareId, cand.passcode || '', category, {
          customCookie: userPlan.quarkCookie,
          rootDir: userPlan.saveRootDir,
          standardTitle: title,
          userId: userId,
        });
        if (saveRes.success) {
          this.userManager.recordSave(userId, title, cand.shareUrl, category, saveRes.targetPath);
          UserProfileService.getInstance()
            .recordImplicitBehavior(userId, title, 'save', {
              mediaType: category,
              genres: subject.types || [],
              region: subject.region,
              year: subject.year,
              episodesCount: subject.episodesCount,
            })
            .catch(() => {});
          const failoverTip = idx > 0 ? `（前 ${idx} 条链接已失效，已自动为你顺延命中有效活链 ⚡）` : '';
          return [
            `🎉 一键全网搜存成功！${failoverTip}`,
            `📺 剧名：《${title}》`,
            `📁 存放目录：夸克网盘【${saveRes.targetPath}】`,
            `🎬 版本信息：${cand.title}`,
            '----------------------------------------',
            saveRes.message,
            `🔗 分享链接：${cand.shareUrl}`,
          ].join('\n');
        }
        lastSaveMsg = saveRes.message;
      }

      const pageData = this.sessionManager.getSearchPage(userId, 1);
      const listPreview = pageData ? `\n${this.formatSearchResultPage({ ...pageData, keyword: title })}` : '';
      return [
        `🎬 正在为你转存《${title}》资源（已自动尝试前 ${maxAttempts} 条夸克候选）：`,
        `🎬 最近尝试版本：${lastCandidate.title}`,
        '----------------------------------------',
        `⚠️ 转存未能成功：${lastSaveMsg}`,
        '💡 已为你列出全部候选资源，可直接回复下方列表中的序号继续尝试转存或复制其他网盘链接：',
        listPreview,
      ]
        .filter(Boolean)
        .join('\n');
    }

    const targetItem = searchRes.items[0];
    const category = resolveCategory(targetItem);

    return [
      `🎉 找到《${title}》的网盘资源啦！`,
      `📁 资源分类：【${category}】`,
      `🎬 版本详情：${targetItem.title}`,
      `🔗 资源链接：${targetItem.shareUrl}`,
      '----------------------------------------',
      '💡 复制链接到对应网盘打开即可转存观看。已把结果记下，回复「我要第1个」也可以直接操作！',
    ].join('\n');
  }

  /**
   * 格式化精排版 Markdown 搜索结果页面（层级分明、留白舒适、无锯齿分割线）
   */
  private formatSearchResultPage(pageData: {
    items: CloudResource[];
    page: number;
    pageSize: number;
    totalPages: number;
    startIdx: number;
    total: number;
    keyword: string;
    metaHeader?: string;
  }): string {
    const { items, page, totalPages, startIdx, total, keyword, metaHeader } = pageData;
    const lines: string[] = [
      `**🎬 《${keyword}》** 找到 **${total}** 条网盘资源（${page}/${totalPages} 页）`,
    ];
    if (metaHeader) {
      lines.push(`> ${metaHeader.replace(/\n+/g, '\n> ')}`);
    }
    lines.push('');

    items.forEach((item, index) => {
      const seq = startIdx + index + 1;
      const panTag =
        item.panType === 'quark'
          ? '夸克'
          : item.panType === 'aliyun'
          ? '阿里'
          : item.panType === '115'
          ? '115'
          : item.panType === 'uc'
          ? 'UC'
          : item.panType === 'baidu'
          ? '百度'
          : '网盘';
      const fullText = `${item.title} ${item.rawText || ''}`;
      const tags: string[] = [panTag];
      if (item.qualityTags?.badges && item.qualityTags.badges.length > 0) {
        tags.push(...item.qualityTags.badges.slice(0, 2));
      } else if (/(?:4k|2160p|杜比|dolby)/i.test(fullText)) {
        tags.push('4K');
      } else if (/(?:remux|蓝光原盘)/i.test(fullText)) {
        tags.push('原盘');
      } else if (/1080p/i.test(fullText)) {
        tags.push('1080P');
      }
      if (item.passcode) tags.push('含码');

      lines.push(`**${seq}.** \`${tags.join(' · ')}\` ${item.title}`);
    });

    lines.push('');
    const saveHint =
      page > 1
        ? `👉 回复序号（如 **「${startIdx + 1}」** 或 **「本页第1个」**）直接转存`
        : `👉 回复数字（如 **「1」**）直接帮你存进网盘`;
    const navHints: string[] = [];
    if (page > 1) navHints.push('**「上一页」**');
    if (page < totalPages) navHints.push('**「下一页」**');
    lines.push(navHints.length > 0 ? `${saveHint}；说${navHints.join('/')}翻页` : saveHint);

    return lines.join('\n').trim();
  }

  async renderSearch(
    keyword: string,
    userId: string = 'default_user',
    searchMeta?: {
      initialAliases?: string[];
      originalTitle?: string;
      englishTitle?: string;
      year?: string;
      mediaType?: 'movie' | 'tv';
      overview?: string;
      enableAiFilter?: boolean;
      skipAiCorrector?: boolean;
      onProgress?: (msg: string) => Promise<void>;
    }
  ): Promise<string> {
    this.userManager.recordSearch(userId);

    if (searchMeta?.onProgress) {
      await searchMeta.onProgress('🔍 收到！正在全网搜索并通过 AI 精筛匹配资源，请稍候...').catch(() => {});
    }

    // 1. AI 实体纠错与意图归一化（若上层 AI 意图路由器已完成片名提炼，直接跳过避免二次误改）
    const cleanedRawKeyword = this.aiCorrector.cleanQuery(keyword) || keyword.trim();
    const correction = searchMeta?.skipAiCorrector
      ? {
          originalKeyword: keyword,
          correctedKeyword: cleanedRawKeyword,
          standardTitle: cleanedRawKeyword,
          candidateKeywords: [cleanedRawKeyword],
          isCorrected: false,
        }
      : await this.aiCorrector.correct(keyword, userId);
    let searchWord = correction.correctedKeyword;
    let standardTitle = correction.standardTitle || searchWord;
    const resolver = MetadataResolver.getInstance();

    const mergeUniqueTerms = (primary: string, list: Array<string | undefined>): string[] => {
      const seen = new Set<string>([primary.toLowerCase()]);
      const out: string[] = [];
      for (const item of list) {
        const clean = (item || '').trim();
        if (!clean || clean.length < 2) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
      }
      return out;
    };

    const hasForeign = MetadataResolver.hasForeignScript(searchWord) || MetadataResolver.hasForeignScript(keyword);
    const shouldResolveUpfront =
      !searchMeta ||
      (!searchMeta.englishTitle && resolver.hasTmdbConfigured());

    // 2. 前置并发获取三语元信息（中文 + 拍摄国原语 + 英文）与豆瓣参考信息
    const [resolvedSettled, doubanSettled] = await Promise.allSettled([
      shouldResolveUpfront
        ? resolver.resolveMedia({
            query: keyword,
            originalTitle: searchMeta?.originalTitle,
            guessTitle: standardTitle,
            alternateTitles: [
              ...(searchMeta?.initialAliases || []),
              ...(correction.candidateKeywords || []),
            ],
            year: searchMeta?.year,
            mediaType: searchMeta?.mediaType,
            userId,
            forceLlm: !searchMeta && hasForeign,
          })
        : Promise.resolve(null),
      this.doubanService.getMovieMeta(standardTitle).catch(() => null),
    ]);

    let resolvedInfo: ResolvedMediaInfo | null =
      resolvedSettled.status === 'fulfilled' ? resolvedSettled.value : null;
    const doubanMeta = doubanSettled.status === 'fulfilled' ? doubanSettled.value : null;

    if (resolvedInfo?.standardTitle && resolvedInfo.standardTitle.length >= 2) {
      standardTitle = resolvedInfo.standardTitle;
      searchWord = resolvedInfo.standardTitle;
    }

    const combinedMeta: Partial<ResolvedMediaInfo> = {
      standardTitle,
      originalTitle: resolvedInfo?.originalTitle || searchMeta?.originalTitle,
      englishTitle: resolvedInfo?.englishTitle || searchMeta?.englishTitle,
      originalLanguage: resolvedInfo?.originalLanguage,
      aliases: mergeUniqueTerms(standardTitle, [
        ...(resolvedInfo?.aliases || []),
        ...(searchMeta?.initialAliases || []),
        ...(correction.candidateKeywords || []),
      ]),
    };

    let allAliases = mergeUniqueTerms(standardTitle, [
      combinedMeta.originalTitle,
      combinedMeta.englishTitle,
      ...(combinedMeta.aliases || []),
      searchWord,
      this.aiCorrector.cleanQuery(keyword),
    ]);

    // 3. 组装影视元数据与提示头
    const metaHeaders: string[] = [];
    const cleanInputKeyword = this.aiCorrector.cleanQuery(keyword);
    if (correction.isCorrected && correction.explanation) {
      if (correction.isPlotInferred) {
        metaHeaders.push(`💡 剧情识片：${correction.explanation}`);
      } else {
        metaHeaders.push(`🤖 AI 纠错：识别到「${cleanInputKeyword}」➜ ${correction.explanation}`);
      }
    } else if (
      resolvedInfo &&
      resolvedInfo.standardTitle &&
      resolvedInfo.standardTitle.toLowerCase() !== cleanInputKeyword.toLowerCase()
    ) {
      metaHeaders.push(
        `🌐 跨语种片名对齐（${resolvedInfo.source.toUpperCase()}）：「${cleanInputKeyword}」➜《${resolvedInfo.standardTitle}》`
      );
    }

    let doubanYear: string | undefined;
    if (doubanMeta) {
      doubanYear = doubanMeta.year;
      const yearPart = doubanMeta.year ? `(${doubanMeta.year})` : '';
      const subPart = doubanMeta.subTitle ? ` / ${doubanMeta.subTitle}` : '';
      metaHeaders.push(`⭐ 豆瓣影视：${doubanMeta.title} ${yearPart}${subPart}`);
    }

    const userPlan = this.userManager.getUserPlan(userId);
    const preferredQuality = userPlan.preferences?.preferredQuality;

    // 4. 固定按 [中文, 拍摄国原语, 英文] 生成去重搜索词，共享并发池一次性全量搜索
    let trilingualTerms = MetadataResolver.buildTrilingualSearchTerms(
      combinedMeta,
      standardTitle,
      cleanInputKeyword
    );

    let res = await this.searcher.searchMany(trilingualTerms, {
      aliasKeywords: allAliases,
      quality: preferredQuality,
    });

    if (trilingualTerms.length > 1) {
      metaHeaders.push(`🌐 三语并发检索：${trilingualTerms.join(' / ')}`);
    }

    // 4b. 若完全无结果且先前尚未触发强力 LLM 反直译（例如无 TMDB Key 时遇到直译片名），尝试一次纠偏补搜
    if (res.items.length === 0 && !searchMeta && !hasForeign && resolvedInfo?.source !== 'tmdb' && resolvedInfo?.source !== 'llm') {
      const rescued = await resolver.resolveMedia({
        query: keyword,
        guessTitle: standardTitle,
        alternateTitles: allAliases,
        userId,
        forceLlm: true,
      });
      if (rescued && rescued.source === 'llm') {
        resolvedInfo = rescued;
        if (rescued.standardTitle) {
          standardTitle = rescued.standardTitle;
          searchWord = rescued.standardTitle;
        }
        allAliases = mergeUniqueTerms(standardTitle, [
          rescued.originalTitle,
          rescued.englishTitle,
          ...rescued.aliases,
          ...allAliases,
        ]);
        const extraTerms = MetadataResolver.buildTrilingualSearchTerms(rescued, standardTitle, cleanInputKeyword)
          .filter((t) => !trilingualTerms.some((existing) => existing.toLowerCase() === t.toLowerCase()));
        if (extraTerms.length > 0) {
          const extraRes = await this.searcher.searchMany(extraTerms, {
            aliasKeywords: allAliases,
            quality: preferredQuality,
          });
          res = this.searcher.mergeResults(res, [extraRes], standardTitle, preferredQuality, allAliases);
          if (extraRes.items.length > 0) {
            metaHeaders.push(`🔄 反直译扩展补充：${extraTerms.join(' / ')}`);
          }
        }
      }
    }

    // 5. AI 搜索结果语义精筛：剔除同名异作、年份/类型明显不符及无关推广帖
    let interceptedAllByAi = false;
    let interceptedReason: string | undefined;
    const rawCountBeforeAi = res.items?.length || 0;

    if (res.items && res.items.length > 0 && searchMeta?.enableAiFilter !== false) {
      const aiFilter = await resolver.filterRelevantResources({
        items: res.items,
        targetTitle: standardTitle || searchWord,
        originalTitle: searchMeta?.originalTitle || resolvedInfo?.originalTitle,
        aliases: allAliases,
        year: searchMeta?.year || resolvedInfo?.year || doubanYear,
        mediaType: searchMeta?.mediaType || resolvedInfo?.mediaType,
        overview: searchMeta?.overview || resolvedInfo?.overview,
        userId,
      });

      if (aiFilter.aiFiltered) {
        res = {
          ...res,
          items: aiFilter.filteredItems,
          totalFound: aiFilter.filteredItems.length,
        };
        if (aiFilter.filteredItems.length === 0 && rawCountBeforeAi > 0) {
          interceptedAllByAi = true;
          interceptedReason = aiFilter.reason;
        } else if (aiFilter.droppedCount > 0) {
          metaHeaders.push(
            `🧹 AI 精筛：已剔除 ${aiFilter.droppedCount} 条同名异作或无关资源${aiFilter.reason ? `（${aiFilter.reason}）` : ''}`
          );
        }
      }
    }

    const metaHeader = metaHeaders.join('\n');

    if (!res.items || res.items.length === 0) {
      const displayWord = correction.isCorrected ? `${standardTitle}（原词：${keyword}）` : standardTitle;
      const cleanName = standardTitle || searchWord;
      if (interceptedAllByAi) {
        return [
          metaHeader ? `${metaHeader}\n----------------------------------------` : '',
          `🔍 全网检索到 ${rawCountBeforeAi} 条含「${cleanName}」的候选帖，但经 AI 逐条核对均非目标作品本身${interceptedReason ? `（${interceptedReason}）` : ''}，已为您自动过滤误匹配资源。`,
          `💡 如确认尚未流出资源，直接回复「蹲守《${cleanName}》」，出资源后第一时间微信通知你并自动入库！`,
        ]
          .filter(Boolean)
          .join('\n');
      }
      const triedHint = allAliases.length > 0 ? `\n（已自动扩展尝试关联别名：${allAliases.slice(0, 3).join(' / ')}）` : '';
      return [
        metaHeader ? `${metaHeader}\n----------------------------------------` : '',
        `🔍 暂时还没找到关于「${displayWord}」的有效网盘资源呢~${triedHint}`,
        `💡 还没出资源？直接回复「蹲守《${cleanName}》」，一旦全网出资源我第一时间微信通知你并自动存进网盘！`,
      ]
        .filter(Boolean)
        .join('\n');
    }

    // 每页精简显示 8 条，避免微信端单条消息过长
    const sessionKeyword = standardTitle || searchWord;
    UserProfileService.getInstance()
      .recordImplicitBehavior(userId, sessionKeyword, 'search', {
        mediaType: searchMeta?.mediaType === 'movie' ? '电影' : res.items[0]?.category,
        year: searchMeta?.year || resolvedInfo?.year || doubanYear,
      })
      .catch(() => {});
    this.sessionManager.setSearch(userId, sessionKeyword, res.items, 8);
    const pageData = this.sessionManager.getSearchPage(userId, 1)!;

    return this.formatSearchResultPage({
      ...pageData,
      keyword: sessionKeyword,
      metaHeader,
    });
  }

  async renderHot(
    type: 'movie' | 'tv',
    tag: string = '热门',
    userId: string = 'default_user',
    page: number = 1,
    _existingSubjects?: any[],
    query?: string,
    chatHistory?: any[]
  ): Promise<string> {
    const recommender = AiRecommender.getInstance();
    const result = await recommender.generateXiaohongshuNote({
      query: query || (tag && tag !== '热门' ? `${tag}${type === 'movie' ? '电影' : '电视剧'}` : undefined),
      type,
      tag,
      page,
      userId,
      chatHistory,
    });

    this.sessionManager.setHot(userId, type, result.subjects, tag, page, 6, query);
    return result.formattedNote;
  }

  private renderWatchlist(userId: string, args: string[]): string {
    const subCmd = args[0] ? args[0].toLowerCase() : 'list';

    if (['add', '添加', '加'].includes(subCmd)) {
      const title = args.slice(1).join(' ').trim();
      if (!title) {
        return '告诉我片名呀，例如：`/追剧 添加 庆余年2`';
      }
      const res = this.userManager.addToWatchlist(userId, title);
      if (res.success) {
        void WatchlistService.enrichWatchlistItem(userId, title).catch(() => {});
      }
      return res.message;
    }

    if (['del', 'rm', '删除', '移出'].includes(subCmd)) {
      const title = args.slice(1).join(' ').trim();
      if (!title) {
        return '告诉我你想移出哪部剧呀，例如：`/追剧 删除 庆余年2`';
      }
      const ok = this.userManager.removeFromWatchlist(userId, title);
      return ok ? `好嘞，已从追剧清单中移除《${title}》` : `在你的清单里没找到《${title}》呢。`;
    }

    if (['done', '已看', '看完'].includes(subCmd)) {
      const title = args.slice(1).join(' ').trim();
      if (!title) return '请指定片名，例如：`/追剧 已看 沙丘2`';
      const ok = this.userManager.updateWatchlistStatus(userId, title, 'completed');
      if (ok) {
        void UserProfileService.getInstance().recordImplicitBehavior(userId, title, 'save').catch(() => {});
        return `✅ 已将《${title}》标为「已看」，并同步学习至你的观影画像！`;
      }
      return `在你的片单里没找到《${title}》呢。`;
    }

    if (['watching', '在追', '追'].includes(subCmd)) {
      const title = args.slice(1).join(' ').trim();
      if (!title) return '请指定片名，例如：`/追剧 在追 漫长的季节`';
      const ok = this.userManager.updateWatchlistStatus(userId, title, 'saving');
      return ok ? `🔥 已将《${title}》设为「在追」状态！` : `在你的片单里没找到《${title}》呢。`;
    }

    if (['+1', 'ep', '进度', '看了一集'].includes(subCmd)) {
      const title = args.slice(1).join(' ').trim();
      if (!title) return '请指定片名，例如：`/追剧 +1 庆余年`';
      const updated = this.userManager.incrementWatchlistEpisode(userId, title, 1);
      if (!updated) return `在你的片单里没找到《${title}》呢。`;
      const epStr = updated.totalEpisodes ? `第 ${updated.currentEpisode}/${updated.totalEpisodes} 集` : `第 ${updated.currentEpisode} 集`;
      return updated.status === 'completed'
        ? `🎉 《${updated.title}》已看到 ${epStr}，自动标为「已看」啦！`
        : `📺 《${updated.title}》进度已更新至 ${epStr}~`;
    }

    if (['pick', '抽签', '今晚看哪部', '选一部'].includes(subCmd)) {
      const picks = WatchlistService.pickFromWatchlist(userId, 3);
      if (picks.length === 0) {
        return '你的待看片单目前为空，先用 `/追剧 添加 <片名>` 或 `/import-list` 存几部吧~';
      }
      const lines = ['🎲 【今晚看哪部 · 画像智能抽签】', '----------------------------------------'];
      picks.forEach((p, idx) => {
        const rate = p.item.rating ? ` ⭐${p.item.rating}` : '';
        const cat = p.item.category ? `[${p.item.category}] ` : '';
        lines.push(`${idx + 1}. ${cat}《${p.item.title}》${rate}\n   💡 ${p.reasons.join(' · ')}`);
      });
      lines.push('----------------------------------------');
      lines.push('💬 想看哪部，直接把片名发给我就帮你全网搜资源！');
      return lines.join('\n');
    }

    if (['export', '导出'].includes(subCmd)) {
      return WatchlistService.exportMarkdown(userId);
    }

    const plan = this.userManager.getUserPlan(userId);
    const list = plan.watchlist;
    if (!list || list.length === 0) {
      return [
        '📋 【你的个人追剧片单】',
        '----------------------------------------',
        '你的清单目前还是空的哦~',
        '💡 玩法技巧：',
        '• 发送「/追剧 添加 <剧名>」添加你想追的剧',
        '• 发送「/片单抽签」让算法帮你从片单挑今晚看的片',
        '• 每次挑选序号转存成功后，我也会自动帮你收录到片单里！',
      ].join('\n');
    }

    let text = `📋 【你的个人追剧片单 (${list.length}部)】:\n----------------------------------------\n`;
    list.forEach((w, idx) => {
      const statusLabel = w.status === 'completed' ? '✅已看' : w.status === 'saving' ? '🔥在追' : '⏳想看';
      const catTag = w.category ? `[${w.category}] ` : '';
      const rateTag = w.rating ? ` ⭐${w.rating}` : '';
      const epTag =
        w.currentEpisode && w.currentEpisode > 0
          ? w.totalEpisodes
            ? ` · ${w.currentEpisode}/${w.totalEpisodes}集`
            : ` · 第${w.currentEpisode}集`
          : '';
      const cloudTag = w.inCloudDisk ? ' · ☁️网盘已有' : '';
      text += `${idx + 1}. ${catTag}《${w.title}》${rateTag} [${statusLabel}${epTag}${cloudTag}]\n`;
    });
    text += `----------------------------------------\n`;
    text += `💡 支持 \`/追剧 已看 <片名>\`、\`/追剧 +1 <片名>\`、\`/片单抽签\` 或 \`/追剧 导出\``;
    return text.trim();
  }

  private renderHelp(userId: string): string {
    return [
      '🤖 电视搭子 (TVdazi) 微信影视小助手使用指南',
      '─────────────────────────',
      '🔍 【找片与转存】',
      '• 直接发片名 / 剧照截图搜片',
      '• 回复数字序号（如 1 或 2）一键转存',
      '• /hot 或 发“热门电影/热门韩剧”看榜单',
      '• 回复“换一批”刷新推荐',
      '',
      '⚙️ 【常用指令】',
      '• /web           打开 H5 可视化控制面板',
      '• /profile       查看或重置个人观影口味画像',
      '• /tasks         查看/管理定时任务与追更',
      '• /status        查看网盘空间与状态',
      '• /config        查看当前个人配置',
      '• /set-dir 路径   修改保存目录(如 /影视)',
      '• /prefer 4K杜比  设置画质偏好（支持自然语言）',
      '• /subtitle 片名  专项检索外挂/中字字幕包',
      '• /ls [目录]     查看夸克网盘文件与类型分布',
      '• /unzip [名/码] 云端解压刚转存或指定压缩包',
      '• /clean-names   一键清洗网盘火星文剧名',
      '• /organize      按 Emby/Infuse 规范整理命名',
      '• /dedup         扫描重复低画质资源释放空间',
      '• 直接说“解压网盘里的xxx / 把第2个重命名 / 删掉刚才存的”也能操作网盘',
      '• /追剧 / /import-list  查看或批量导入片单',
      '• /share         邀请微信好友一起使用',
      '',
      '⏰ 【定时与智能追更（直接发文字即可）】',
      '• 发“每天早上8点推一部科幻电影”',
      '• 发“《片名》有资源了通知我”或“蹲守《片名》”',
      '• 发“帮我追更《剧名》”或“开启全套智能守护”',
      '',
      '💬 【多用户传话与通讯录】',
      '• /users / “通讯录”     查看当前服务在线的微信用户',
      '• /name 名字 / “我叫xxx” 设置自己的对外昵称',
      '• /alias 序号 备注      给其他用户设置本地备注名',
      '• /say 名字 内容        直接托我给指定微信好友带话',
      '• /share-movie 名字 [片名] 把刚看中的好片安利给好友',
      '• /reply 内容 / “跟他说...” 回复最近给你传话的好友',
      '• /dnd on|off          开启或关闭传话免打扰',
      '',
      '🔑 【高级与多网盘绑定】',
      '• /set-quark Cookie   绑定私有夸克网盘',
      '• /set-aliyun Token   绑定阿里云盘自动转存',
      '• /set-115 Cookie     绑定 115 网盘自动接收',
      '• /set-webhook URL    配置 Alist/Emby 扫库通知',
      '• /set-key APIKey     绑定专属DeepSeek Key',
      '• /channels / /channels-health  频道与健康度',
      '─────────────────────────',
      '💡 日常直接和我像微信好友一样聊天即可找片！',
    ].join('\n');
  }

  private renderConfig(userId: string): string {
    const userPlan = this.userManager.getUserPlan(userId);
    const hasCustomCookie = Boolean(userPlan.quarkCookie);
    const isGlobalQuark = this.quarkService.isConfigured();
    const saveDir = userPlan.saveRootDir || this.quarkService.getDefaultRootDir();

    let keyStatus = '🌐 共享系统全局 Key (无感免密)';
    if (userPlan.deepseekApiKey) {
      keyStatus = '🔑 个人专属独立 Key (独立配额)';
    } else if (userPlan.inheritedApiKey) {
      keyStatus = `🤝 继承好友共享 Key (来自好友用户)`;
    }

    const maskedUser = userId.length > 16 ? `${userId.slice(0, 8)}...${userId.slice(-6)}` : userId;
    const prefQuality = userPlan.preferences?.preferredQuality || 'any';

    return [
      '⚙️ 【你的专属配置面板】',
      '----------------------------------------',
      `👤 微信账号：${maskedUser}`,
      `☁️ 夸克网盘：${hasCustomCookie ? '✅ 你的私有账号已绑定' : isGlobalQuark ? '✅ 正在使用公共网盘' : '❌ 尚未绑定 (发 /set-quark)'}`,
      `📂 转存目录：${saveDir}`,
      `🎞️ 画质偏好：${prefQuality === 'any' ? '自动默认' : `${prefQuality} 优先`}（发 /prefer 可改）`,
      `🧠 AI 驱动：${keyStatus}`,
      `📋 追剧片单：已收录 ${userPlan.watchlist.length} 部影视`,
      `📊 使用统计：找片 ${userPlan.stats.totalSearches} 次，累计转存 ${userPlan.stats.totalSaves} 部`,
      '----------------------------------------',
      '💡 发送「/status」可以查看网盘剩余容量，发送「分享」可以邀请朋友一起用！',
    ].join('\n');
  }

  private async renderStatus(userId: string): Promise<string> {
    const userPlan = this.userManager.getUserPlan(userId);
    const customCookie = userPlan.quarkCookie;

    if (!this.quarkService.isConfigured(customCookie)) {
      return '还没有绑定夸克网盘 Cookie 呢，请发送 `/set-quark <你的Cookie>` 告诉我就可以啦！';
    }

    const info = await this.quarkService.getUserInfo(customCookie);
    if (!info) {
      return '网盘登录凭证好像过期啦，重新在电脑浏览器复制一下 Cookie，发「/set-quark <新Cookie>」就可以更新啦！';
    }

    const memberBadge = info.memberType ? ` [${info.memberType}]` : '';
    const usedLine = info.usedCapacity
      ? `📊 已用空间：${info.usedCapacity}${info.usagePercent ? `（已用 ${info.usagePercent}）` : ''}`
      : null;

    return [
      '☁️ 【你的夸克网盘容量状态】',
      '----------------------------------------',
      `👤 账号昵称：${info.nickname}${memberBadge}`,
      `💾 总共容量：${info.totalCapacity}`,
      usedLine,
      `🟢 剩余空间：${info.freeCapacity}`,
      `📂 默认保存目录：${userPlan.saveRootDir || this.quarkService.getDefaultRootDir()}`,
      `🏷️ 账号模式：${customCookie ? '个人独立账号' : '共享系统公共账号'}`,
      '✅ 随时可以发片名让我帮你自动转存！',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private renderChannels(): string {
    const list = this.channelManager.loadChannels();
    let text = `📡 【当前连接的 ${list.length} 个全网资源库】:\n----------------------------------------\n`;
    list.forEach((c, idx) => {
      text += `${idx + 1}. ${c.name} (@${c.id})\n`;
    });
    text += `\n💡 只要这些库里有的资源，告诉我片名我都能帮你搜到！`;
    return text.trim();
  }
}
