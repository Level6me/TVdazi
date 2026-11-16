import OpenAI from 'openai';
import { ResourceSearcher } from '../services/Searcher';
import { QuarkService } from '../services/QuarkService';
import { DoubanService } from '../services/DoubanService';
import { ChannelManager } from '../services/ChannelManager';
import { CommandHandler } from '../commands/CommandHandler';
import { SessionManager } from '../services/SessionManager';
import { UserManager } from '../services/UserManager';
import { SchedulerService } from '../services/SchedulerService';
import { LlmClientFactory } from '../utils/LlmClientFactory';
import { MetadataResolver } from '../services/MetadataResolver';
import { RelayService } from '../services/RelayService';
import { UserProfileService } from '../services/UserProfileService';

export interface RecognizedImageResult {
  standardTitle: string;
  originalTitle?: string;
  englishTitle?: string;
  rawGuessTitle?: string;
  aliases: string[];
  year?: string;
  mediaType?: 'movie' | 'tv';
  overview?: string;
  source: 'tmdb' | 'bangumi' | 'douban' | 'llm' | 'raw';
}

export class DeepSeekAgent {
  private searcher: ResourceSearcher;
  private quarkService: QuarkService;
  private doubanService: DoubanService;
  private channelManager: ChannelManager;
  private commandHandler: CommandHandler;
  private sessionManager: SessionManager;
  private userManager: UserManager;
  private userHistories: Map<string, { messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]; updatedAt: number }> = new Map();
  private static readonly HISTORY_TTL_MS = 2 * 60 * 60 * 1000;
  private overrideApiKey?: string;
  private overrideModel?: string;

  constructor(apiKey?: string, _baseURL?: string, model?: string) {
    this.overrideApiKey = apiKey;
    this.overrideModel = model;

    this.searcher = new ResourceSearcher();
    this.quarkService = new QuarkService();
    this.doubanService = new DoubanService();
    this.channelManager = new ChannelManager();
    this.commandHandler = new CommandHandler();
    this.sessionManager = SessionManager.getInstance();
    this.userManager = UserManager.getInstance();
  }

  private getClientForUser(userId: string, timeoutMs: number = 12000) {
    const resolved = LlmClientFactory.getClientForUser(userId, timeoutMs);
    if (!resolved.isCustom && (this.overrideApiKey || this.overrideModel)) {
      const apiKey = (this.overrideApiKey || LlmClientFactory.getGlobalApiKey()).trim();
      return {
        client: new OpenAI({
          apiKey: apiKey || 'dummy_key',
          baseURL: LlmClientFactory.getGlobalBaseUrl(),
          timeout: timeoutMs,
        }),
        model: this.overrideModel || resolved.model,
        visionModel: resolved.visionModel,
        hasValidKey: apiKey.length > 0,
        isCustom: false,
      };
    }
    return resolved;
  }

  /**
   * 使用 DeepSeek 多模态模型提取海报/剧照原名、官方中文名与线索，并通过 MetadataResolver 对齐官方译名（支持 TMDB 方案 B / 无 Key 方案 A）
   */
  async recognizeMovieDetailFromImage(
    imageBuffer: Buffer,
    userId: string = 'default_user'
  ): Promise<RecognizedImageResult | null> {
    const { client, visionModel, hasValidKey } = this.getClientForUser(userId, 25000);
    if (!hasValidKey) {
      console.warn('[DeepSeek 识图跳过] 未检测到有效的 DEEPSEEK_API_KEY');
      return null;
    }

    try {
      let mimeType = 'image/jpeg';
      if (imageBuffer.length >= 4 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4e && imageBuffer[3] === 0x47) {
        mimeType = 'image/png';
      } else if (imageBuffer.length >= 3 && imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46) {
        mimeType = 'image/gif';
      } else if (imageBuffer.length >= 12 && imageBuffer.subarray(0, 4).toString('ascii') === 'RIFF' && imageBuffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        mimeType = 'image/webp';
      }
      const base64Data = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

      const res = await client.chat.completions.create({
        model: visionModel,
        messages: [
          {
            role: 'system',
            content: `你是一个精通古今中外电影、电视剧、动漫、综艺、纪录片的「多语种海报识片专家」。
用户会发送剧照、外语海报、台词截图、演员同框画面或动漫截图。
请严格输出合法 JSON 对象：
{
  "isMovieRelated": true,
  "originalTitle": "海报或画面上出现的原始语言标题（如日文、韩文、英文原文，原样抄录，绝不翻译；无文字则留空）",
  "officialChineseTitle": "中国大陆豆瓣或主流字幕组通用的正式官方中文片名（不带书名号；严禁按外语单词字面意思生硬直译！）",
  "alternateTitles": ["常见港台译名或民间别名（最多2个）"],
  "year": "画面或知识库对应的上映年份（4位数字，无则留空）",
  "clues": "认出的演员、导演、角色名或剧情题材线索（用于二次反查中文正式片名）"
}
核心要求：
1. 若海报是日文/韩文/英文，必须先把原语文字一字不差填到 originalTitle；
2. officialChineseTitle 必须尽量对应国内正式中文片名，切忌自己字面直译（例如日文海报切勿按字面直译成非官方中文词）；
3. 若画面完全是纯风景、美食、日常生活照等与影视动漫无关的图片，设 isMovieRelated 为 false。`,
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: '请识别图中影视动漫作品的原语言标题、官方中文片名及线索，并严格返回 JSON：' },
              { type: 'image_url', image_url: { url: base64Data } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.15,
      });

      const rawReply = (res.choices[0]?.message?.content || '').trim();
      console.log(
        `[DeepSeek 识图] model=${visionModel}, bytes=${imageBuffer.length}, mime=${mimeType}, rawReply=${rawReply.slice(0, 140)}`
      );

      if (!rawReply || rawReply.toUpperCase() === 'NONE') {
        return null;
      }

      let originalTitle = '';
      let officialChineseTitle = '';
      let alternateTitles: string[] = [];
      let year = '';
      let clues = '';

      const jsonCleaned = rawReply.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        const parsed = JSON.parse(jsonCleaned);
        if (parsed.isMovieRelated === false) {
          return null;
        }
        originalTitle = String(parsed.originalTitle || '').trim();
        officialChineseTitle = String(parsed.officialChineseTitle || parsed.chineseTitle || '').trim();
        alternateTitles = Array.isArray(parsed.alternateTitles)
          ? parsed.alternateTitles.map((x: any) => String(x || '').trim()).filter(Boolean)
          : [];
        year = String(parsed.year || '').trim();
        clues = String(parsed.clues || '').trim();
      } catch {
        // 兼容非 JSON 纯文本回复降级提取
        if (rawReply.includes('无法识别') || rawReply.includes('无法查看') || rawReply.includes('无法确定')) {
          return null;
        }
        const quotedMatch = rawReply.match(/《([^》\n]{1,40})》/);
        officialChineseTitle = (quotedMatch?.[1] || rawReply.split(/\r?\n/)[0] || '')
          .replace(/^(?:片名|作品名|电影|电视剧|动漫)[：:\s]*/i, '')
          .replace(/[《》""''「」。，,!！?？]/g, '')
          .trim();
      }

      if (!originalTitle && !officialChineseTitle) {
        return null;
      }

      // 通过 MetadataResolver 自动执行：有 TMDB_API_KEY 走方案 B，无 Key 走方案 A（豆瓣/Bangumi + 大模型反直译实体对齐）
      const resolved = await MetadataResolver.getInstance().resolveMedia({
        originalTitle: originalTitle || undefined,
        guessTitle: officialChineseTitle || undefined,
        alternateTitles,
        year: year || undefined,
        clues: clues || undefined,
        userId,
        forceLlm: Boolean(originalTitle),
      });

      const finalTitle = resolved.standardTitle || officialChineseTitle || originalTitle;
      if (!finalTitle) return null;

      return {
        standardTitle: finalTitle,
        originalTitle: resolved.originalTitle || originalTitle || undefined,
        englishTitle: resolved.englishTitle,
        rawGuessTitle: officialChineseTitle || undefined,
        aliases: resolved.aliases,
        year: resolved.year || year || undefined,
        mediaType: resolved.mediaType,
        overview: resolved.overview,
        source: resolved.source,
      };
    } catch (err: any) {
      console.error(`[DeepSeek 多模态识别异常] model=${visionModel}:`, err.message);
      return null;
    }
  }

  /**
   * 兼容接口：返回识别对齐后的中文片名
   */
  async recognizeMovieFromImage(imageBuffer: Buffer, userId: string = 'default_user'): Promise<string | null> {
    const detail = await this.recognizeMovieDetailFromImage(imageBuffer, userId);
    return detail?.standardTitle || null;
  }

  /**
   * 判断用户文本是否属于对“待确认识图搜索”的肯定确认
   */
  public isPendingImageSearchConfirm(userId: string, text: string): boolean {
    if (!this.sessionManager.getPendingImageSearch(userId)) return false;
    const clean = (text || '').trim();
    return /^(?:搜索|搜|搜一下|搜一搜|搜吧|开始搜索|开始|好的|好|好呀|嗯|嗯嗯|要|要的|需要|是|是的|查一下|帮我搜|存一下|帮我存|转存|看看这部|想看|确认|可以|行|1|ok|yes)[!！。.~～]*$/i.test(
      clean
    );
  }

  /**
   * 处理用户发送的图片：先回复识别到的详细片名信息，并询问是否开始全网搜索与 AI 精筛
   */
  async handleImageMessage(imageBuffer: Buffer, userId: string = 'default_user'): Promise<string> {
    const detail = await this.recognizeMovieDetailFromImage(imageBuffer, userId);

    if (detail) {
      this.sessionManager.setPendingImageSearch(userId, {
        standardTitle: detail.standardTitle,
        originalTitle: detail.originalTitle,
        englishTitle: detail.englishTitle,
        aliases: detail.aliases,
        year: detail.year,
        mediaType: detail.mediaType,
        overview: detail.overview,
      });
      this.sessionManager.setLastMentionedTitle(userId, detail.standardTitle);

      const typeLabel = detail.mediaType === 'tv' ? '剧集' : detail.mediaType === 'movie' ? '电影' : '';
      const yearTypeLine = [detail.year ? `${detail.year}年` : '', typeLabel].filter(Boolean).join(' / ');

      const lines = [
        '✅ 识别完成！作品信息如下：',
        `• 官方片名：《${detail.standardTitle}》`,
      ];
      if (detail.originalTitle && detail.originalTitle.toLowerCase() !== detail.standardTitle.toLowerCase()) {
        lines.push(`• 原语言名：${detail.originalTitle}`);
      }
      if (yearTypeLine) {
        lines.push(`• 年份类型：${yearTypeLine}`);
      }
      if (detail.aliases.length > 0) {
        lines.push(`• 关联别名：${detail.aliases.slice(0, 4).join(' / ')}`);
      }
      if (detail.overview) {
        const shortOverview = detail.overview.length > 90 ? `${detail.overview.slice(0, 90)}...` : detail.overview;
        lines.push(`• 剧情简介：${shortOverview}`);
      }
      lines.push('----------------------------------------');
      lines.push(`❓ 需要我立即为你全网搜索并 AI 筛选《${detail.standardTitle}》的网盘资源吗？`);
      lines.push('💬 回复「搜索」、「好的」或「要」即可开始搜片（若片名有误，也可以直接发准确片名给我）。');

      return lines.join('\n');
    }

    return [
      '📸 收到你的图片啦！',
      '----------------------------------------',
      'AI 仔细看了看，暂时没能从这张图中精准定位到对应的剧名 😅',
      '💡 建议：可以直接把片名发给我（比如“功夫之王”或“庆余年”），我立马为你搜网盘资源！',
    ].join('\n');
  }

  async chat(
    userMessage: string,
    chatHistoryOrUserId?: any[] | string,
    maybeUserId?: string,
    onProgress?: (msg: string) => Promise<void>
  ): Promise<string> {
    const trimmed = userMessage.trim();

    let chatHistory: any[] = [];
    let userId = 'default_user';

    if (Array.isArray(chatHistoryOrUserId)) {
      chatHistory = chatHistoryOrUserId;
      if (typeof maybeUserId === 'string' && maybeUserId) {
        userId = maybeUserId;
      }
    } else if (typeof chatHistoryOrUserId === 'string' && chatHistoryOrUserId) {
      userId = chatHistoryOrUserId;
    }

    if (chatHistory.length === 0) {
      const histEntry = this.userHistories.get(userId);
      if (histEntry) {
        if (Date.now() - histEntry.updatedAt <= DeepSeekAgent.HISTORY_TTL_MS) {
          chatHistory = histEntry.messages;
        } else {
          this.userHistories.delete(userId);
        }
      }
    }

    const appendUserHistory = (userText: string, assistantReply: string) => {
      // 从助手自由回复中提取《片名》，供“半小时后转存到网盘”等延时上下文任务嗅探使用
      const bookMatches = assistantReply.match(/《([^》\n]{1,40})》/g);
      if (bookMatches && bookMatches.length > 0) {
        const lastMatch = bookMatches[bookMatches.length - 1].replace(/[《》]/g, '').trim();
        if (lastMatch) {
          this.sessionManager.setLastMentionedTitle(userId, lastMatch);
        }
      }
      const existing = this.userHistories.get(userId);
      let list =
        existing && Date.now() - existing.updatedAt <= DeepSeekAgent.HISTORY_TTL_MS
          ? [...existing.messages]
          : [];
      list.push({ role: 'user', content: userText });
      list.push({ role: 'assistant', content: assistantReply });
      if (list.length > 12) {
        list = list.slice(-12);
      }
      if (!this.userHistories.has(userId) && this.userHistories.size >= 300) {
        const oldestUser = this.userHistories.keys().next().value;
        if (oldestUser) this.userHistories.delete(oldestUser);
      }
      this.userHistories.set(userId, { messages: list, updatedAt: Date.now() });
    };

    // 0. 优先处理识图完成后的“是否开始搜索资源”二次确认状态
    const pendingImage = this.sessionManager.getPendingImageSearch(userId);
    if (pendingImage && !trimmed.startsWith('/')) {
      if (this.isPendingImageSearchConfirm(userId, trimmed)) {
        this.sessionManager.clearPendingImageSearch(userId);
        const searchReply = await this.commandHandler.renderSearch(pendingImage.standardTitle, userId, {
          initialAliases: pendingImage.aliases,
          originalTitle: pendingImage.originalTitle,
          englishTitle: pendingImage.englishTitle,
          year: pendingImage.year,
          mediaType: pendingImage.mediaType,
          overview: pendingImage.overview,
          enableAiFilter: true,
        });
        appendUserHistory(trimmed, searchReply);
        return searchReply;
      }

      if (/^(?:不用|不用了|不需要|算了|取消|不要|不搜|先不搜|no|cancel)[!！。.~～]*$/i.test(trimmed)) {
        this.sessionManager.clearPendingImageSearch(userId);
        const cancelReply = '好的，已取消本次搜索~ 随时想搜哪部片子直接告诉我即可！';
        appendUserHistory(trimmed, cancelReply);
        return cancelReply;
      }

      // 用户未按确认词回复而是发了其他指令或新片名，清理旧的待确认态继续正常处理
      this.sessionManager.clearPendingImageSearch(userId);
    }

    // 1. 仅对确定性交互（/斜杠指令、翻页/选号、网盘链接、系统配置命令、明确任务管理指令）走 0ms 快路径
    if (this.commandHandler.isCommand(trimmed, userId)) {
      const reply = await this.commandHandler.handle(trimmed, userId, onProgress);
      appendUserHistory(trimmed, reply);
      return reply;
    }

    // 2. 所有自然语言输入统一交由 DeepSeek AI 大脑进行意图识别与实体抽取，再路由后续动作
    const { client, model, hasValidKey } = this.getClientForUser(userId, 12000);

    if (!hasValidKey) {
      return this.fallbackDirectSearch(trimmed, userId, false, onProgress);
    }

    try {
      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'search_cloud_resources',
            description: '从全网公开频道三语并发检索影视、剧集、动漫的网盘资源。无论用户直接输入片名、带有“搜索/电影/想看/帮我找”等自然口语，还是提供演员外号/剧情线索找特定作品，都必须调用此工具并提取纯粹干净的标准中文官方片名！',
            parameters: {
              type: 'object',
              properties: {
                keyword: {
                  type: 'string',
                  description: '提取后的纯粹标准中文官方片名（严禁包含“搜索”“帮我找”“电影”“电视剧”“我想看”等修饰语！例如用户输入“搜索电影 突如其来”，必须提取 keyword="突如其来"）',
                },
                mediaType: {
                  type: 'string',
                  enum: ['movie', 'tv'],
                  description: '若能从用户消息中判断作品类型：movie=电影，tv=电视剧/剧集/动漫番剧',
                },
                year: {
                  type: 'string',
                  description: '用户指定或推理出的 4 位上映/开播年份（如 2026），不确定可省略',
                },
              },
              required: ['keyword'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'transfer_resource',
            description: '将搜索到的夸克网盘链接转存至用户网盘',
            parameters: {
              type: 'object',
              properties: {
                shareId: {
                  type: 'string',
                  description: '网盘分享链接的唯一 ID 或 pwdId',
                },
                category: {
                  type: 'string',
                  description: '资源分类：电影、国产剧、美剧、韩剧、日剧、动漫、综艺',
                },
                title: {
                  type: 'string',
                  description: '所转存资源的官方标准影视剧名（如 今天是太阳雨），用于自动检测并还原防和谐混淆名称',
                },
              },
              required: ['shareId'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_movie_recommendation',
            description: '当用户寻求影视推荐、追问“美剧呢/那最近新出的呢/推荐一部最近火的电影”时调用，结合上下文生成精准的影视推荐',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: '结合多轮上下文还原出的完整推荐需求（必须保留数量如“一部/两部”和时效如“最近新出/近期比较火”），例如：“推荐一部最近比较火的电影”、“最近新出的韩剧”、“推荐好看的美剧”',
                },
                type: {
                  type: 'string',
                  enum: ['movie', 'tv'],
                  description: 'movie 为电影，tv 为电视剧/剧集',
                },
                tag: {
                  type: 'string',
                  description: '韩剧、美剧、英剧、日剧、国产剧、动漫、综艺、电影、悬疑、科幻 等',
                },
              },
              required: ['query'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_douban_hot',
            description: '拉取豆瓣热门电影或电视剧榜单',
            parameters: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['movie', 'tv'],
                  description: 'movie 为电影，tv 为电视剧',
                },
                tag: {
                  type: 'string',
                  description: '热门、国产剧、美剧、韩剧、日剧、动漫等',
                },
              },
              required: ['type'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_system_status',
            description: '查询当前网盘容量与状态',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'set_save_directory',
            description: '修改或设置用户夸克网盘的默认转存目录或文件夹路径，例如“把保存目录改成/追剧”、“存到/我的电影”、“修改转存目录”',
            parameters: {
              type: 'object',
              properties: {
                directory: {
                  type: 'string',
                  description: '用户指定的网盘目标目录，例如 /我的影视、/电影追剧、/影视资源',
                },
              },
              required: ['directory'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'manage_scheduled_task',
            description: '当用户希望设置、查看或修改任何定时、延时或周期监控任务时必须调用。涵盖：相对延时（如“两分钟后推荐一部电影”、“半个小时后转存到网盘”、“10分钟提醒我”）、每日/指定日期定点任务、新片蹲守、连载追更、4K洗版、轮询间隔修改或任意自定义计划任务',
            parameters: {
              type: 'object',
              properties: {
                instruction: {
                  type: 'string',
                  description: '用户的完整定时、延时、监控或轮询间隔指令原文，如“两分钟后给我推荐一部电影”、“半个小时后转存到网盘”、“每10分钟帮我蹲守《流浪地球3》”、“把任务1间隔改成15分钟”',
                },
                action_type: {
                  type: 'string',
                  enum: [
                    'delayed_recommend',
                    'delayed_transfer',
                    'daily_recommend',
                    'resource_watch',
                    'episode_chase',
                    'quality_upgrade',
                    'custom_reminder',
                  ],
                  description: '任务类型：延时荐片(delayed_recommend)、延时转存(delayed_transfer)、定时荐片(daily_recommend)、新片蹲守(resource_watch)、连载追更(episode_chase)、4K洗版(quality_upgrade)、自定义提醒(custom_reminder)',
                },
                delay_minutes: {
                  type: 'number',
                  description: '相对延时触发的分钟数（支持小数，如0.5表示30秒、2表示2分钟、30表示半小时）',
                },
                schedule_time: {
                  type: 'string',
                  description: '每天或单次定点触发时间，24小时制 HH:mm（如 08:30、21:00）',
                },
                interval_minutes: {
                  type: 'number',
                  description: '周期循环轮询间隔分钟数（如 10 表示每10分钟执行一次）',
                },
                one_shot: {
                  type: 'boolean',
                  description: '是否为单次执行任务（相对延时任务默认为 true）',
                },
                keyword: {
                  type: 'string',
                  description: '关联的影视剧片名（如有）',
                },
                content: {
                  type: 'string',
                  description: '推荐要求或提醒内容描述',
                },
                auto_save: {
                  type: 'boolean',
                  description: '触发后是否自动转存至夸克网盘',
                },
              },
              required: ['instruction'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'relay_message',
            description: '跨微信用户传话或回复刚刚收到的传话。当用户想让你帮他问候/带话给另一位微信用户（如“你问一下b最近有什么好看的电影”“帮我告诉小红今晚看电影”），或者回复刚刚传话给自己的人（如“你跟他说最近有个叫xxx的电影还不错”“回他我晚点看”）时调用。',
            parameters: {
              type: 'object',
              properties: {
                target_name: {
                  type: 'string',
                  description: '目标接收人的称呼、昵称或序号（若 is_reply=true 回复上一位传话者，可留空）',
                },
                message: {
                  type: 'string',
                  description: '要转达给对方的自然完整话语内容（去掉“你帮我问一下/你跟他说”等代词指令壳，保留真实表达）',
                },
                is_reply: {
                  type: 'boolean',
                  description: '是否为回复最近刚刚给自己传话的人（如“你跟他说...”、“回他...”）',
                },
              },
              required: ['message'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'manage_user_directory',
            description: '查询当前服务共有几个微信用户/叫什么名字，或者设置自己的对外昵称、给其他用户设置备注名。',
            parameters: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['list_users', 'set_my_name', 'set_contact_alias'],
                  description: 'list_users=查看当前微信用户列表, set_my_name=设置/修改我自己的名字, set_contact_alias=给某个联系人设备注名',
                },
                name: {
                  type: 'string',
                  description: '要设置的昵称或备注名（set_my_name / set_contact_alias 时必填）',
                },
                target_query: {
                  type: 'string',
                  description: '要备注的目标联系人原名或序号（仅 set_contact_alias 时使用）',
                },
              },
              required: ['action'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'share_movie_to_user',
            description: '把当前刚刚推荐/搜索过的好电影或指定影视作品安利分享给另一位微信用户。当用户说“这部电影不错把这部电影推荐给b吧”“把刚才那部《xxx》分享给小红”“把第2部推荐给用户2”时必须调用。',
            parameters: {
              type: 'object',
              properties: {
                target_name: {
                  type: 'string',
                  description: '要分享给的目标用户名字、称呼或通讯录序号（例如 b、小红、2）',
                },
                movie_title: {
                  type: 'string',
                  description: '要分享的影视片名（若用户说“这部电影/刚才那部”，可填入上下文最近提及的片名或留空自动提取）',
                },
                recommend_note: {
                  type: 'string',
                  description: '发送人附带的推荐语或评价（例如“这部电影很不错，推荐给你看看”）',
                },
                selection_index: {
                  type: 'number',
                  description: '如果用户指定分享推荐列表中的“第几部”（如第2部），填入数字序号',
                },
              },
              required: ['target_name'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'update_user_taste_profile',
            description: '记录用户明确表达的观影喜好或排雷厌恶，或者查看/清空用户的个人观影画像。当用户说“我喜欢看科幻/悬疑/韩剧”、“我最爱诺兰和《星际穿越》”、“别给我推恐怖片”、“看看我的观影画像”时调用。',
            parameters: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['update', 'view', 'reset'],
                  description: 'update=更新喜好或排雷, view=查看当前观影画像, reset=清空重建',
                },
                like_media_types: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '用户喜欢的影视形态品类（如 ["电影", "电视剧", "综艺", "动漫", "纪录片", "短剧"]）',
                },
                dislike_media_types: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '用户不看或排斥的影视形态（如 ["短剧", "动漫"]）',
                },
                like_genres: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '用户喜欢的电影/剧集类型（如 ["科幻", "悬疑"]）',
                },
                like_regions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '用户喜欢的国家或地区（如 ["韩国", "美国"]）',
                },
                like_directors: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '用户喜欢的导演（如 ["克里斯托弗·诺兰"]）',
                },
                like_actors: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '用户喜欢的演员',
                },
                favorite_movies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '用户主动提及特别喜欢的代表作品名称（不带书名号）',
                },
                dislike_genres: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '用户明确不看/排雷的类型（如 ["恐怖", "古装"]）',
                },
              },
              required: ['action'],
            },
          },
        },
      ];

      const relay = RelayService.getInstance();
      const directory = relay.getDirectory(userId);
      const myName = relay.getDisplayName(userId, userId);
      const pendingRelay = relay.getPendingReply(userId);
      const recentTitle = this.sessionManager.getRecentTargetTitle(userId);
      const directoryHint =
        directory.length > 0
          ? directory.map((u) => `${u.index}.${u.displayName}${u.isSelf ? '(我)' : ''}`).join('、')
          : '暂无其他记录';
      const pendingHint = pendingRelay
        ? `刚刚「${pendingRelay.fromDisplayName}」给你传了话（内容：“${pendingRelay.originalMessage}”）`
        : '暂无待回复传话';

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: `你是一个微信端像朋友一样的智能影视云盘助手「电视搭子 (TVdazi)」。
你的性格：热情亲切、自然随和、说话通俗简单、接地气，绝不要输出冰冷呆板的客服话术或技术术语。
当前用户对话上下文：你的名字叫「${myName}」；服务通讯录共有 ${directory.length} 位微信用户（${directoryHint}）；传话状态：${pendingHint}；最近刚推荐或讨论过的影视：${recentTitle ? `《${recentTitle}》` : '暂无'}。
核心系统能力与规则（重要）：
1. 你是所有自然语言消息的总控意图分析大脑，必须先准确理解用户的真实意图再调用对应工具。
2. 你拥有后台高精度持久化定时调度引擎，完全支持任意定时、延时、周期蹲守或追更任务（如“两分钟后推荐一部电影”、“半小时后帮我转存到网盘”、“每天早上8点推送”、“每10分钟蹲守《某剧》”），【绝对严禁】推脱拒答！遇到此类需求直接调用 manage_scheduled_task。
3. 你拥有【多用户传话、通讯录与好友安利推片】能力：当用户问服务有几个用户/分别是谁、想设置自己叫什么、想给某人设备注时，调用 manage_user_directory；当用户想把“这部电影/某部片子”推荐或分享给某位用户（如“这部电影不错把这部电影推荐给b吧”）时，必须调用 share_movie_to_user；当用户想给其他用户带普通文字消息或回复传话（如“你跟他说...”）时，调用 relay_message！
4. 当用户直接发来影视名称（如“庆余年”、“突如其来”、“Inception”）、带动词的搜片需求（如“搜索电影 突如其来”、“帮我找一下沙丘2”），或用演员外号/剧情描述寻找某部特定作品时，必须立即调用 search_cloud_resources，并提取出纯粹干净的标准中文官方片名填入 keyword（严禁在 keyword 中残留“搜索/搜/电影/电视剧/想看”等修饰字样！）。
5. 当用户寻求【立即】影视推荐、榜单或延续上一轮推荐条件追问（如“有什么好看的韩剧”、“换一部”、“美剧呢”）时，调用 get_movie_recommendation 工具（结合对话历史保留类型/年份/题材要求）。若带延时，调用 manage_scheduled_task。
6. 当用户询问网盘状态、容量时，调用 get_system_status；想修改网盘保存目录时，调用 set_save_directory。
7. 当用户用自然语言表达自己喜欢/不喜欢什么样的【电影、电视剧、综艺、动漫、纪录片、题材、地区、导演、演员、代表作】（如“我平时喜欢看韩国悬疑电影和搞笑综艺”、“我爱看《漫长的季节》，不爱看恐怖片”），或让 bot 分析/查看自己的口味画像时，必须调用 update_user_taste_profile！
8. 仅在明确属于日常打招呼、感谢或普通闲聊时，像微信好友一样简短、风趣、有温度地直接回复。`,
        },
        ...chatHistory,
        { role: 'user', content: trimmed },
      ];

      const completion = await client.chat.completions.create({
        model: model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.2,
      });

      const choice = completion.choices[0];
      const toolCalls = choice.message.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const args = JSON.parse(toolCall.function.arguments || '{}');

        if (toolCall.function.name === 'search_cloud_resources') {
          const targetKeyword = String(args.keyword || '').trim() || trimmed;
          const mediaType = args.mediaType === 'movie' || args.mediaType === 'tv' ? args.mediaType : undefined;
          const year = args.year ? String(args.year).slice(0, 4) : undefined;
          const searchReply = await this.commandHandler.renderSearch(targetKeyword, userId, {
            mediaType,
            year,
            skipAiCorrector: Boolean(args.keyword && String(args.keyword).trim()),
            onProgress,
          });
          appendUserHistory(trimmed, searchReply);
          return searchReply;
        } else if (toolCall.function.name === 'transfer_resource') {
          let shareId = args.shareId;
          const match = shareId.match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/);
          if (match) shareId = match[1];

          const userPlan = this.userManager.getUserPlan(userId);
          const saveRes = await this.quarkService.saveShareFiles(shareId, '', (args.category as any) || '电影', {
            customCookie: userPlan.quarkCookie,
            rootDir: userPlan.saveRootDir,
            standardTitle: args.title || undefined,
            userId: userId,
          });
          if (saveRes.success) {
            this.userManager.recordSave(userId, args.title, `https://pan.quark.cn/s/${shareId}`, (args.category as any) || '电影');
          }
          appendUserHistory(trimmed, saveRes.message);
          return saveRes.message;
        } else if (toolCall.function.name === 'get_movie_recommendation' || toolCall.function.name === 'get_douban_hot') {
          const query = args.query || args.tag || trimmed;
          const hotReply = await this.commandHandler.renderHot(
            args.type || 'tv',
            args.tag || '热门',
            userId,
            1,
            undefined,
            query,
            chatHistory
          );
          appendUserHistory(trimmed, hotReply);
          return hotReply;
        } else if (toolCall.function.name === 'get_system_status') {
          const statusReply = await this.commandHandler.handle('/status', userId);
          appendUserHistory(trimmed, statusReply);
          return statusReply;
        } else if (toolCall.function.name === 'set_save_directory') {
          const dirReply = await this.commandHandler.handle(`/set-dir ${args.directory || ''}`, userId);
          appendUserHistory(trimmed, dirReply);
          return dirReply;
        } else if (toolCall.function.name === 'manage_scheduled_task') {
          const schedReply = await SchedulerService.getInstance().createStructuredTask(userId, {
            ...args,
            instruction: args.instruction || trimmed,
          });
          appendUserHistory(trimmed, schedReply);
          return schedReply;
        } else if (toolCall.function.name === 'relay_message') {
          const relaySvc = RelayService.getInstance();
          const targetName = String(args.target_name || '').trim();
          const msgText = String(args.message || '').trim();
          const isReply = Boolean(args.is_reply) || (!targetName && Boolean(relaySvc.getPendingReply(userId)));
          const relayReply = isReply
            ? (await relaySvc.replyToLastSender(userId, msgText)).replyToReplier
            : (await relaySvc.sendRelayMessage(userId, targetName, msgText)).replyToSender;
          appendUserHistory(trimmed, relayReply);
          return relayReply;
        } else if (toolCall.function.name === 'manage_user_directory') {
          const relaySvc = RelayService.getInstance();
          let dirReply = '';
          if (args.action === 'set_my_name') {
            dirReply = relaySvc.setMyNickname(userId, String(args.name || '')).message;
          } else if (args.action === 'set_contact_alias') {
            dirReply = relaySvc.setContactRemark(
              userId,
              String(args.target_query || ''),
              String(args.name || '')
            ).message;
          } else {
            dirReply = relaySvc.renderDirectoryText(userId);
          }
          appendUserHistory(trimmed, dirReply);
          return dirReply;
        } else if (toolCall.function.name === 'share_movie_to_user') {
          const relaySvc = RelayService.getInstance();
          const shareRes = await relaySvc.shareMovieToUser(userId, String(args.target_name || ''), {
            movieTitle: args.movie_title ? String(args.movie_title) : undefined,
            recommendReason: args.recommend_note ? String(args.recommend_note) : undefined,
            selectionIndex: typeof args.selection_index === 'number' ? args.selection_index : undefined,
          });
          appendUserHistory(trimmed, shareRes.replyToSender);
          return shareRes.replyToSender;
        } else if (toolCall.function.name === 'update_user_taste_profile') {
          const profileSvc = UserProfileService.getInstance();
          let profileReply = '';
          if (args.action === 'view') {
            profileReply = profileSvc.renderProfileCard(userId);
          } else if (args.action === 'reset') {
            profileSvc.clearProfile(userId);
            profileReply = '✅ 已清空你的个人观影口味画像，之后会根据你的新喜好重新学习！';
          } else {
            const nlpParsed = profileSvc.parseNaturalLanguagePreference(trimmed);
            const mergeArr = (a: unknown, b: string[]) =>
              Array.from(new Set([...(Array.isArray(a) ? a.map(String) : []), ...b].map((s) => s.trim()).filter(Boolean)));
            profileSvc.recordExplicitPreference(userId, {
              likeMediaTypes: mergeArr(args.like_media_types, nlpParsed.likeMediaTypes),
              dislikeMediaTypes: mergeArr(args.dislike_media_types, nlpParsed.dislikeMediaTypes),
              likeGenres: mergeArr(args.like_genres, nlpParsed.likeGenres),
              likeRegions: mergeArr(args.like_regions, nlpParsed.likeRegions),
              likeDirectors: mergeArr(args.like_directors, nlpParsed.likeDirectors),
              likeActors: mergeArr(args.like_actors, nlpParsed.likeActors),
              favoriteSeeds: mergeArr(args.favorite_movies, nlpParsed.favoriteSeeds),
              dislikeGenres: mergeArr(args.dislike_genres, nlpParsed.dislikeGenres),
              dislikeTitles: nlpParsed.dislikeTitles,
            });
            profileReply = `👌 已记住你的偏好并完成算法画像分析，后续推片会精准匹配你的口味~\n\n${profileSvc.renderProfileCard(userId)}`;
          }
          appendUserHistory(trimmed, profileReply);
          return profileReply;
        }
      }

      const defaultReply = choice.message.content || '在呢在呢！今天想看什么好片子？告诉我名字，马上帮你搜网盘活链！';
      appendUserHistory(trimmed, defaultReply);
      return defaultReply;
    } catch (err: any) {
      console.error('[DeepSeekAgent 调用异常]', err?.message || err);
      const fallbackReply = await this.fallbackDirectSearch(trimmed, userId, true, onProgress);
      appendUserHistory(trimmed, fallbackReply);
      return fallbackReply;
    }
  }

  private async fallbackDirectSearch(
    text: string,
    userId: string = 'default_user',
    isApiError: boolean = false,
    onProgress?: (msg: string) => Promise<void>
  ): Promise<string> {
    const greetings = ['你好', '您好', 'hi', 'hello', '在吗', '早', '晚上好', '在么', '你是谁', '你叫什么'];
    const lower = text.toLowerCase().replace(/[？?！!。，,\s]/g, '');
    if (greetings.includes(lower)) {
      return '嗨，我是你的网盘看片小助手 电视搭子 (TVdazi)！\n平时想看什么电影、电视剧直接把名字发我就行（比如“庆余年”、“功夫之王”），我来帮你全网搜活链转存~';
    }

    if (UserProfileService.isNaturalPreferenceStatement(text)) {
      const profileSvc = UserProfileService.getInstance();
      profileSvc.applyNaturalLanguagePreference(userId, text);
      return `👌 已记住你的偏好并完成算法画像分析，后续推片会精准匹配你的口味~\n\n${profileSvc.renderProfileCard(userId)}`;
    }

    // 明显是日常聊天/疑问句且并非具体片名时，API 异常时友好提示而不是硬搜 50 个频道
    const looksLikeChatQuestion =
      text.length > 18 ||
      /(?:为什么|怎么回事|怎么样|天气|吃什么|谢谢|哈哈|好的|知道了|没事|在干嘛|干什么)/.test(text);
    if (isApiError && looksLikeChatQuestion) {
      return '哎呀，AI 助手刚刚开了个小差 😅\n如果是想找影视资源，可以直接发送「搜 片名」（如：搜 庆余年），或者发送 /help 查看快捷指令！';
    }

    return await this.commandHandler.renderSearch(text, userId, { onProgress });
  }
}
