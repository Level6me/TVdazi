import { ResourceSearcher } from '../services/Searcher';
import { QuarkService } from '../services/QuarkService';
import { DoubanService } from '../services/DoubanService';
import { ChannelManager } from '../services/ChannelManager';
import { SessionManager } from '../services/SessionManager';
import { UserManager } from '../services/UserManager';
import { AiCorrector } from '../services/AiCorrector';
import { AiRecommender } from '../services/AiRecommender';
import { CategoryClassifier, ResourceCategory } from '../services/CategoryClassifier';
import { CloudResource } from '../types';
import axios from 'axios';
import * as crypto from 'crypto';

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

  isCommand(text: string, userId: string = 'default_user'): boolean {
    const trimmed = text.trim();

    if (this.userManager.getPendingSharePrompt(userId)) {
      return true;
    }

    if (
      trimmed.startsWith('/') ||
      trimmed.startsWith('配置') ||
      trimmed.startsWith('帮助') ||
      trimmed.startsWith('排行榜') ||
      trimmed.startsWith('搜 ') ||
      trimmed.startsWith('搜索 ') ||
      trimmed.startsWith('追剧') ||
      trimmed.startsWith('片单') ||
      trimmed.startsWith('修改目录') ||
      trimmed.startsWith('设置目录') ||
      trimmed.startsWith('保存目录') ||
      trimmed.startsWith('转存目录') ||
      trimmed.includes('分享') ||
      trimmed.includes('推荐给朋友') ||
      trimmed.includes('加机器人') ||
      trimmed.includes('邀请') ||
      trimmed.includes('二维码')
    ) {
      return true;
    }

    if (SessionManager.parsePagination(trimmed)) {
      if (this.sessionManager.getSearch(userId) || this.sessionManager.getHot(userId)) {
        return true;
      }
    }

    const num = SessionManager.parseNumberSelection(trimmed);
    if (num !== null) {
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

  async handle(text: string, userId: string = 'default_user'): Promise<string> {
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
        return '好嘞，已经取消生成二维码啦！有需要随时再跟我说~';
      }
    }

    // 2. 翻页与换一批指令
    const pageNav = SessionManager.parsePagination(trimmed);
    if (pageNav) {
      return await this.handlePagination(pageNav, userId);
    }

    // 3. 序号选择指令
    const selectedNum = SessionManager.parseNumberSelection(trimmed);
    if (selectedNum !== null) {
      return await this.handleSelection(selectedNum, userId);
    }

    // 4. 用户表达分享意向时提问
    if (
      trimmed.includes('分享') ||
      trimmed.includes('推荐给朋友') ||
      trimmed.includes('加机器人') ||
      trimmed.includes('邀请') ||
      trimmed.includes('二维码') ||
      trimmed.startsWith('/share') ||
      trimmed.startsWith('/invite')
    ) {
      this.userManager.setPendingSharePrompt(userId);
      const userPlan = this.userManager.getUserPlan(userId);
      const currentKeyType = userPlan.deepseekApiKey ? '你的个人独立 API Key' : '系统默认共享 Key';

      return [
        '好呀！把我也介绍给你的朋友认识吧 😊',
        '----------------------------------------',
        `在为你生成专属邀请二维码前，先问你一个小问题：`,
        `❓ 是否愿意让好友与你【共用当前的 AI 额度】呢？（当前使用的是：${currentKeyType}）`,
        '',
        '👉 你可以直接回复：',
        '• 回复「共享」或「1」：好友扫码后，能直接和你一起使用 AI 找片，不用额外配置。',
        '• 回复「独立」或「2」：好友扫码后自己配自己的 Key，各用各的。',
        '----------------------------------------',
        '💬 回复「共享」或「独立」就可以啦！',
      ].join('\n');
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

    if (['/watchlist', '/plan', '/追剧', '追剧', '/片单', '片单'].includes(cmd)) {
      return this.renderWatchlist(userId, args);
    }

    if (['/hot', '/discover', '/排行', '排行榜', '/热门'].includes(cmd)) {
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

    if (['/search', '/搜索', '搜', '搜索'].includes(cmd)) {
      const keyword = args.join(' ').trim();
      if (!keyword) {
        return '想搜什么片子呀？直接告诉我片名就可以，例如发送：庆余年 或 /search 周星驰功夫';
      }
      return await this.renderSearch(keyword, userId);
    }

    if (cmd === '/transfer-quark') {
      let pwdId = args[0] || '';
      const passcode = args[1] || '';

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
      return '115 网盘秒存还在加紧打磨中，目前建议优先用夸克网盘，转存又快又稳哦！';
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

      // 扫描根目录与用户分类目录
      const rootRes = await this.quarkService.cleanAntiCensorFilesInFolder('0', {
        userId,
        customCookie: userPlan.quarkCookie,
      });

      const userRootDir = userPlan.saveRootDir || this.quarkService.getDefaultRootDir();
      let catCleanCount = 0;
      let catRenamed: Array<{ original: string; restored: string; reason?: string }> = [];

      try {
        const catRes = await this.quarkService.getCategoryDir('电影', userRootDir, userPlan.quarkCookie);
        if (catRes.fid && catRes.fid !== '0') {
          const subRes = await this.quarkService.cleanAntiCensorFilesInFolder(catRes.fid, {
            userId,
            customCookie: userPlan.quarkCookie,
          });
          catCleanCount = subRes.scannedCount;
          catRenamed = subRes.renamedItems;
        }
      } catch {}

      const allRenamed = [...rootRes.renamedItems, ...catRenamed];
      if (allRenamed.length === 0) {
        return `🎉 扫描完成（共检查 ${rootRes.scannedCount + catCleanCount} 个资源）！\n当前网盘中的资源名称都很规整，未检测到火星文或防版权混淆文件~`;
      }

      let reply = `🎉 智能防和谐治理完成（共发现并还原 ${allRenamed.length} 处混淆剧名）：\n----------------------------------------`;
      for (const item of allRenamed) {
        reply += `\n• 原名：「${item.original}」\n  ➜ 还原为：《${item.restored}》`;
      }
      reply += '\n\n💡 以后每次转存新资源时，我也会全自动实时检测并规整为正常片名哦！';
      return reply;
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
      try {
        const { WeixinBot } = require('../wechat/WeixinBot');
        const bot = WeixinBot.getInstance();
        bot.waitForLogin(qrcode, 300000).then((auth: any) => {
          if (auth && auth.userId) {
            this.userManager.applyInvite(auth.userId, qrcode);
            console.log(`[CommandHandler] 好友 ${auth.userId} 扫码绑定成功，已继承配置并接入消息监听！`);
          }
        }).catch(() => {});
      } catch {}

      const modeTip = shareApiKey
        ? '✅ 已开启共享（朋友扫码后将一起共用你的 AI 额度）'
        : '🔒 独立模式（朋友扫码后使用其自己的独立额度）';

      return [
        '🎉 好友邀请链接准备好啦！快发给朋友吧：',
        '----------------------------------------',
        `📌 当前设定：${modeTip}`,
        '',
        '👉 直接把下面这个官方授权链接转发给微信好友，好友在微信里点开即可一键绑定使用：',
        qrcodeUrl,
        '',
        '💡 小贴士：也可以直接把我的个人名片推给好友，好友跟我聊天也能独立搜片转存哦！',
        '⏱️ 该授权链接 5 分钟内有效。',
      ].join('\n');
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
    let targetPage = (hotSession.page || 1);
    if (nav.action === 'next' || nav.action === 'refresh') {
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

  private async handleSelection(index: number, userId: string): Promise<string> {
    const lastType = this.sessionManager.getLastActiveType(userId);
    const searchSession = this.sessionManager.getSearch(userId);
    const hotSession = this.sessionManager.getHot(userId);
    const userPlan = this.userManager.getUserPlan(userId);

    // 若用户刚刚触发的是影视推荐 (hot)，优先从推荐列表中按序号搜存，避免被旧的搜索会话抢占
    if (lastType === 'hot' && hotSession && hotSession.items.length > 0) {
      return await this.handleHotSelection(index, userId, hotSession, userPlan);
    }

    if (searchSession && searchSession.items.length > 0) {
      const itemIndex = index - 1;
      if (itemIndex < 0 || itemIndex >= searchSession.items.length) {
        return `序号【${index}】超出范围啦，当前一共有 ${searchSession.items.length} 个结果，请回复 1~${searchSession.items.length} 之间的数字哦！`;
      }

      const item = searchSession.items[itemIndex];
      const category = item.category || CategoryClassifier.classify(item.title, item.rawText);

      if (item.panType === 'quark' || item.shareUrl.includes('pan.quark.cn')) {
        const res = await this.quarkService.saveShareFiles(item.shareId, '', category, {
          customCookie: userPlan.quarkCookie,
          rootDir: userPlan.saveRootDir,
          standardTitle: item.title,
          userId: userId,
        });
        if (res.success) {
          this.userManager.recordSave(userId, item.title, item.shareUrl, category);
          return [
            `🎬 收到！正在为你转存第 ${index} 个资源：`,
            `《${item.title}》`,
            `📂 已为你整理放入网盘：【${res.targetPath}】`,
            '----------------------------------------',
            res.message,
            `🔗 原链接：${item.shareUrl}`,
          ].join('\n');
        }

        // 转存失败时的友好降级与引导分支
        return [
          `🎬 正在为你转存第 ${index} 个资源：`,
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

      const panName = item.panType === 'aliyun' ? '阿里云盘' : item.panType === 'uc' ? 'UC网盘' : '第三方网盘';
      return [
        `🎬 已为你找到第 ${index} 个资源《${item.title}》：`,
        `📦 资源类型：${panName}（分类：${category}）`,
        `🔗 完整链接：${item.shareUrl}`,
        '----------------------------------------',
        `💡 小贴士：复制上面的链接在 ${panName} App 中打开就可以直接保存和播放啦！`,
      ].join('\n');
    }

    if (hotSession && hotSession.items.length > 0) {
      return await this.handleHotSelection(index, userId, hotSession, userPlan);
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

    const searchRes = await this.searcher.search({ keyword: title });
    if (!searchRes.items || searchRes.items.length === 0) {
      return [
        `🔍 正在全网为你搜寻《${title}》的资源...`,
        '----------------------------------------',
        `暂时还没找到《${title}》的有效网盘活链资源 😿`,
        '💡 这部剧可能刚刚上映或还没有公开流，可以回复「换一部」看看其他好剧，或者告诉我你想看的其他片子吧！',
      ].join('\n');
    }

    this.sessionManager.setSearch(userId, title, searchRes.items, 10);

    const bestQuark = searchRes.items.find((i) => i.panType === 'quark' || i.shareUrl.includes('pan.quark.cn'));
    const targetItem = bestQuark || searchRes.items[0];

    let category: ResourceCategory = '电影';
    if (hotSession.type === 'tv') {
      const tag = hotSession.tag || '';
      if (tag.includes('韩剧')) category = '韩剧';
      else if (tag.includes('美剧')) category = '美剧';
      else if (tag.includes('日剧')) category = '日剧';
      else if (tag.includes('动漫')) category = '动漫';
      else if (tag.includes('综艺')) category = '综艺';
      else category = '国产剧';
    }

    if (targetItem.panType === 'quark' || targetItem.shareUrl.includes('pan.quark.cn')) {
      const saveRes = await this.quarkService.saveShareFiles(targetItem.shareId, '', category, {
        customCookie: userPlan.quarkCookie,
        rootDir: userPlan.saveRootDir,
        standardTitle: title,
        userId: userId,
      });
      if (saveRes.success) {
        this.userManager.recordSave(userId, title, targetItem.shareUrl, category);
        return [
          `🎉 一键全网搜存成功！`,
          `📺 剧名：《${title}》`,
          `📁 存放目录：夸克网盘【${saveRes.targetPath}】`,
          `🎬 版本信息：${targetItem.title}`,
          '----------------------------------------',
          saveRes.message,
          `🔗 分享链接：${targetItem.shareUrl}`,
        ].join('\n');
      }

      return [
        `🎬 正在为你转存《${title}》精选资源：`,
        `🎬 版本信息：${targetItem.title}`,
        '----------------------------------------',
        `⚠️ 转存未能成功：${saveRes.message}`,
        `🔗 分享链接：${targetItem.shareUrl}`,
        '----------------------------------------',
        '💡 该分享链接可能已失效：',
        `👉 列表中还有其他候选资源，你可以继续回复数字序号（1~${searchRes.items.length}）尝试转存其他版本；`,
        '👉 或回复「取消」退出当前找片。',
      ].join('\n');
    }

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
   * 格式化精简紧凑的搜索结果页面（去掉冗余大段介绍，仅呈现纯净片名与关键网盘标）
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
    let msg = `🎬 【${keyword}】搜索结果 (${page}/${totalPages}页 共${total}条)\n`;
    if (metaHeader) {
      msg += `${metaHeader}\n`;
    }
    msg += `----------------------------------------\n`;

    items.forEach((item, index) => {
      const seq = startIdx + index + 1;
      const panTag =
        item.panType === 'quark'
          ? '夸克'
          : item.panType === 'aliyun'
          ? '阿里'
          : item.panType === 'uc'
          ? 'UC'
          : '网盘';
      const cat = item.category ? `[${item.category}]` : '';
      msg += `${seq}. [${panTag}]${cat} ${item.title}\n`;
    });

    msg += `----------------------------------------\n`;
    msg += `💡 回复序号一键转存（如「1」或「存第1个」）`;
    if (page < totalPages) {
      msg += `；回复「下一页」翻页`;
    }
    return msg.trim();
  }

  async renderSearch(keyword: string, userId: string = 'default_user'): Promise<string> {
    this.userManager.recordSearch(userId);

    // AI 实体纠错与意图归一化（识别俗称/外号/错别字/缩写）
    const correction = await this.aiCorrector.correct(keyword, userId);
    let searchWord = correction.correctedKeyword;
    const standardTitle = correction.standardTitle || searchWord;

    // 优先使用标准片名拉取豆瓣评分与元数据
    const metaHeaders: string[] = [];
    if (correction.isCorrected && correction.explanation) {
      metaHeaders.push(`🤖 AI 纠错：识别到「${this.aiCorrector.cleanQuery(keyword)}」➜ ${correction.explanation}`);
    }

    try {
      const meta = (await this.doubanService.getMovieMeta(standardTitle)) ||
                   (await this.doubanService.getMovieMeta(searchWord));
      if (meta) {
        const yearPart = meta.year ? `(${meta.year})` : '';
        const subPart = meta.subTitle ? ` / ${meta.subTitle}` : '';
        metaHeaders.push(`⭐ 豆瓣影视：${meta.title} ${yearPart}${subPart}`);
      }
    } catch {}

    const metaHeader = metaHeaders.join('\n');

    // 智能多级检索尝试：先检索主词，无结果时自动尝试备选词
    let res = await this.searcher.search({ keyword: searchWord });
    if ((!res.items || res.items.length === 0) && correction.candidateKeywords && correction.candidateKeywords.length > 0) {
      for (const candidate of correction.candidateKeywords) {
        if (candidate !== searchWord) {
          const candidateRes = await this.searcher.search({ keyword: candidate });
          if (candidateRes.items && candidateRes.items.length > 0) {
            res = candidateRes;
            searchWord = candidate;
            break;
          }
        }
      }
    }

    if (!res.items || res.items.length === 0) {
      const displayWord = correction.isCorrected ? `${standardTitle}（原词：${keyword}）` : searchWord;
      return `🔍 暂时还没找到关于「${displayWord}」的有效网盘资源呢，可以试试换个更通用的片名重新搜搜看~`;
    }

    // 每页精简显示 8 条，避免微信端单条消息过长
    this.sessionManager.setSearch(userId, searchWord, res.items, 8);
    const pageData = this.sessionManager.getSearchPage(userId, 1)!;
    return this.formatSearchResultPage({
      ...pageData,
      keyword: standardTitle || searchWord,
      metaHeader,
    });
  }

  async renderHot(
    type: 'movie' | 'tv',
    tag: string = '热门',
    userId: string = 'default_user',
    page: number = 1,
    existingSubjects?: any[],
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

    const plan = this.userManager.getUserPlan(userId);
    const list = plan.watchlist;
    if (!list || list.length === 0) {
      return [
        '📋 【你的个人追剧片单】',
        '----------------------------------------',
        '你的清单目前还是空的哦~',
        '💡 玩法技巧：',
        '• 发送「/追剧 添加 <剧名>」添加你想追的剧',
        '• 每次挑选序号转存成功后，我也会自动帮你收录到片单里！',
      ].join('\n');
    }

    let text = `📋 【你的个人追剧片单 (${list.length}部)】:\n----------------------------------------\n`;
    list.forEach((w, idx) => {
      const statusIcon = w.status === 'completed' ? '✅ 已转存' : '⏳ 待看/更新中';
      const dateStr = new Date(w.addedAt).toLocaleDateString('zh-CN');
      text += `${idx + 1}. 《${w.title}》 [${statusIcon}] (${dateStr})\n`;
    });
    text += `----------------------------------------\n`;
    text += `💡 随时告诉我片名帮你搜资源；也可以发「/追剧 删除 <剧名>」清理记录。`;
    return text.trim();
  }

  private renderHelp(userId: string): string {
    return [
      '🤖 WeSaver 微信影视小助手使用指南',
      '─────────────────────────',
      '🔍 【找片与转存】',
      '• 直接发片名 / 剧照截图搜片',
      '• 回复数字序号（如 1 或 2）一键转存',
      '• /hot 或 发“热门电影/热门韩剧”看榜单',
      '• 回复“换一批”刷新推荐',
      '',
      '⚙️ 【常用指令】',
      '• /status        查看网盘空间与状态',
      '• /config        查看当前个人配置',
      '• /set-dir 路径   修改保存目录(如 /影视)',
      '• /clean-names   一键清洗网盘火星文剧名',
      '• /追剧          查看追剧清单与历史',
      '• /share         邀请微信好友一起使用',
      '',
      '🔑 【高级与账号绑定】',
      '• /set-quark Cookie   绑定私有夸克网盘',
      '• /set-key APIKey     绑定专属DeepSeek Key',
      '• /channels           查看当前50+资源源',
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

    return [
      '⚙️ 【你的专属配置面板】',
      '----------------------------------------',
      `👤 微信账号：${maskedUser}`,
      `☁️ 夸克网盘：${hasCustomCookie ? '✅ 你的私有账号已绑定' : isGlobalQuark ? '✅ 正在使用公共网盘' : '❌ 尚未绑定 (发 /set-quark)'}`,
      `📂 转存目录：${saveDir}`,
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

    return [
      '☁️ 【你的夸克网盘容量状态】',
      '----------------------------------------',
      `👤 账号昵称：${info.nickname}`,
      `💾 总共容量：${info.totalCapacity}`,
      `🟢 剩余空间：${info.freeCapacity}`,
      `📂 默认保存目录：${userPlan.saveRootDir || this.quarkService.getDefaultRootDir()}`,
      `🏷️ 账号模式：${customCookie ? '个人独立账号' : '共享系统公共账号'}`,
      '✅ 随时可以发片名让我帮你自动转存！',
    ].join('\n');
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
