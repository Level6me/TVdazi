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

export interface RecognizedImageResult {
  standardTitle: string;
  originalTitle?: string;
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
    return /^(?:搜索|搜|搜一下|搜一搜|搜吧|开始搜索|开始|好的|好|好呀|嗯|嗯嗯|要|要的|需要|是|是的|查一下|帮我搜|确认|可以|行|1|ok|yes)[!！。.~～]*$/i.test(
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

  async chat(userMessage: string, chatHistoryOrUserId?: any[] | string, maybeUserId?: string): Promise<string> {
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

    // 1. 优先匹配原版指令、快捷翻页或序号选择
    if (this.commandHandler.isCommand(trimmed, userId)) {
      const reply = await this.commandHandler.handle(trimmed, userId);
      appendUserHistory(trimmed, reply);
      return reply;
    }

    // 1.5 优先识别「具体剧情细节找特定某部片 / 记不清片名」意图（避免被泛化推荐正则抢占）
    const isSpecificPlotIdentify =
      /(?:记不清名字|忘了叫什么|叫什么名字|哪部电影|哪部剧|什么电影|什么电视剧|有一部(?:电影|电视剧|剧|动漫|片)|有个(?:电影|电视剧|剧|片)|讲的是.+|男主.+女主.+|主角.+)/.test(
        trimmed
      ) && !/(?:推荐|有哪些|有什么好看|求推荐|安利|类似|同款)/.test(trimmed);

    if (isSpecificPlotIdentify && trimmed.length < 200) {
      const reply = await this.commandHandler.renderSearch(trimmed, userId);
      appendUserHistory(trimmed, reply);
      return reply;
    }

    // 2. 意图快速嗅探：影视推荐与种草对话（支持指定年份、年代、档期、类似剧情、数量、时效、地区、类型及多轮追问等自然语言表达）
    const isHotFollowUp =
      this.sessionManager.getLastActiveType(userId) === 'hot' &&
      trimmed.length <= 18 &&
      !SessionManager.isCancelCommand(trimmed) &&
      !/(?:不要了|不用了|算了|取消|不看了|不选了)/.test(trimmed) &&
      /(?:^(?:不要|别推|不看|换|那|再来|有没?有)|(?:的呢|的吗|呢)$|(?:韩剧|美剧|英剧|日剧|国产剧|电影|悬疑|喜剧|科幻|爱情|古装|恐怖|治愈|高分|今年|去年|最近))/.test(
        trimmed
      ) &&
      !/(?:我想看|帮我搜|搜一下)/.test(trimmed);

    const isRecommendIntent =
      isHotFollowUp ||
      /(?:推荐|有什么好看|有哪些好看|求推荐|安利|介绍几部|介绍一部|推几部|推一部|发几部|换一部.+|换几部.+|有没有类似|类似.+的(?:剧|电影|片|动漫)|像.+?(?:一样|那样|这种|那种).*?(?:的剧|的电影|的片|有哪些|有什么|推荐)|(?:来一部|来部|找一部|找部|看一部|有没有).*?(?:火|好看|新|高分|经典|悬疑|搞笑|喜剧|治愈|甜宠|科幻|动作|犯罪|下饭|恐怖|古装|武侠|奇幻|战争|历史|灾难|家庭|19\d\d|20\d\d|[789012]0年代)|(?:最近|近期|今年|去年|前年|这两个月|近两个月|这阵子|19\d\d年?|20\d\d年?|[789012]0年代|春节档|暑期档|国庆档).*?(?:新出|比較火|比较火|最火|热门|好看|热播|在播|高分|经典|有什么|有哪些).*?(?:电影|剧|动漫|片|综艺|纪录片)?|(?:韩剧|美剧|英剧|日剧|国剧|国产剧|港片|港剧|台剧|泰剧|动漫|电影|电视剧|悬疑片|科幻片|喜剧片|动作片|恐怖片|犯罪片).*?(?:有哪些|有什么|推荐))/i.test(
        trimmed
      );
    if (isRecommendIntent) {
      const prevHot = this.sessionManager.getHot(userId);
      let type: 'movie' | 'tv' = isHotFollowUp && prevHot ? prevHot.type : 'tv';
      let tag = isHotFollowUp && prevHot?.tag ? prevHot.tag : '热门';

      if (/(?:电影|大片|影史|高分片|院线|科幻片|动作片|喜剧片|恐怖片|悬疑片)/i.test(trimmed)) {
        type = 'movie';
      } else if (/(?:电视剧|剧集|韩剧|美剧|英剧|日剧|国剧|国产剧|港剧|台剧|泰剧|网剧)/i.test(trimmed)) {
        type = 'tv';
      }
      if (/韩剧|韩国/i.test(trimmed)) tag = '韩剧';
      else if (/美剧|美国/i.test(trimmed)) tag = '美剧';
      else if (/英剧|英国/i.test(trimmed)) tag = '英剧';
      else if (/日剧|日本/i.test(trimmed)) tag = '日剧';
      else if (/(?:国剧|国产剧|华语剧)/i.test(trimmed)) tag = '国产剧';
      else if (/(?:动漫|日漫|番剧|动画)/i.test(trimmed)) tag = '动漫';
      else if (/(?:悬疑|推理|烧脑)/i.test(trimmed)) tag = '悬疑';
      else if (/(?:科幻|硬科幻)/i.test(trimmed)) tag = '科幻';
      else if (/(?:治愈|温馨|温情)/i.test(trimmed)) tag = '治愈';
      else if (/(?:喜剧|搞笑|下饭)/i.test(trimmed)) tag = '喜剧';

      const recReply = await this.commandHandler.renderHot(type, tag, userId, 1, undefined, trimmed, chatHistory);
      appendUserHistory(trimmed, recReply);
      return recReply;
    }

    // 3. 意图快速嗅探：如果包含“我想看”、“帮我找一下”、“有一部电影讲...”、“记不清名字了”等自然口语或剧情细节描述，直接进入 renderSearch（由 AiCorrector 推理识别具体片名并搜网盘）
    const searchMatch = trimmed.match(
      /^(?:我想看|我想找|我要看|帮我找一下|帮我找|搜一下|搜搜|搜|找找|找一部|找部|找|想看|求一下|求|有没有一部|有一部|有个|记不清名字|忘了叫什么)\s*(?:电影|电视剧|网剧|动漫|动漫电影|韩剧|美剧|日剧|港片)?\s*(.+)$/i
    );
    if (searchMatch && searchMatch[1]) {
      const targetWord = searchMatch[1].trim();
      if (targetWord.length > 0 && targetWord.length < 200) {
        const reply = await this.commandHandler.renderSearch(trimmed, userId);
        appendUserHistory(trimmed, reply);
        return reply;
      }
    }

    // 3. 获取用户专属或共享的 DeepSeek 客户端
    const { client, model, hasValidKey } = this.getClientForUser(userId, 12000);

    if (!hasValidKey) {
      return this.fallbackDirectSearch(trimmed, userId, false);
    }

    try {
      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'search_cloud_resources',
            description: '从公开频道联合检索影视、剧集、动漫等网盘活链资源。如果用户使用演员俗称/外号（如荷兰弟、小李子、甜茶、阿汤哥）、角色缩写或别字，提炼为标准官方片名检索',
            parameters: {
              type: 'object',
              properties: {
                keyword: {
                  type: 'string',
                  description: '核心搜索关键词，例如电影名、剧集名，尽量精简且为标准中文官方片名',
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
      ];

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: `你是一个微信端像朋友一样的智能影视云盘助手「WeSaver」。
你的性格：热情亲切、自然随和、说话通俗简单、接地气，绝不要输出冰冷呆板的客服话术或技术术语。
核心系统能力与规则（重要）：
1. 你拥有后台高精度持久化定时调度引擎，完全支持任意定时或延时任务（包括“两分钟后推荐一部电影”、“半小时后帮我转存到网盘”、“每天早上8点推送”、“每10分钟蹲守”等），【绝对严禁】回答“我没法掐表”、“我不能等半小时再动手”等推脱借口！遇到此类需求时，直接调用 manage_scheduled_task 工具注册定时/延时任务。
2. 当用户有看片、搜剧意图时（例如“我想看流浪地球”、“搜庆余年”），调用 search_cloud_resources 工具检索。
3. 当用户寻求【立即】影视推荐、询问“有什么好看的/有什么推荐的电视剧/韩剧/美剧/电影”时，调用 get_movie_recommendation 工具生成小红书风格的种草笔记清单。若带有延时（如“X分钟后推一部”），必须调用 manage_scheduled_task。
4. 当用户询问状态、容量时，调用 get_system_status 工具。
5. 当用户想要修改网盘保存目录时，调用 set_save_directory 工具或引导其发送 /set-dir。
6. 日常闲聊像微信好友一样简短、风趣、有温度地回应。`,
        },
        ...chatHistory,
        { role: 'user', content: trimmed },
      ];

      const completion = await client.chat.completions.create({
        model: model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
      });

      const choice = completion.choices[0];
      const toolCalls = choice.message.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const args = JSON.parse(toolCall.function.arguments || '{}');

        if (toolCall.function.name === 'search_cloud_resources') {
          const searchReply = await this.commandHandler.renderSearch(args.keyword, userId);
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
        }
      }

      const defaultReply = choice.message.content || '在呢在呢！今天想看什么好片子？告诉我名字，马上帮你搜网盘活链！';
      appendUserHistory(trimmed, defaultReply);
      return defaultReply;
    } catch (err: any) {
      console.error('[DeepSeekAgent 调用异常]', err?.message || err);
      const fallbackReply = await this.fallbackDirectSearch(trimmed, userId, true);
      appendUserHistory(trimmed, fallbackReply);
      return fallbackReply;
    }
  }

  private async fallbackDirectSearch(
    text: string,
    userId: string = 'default_user',
    isApiError: boolean = false
  ): Promise<string> {
    const greetings = ['你好', '您好', 'hi', 'hello', '在吗', '早', '晚上好', '在么', '你是谁', '你叫什么'];
    const lower = text.toLowerCase().replace(/[？?！!。，,\s]/g, '');
    if (greetings.includes(lower)) {
      return '嗨，我是你的网盘看片小助手 WeSaver！\n平时想看什么电影、电视剧直接把名字发我就行（比如“庆余年”、“功夫之王”），我来帮你全网搜活链转存~';
    }

    // 明显是日常聊天/疑问句且并非具体片名时，API 异常时友好提示而不是硬搜 50 个频道
    const looksLikeChatQuestion =
      text.length > 18 ||
      /(?:为什么|怎么回事|怎么样|天气|吃什么|谢谢|哈哈|好的|知道了|没事|在干嘛|干什么)/.test(text);
    if (isApiError && looksLikeChatQuestion) {
      return '哎呀，AI 助手刚刚开了个小差 😅\n如果是想找影视资源，可以直接发送「搜 片名」（如：搜 庆余年），或者发送 /help 查看快捷指令！';
    }

    return await this.commandHandler.renderSearch(text, userId);
  }
}
