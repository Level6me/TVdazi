import OpenAI from 'openai';
import { ResourceSearcher } from '../services/Searcher';
import { QuarkService } from '../services/QuarkService';
import { DoubanService } from '../services/DoubanService';
import { ChannelManager } from '../services/ChannelManager';
import { CommandHandler } from '../commands/CommandHandler';
import { SessionManager } from '../services/SessionManager';
import { UserManager } from '../services/UserManager';

export class DeepSeekAgent {
  private globalClient: OpenAI;
  private searcher: ResourceSearcher;
  private quarkService: QuarkService;
  private doubanService: DoubanService;
  private channelManager: ChannelManager;
  private commandHandler: CommandHandler;
  private sessionManager: SessionManager;
  private userManager: UserManager;
  private userHistories: Map<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]> = new Map();
  private globalApiKey: string;
  private globalBaseURL: string;
  private defaultModel: string;
  private visionModel: string;

  constructor(apiKey?: string, baseURL?: string, model?: string) {
    this.globalApiKey = apiKey || process.env.DEEPSEEK_API_KEY || '';
    this.globalBaseURL = baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    this.defaultModel = model || process.env.DEEPSEEK_MODEL || 'deepseek-flash';
    this.visionModel = process.env.DEEPSEEK_VISION_MODEL || 'deepseek-flash';

    this.globalClient = new OpenAI({
      apiKey: this.globalApiKey,
      baseURL: this.globalBaseURL,
    });

    this.searcher = new ResourceSearcher();
    this.quarkService = new QuarkService();
    this.doubanService = new DoubanService();
    this.channelManager = new ChannelManager();
    this.commandHandler = new CommandHandler();
    this.sessionManager = SessionManager.getInstance();
    this.userManager = UserManager.getInstance();
  }

  private getClientForUser(userId: string): { client: OpenAI; model: string; isCustom: boolean } {
    const userPlan = this.userManager.getUserPlan(userId);
    const activeKey = userPlan.deepseekApiKey?.trim() || userPlan.inheritedApiKey?.trim();

    if (activeKey) {
      return {
        client: new OpenAI({
          apiKey: activeKey,
          baseURL: this.globalBaseURL,
        }),
        model: userPlan.deepseekModel || this.defaultModel,
        isCustom: true,
      };
    }

    return {
      client: this.globalClient,
      model: this.defaultModel,
      isCustom: false,
    };
  }

  /**
   * 使用 DeepSeek 多模态模型识别图片中的影视剧名或电影（增强模糊推理与角色关联）
   */
  async recognizeMovieFromImage(imageBuffer: Buffer, userId: string = 'default_user'): Promise<string | null> {
    const { client } = this.getClientForUser(userId);
    if (!client.apiKey) return null;

    try {
      const base64Data = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

      const res = await client.chat.completions.create({
        model: this.visionModel,
        messages: [
          {
            role: 'system',
            content: `你是一个精通古今中外全部电影、电视剧、动漫、网剧的专家。
用户会发送剧照、海报、剧集截图、台词截图、主角合照、动漫画面甚至是画质模糊的影视片段。
任务要求：
1. 请深度观察图片中的人物面孔、角色装扮、服饰道具、场景特征、字幕台词或画面文字；
2. 尽最大可能推断出这最可能是哪一部电影、电视剧或动漫作品的中文名称；
3. 输出格式要求：如果推断出结果，请【严格只输出标准中文片名】，绝对不要包含标点符号、书名号、演员名字或额外解释（例如直接输出：功夫之王、庆余年、仙剑奇侠传、繁花、海贼王）；
4. 如果图片完全与影视剧无关（例如纯风景、纯美食、自拍照），才输出「NONE」。`,
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: '请观察这张图片，推断并直接输出对应影视作品的中文片名：' },
              { type: 'image_url', image_url: { url: base64Data } },
            ],
          },
        ],
        temperature: 0.2,
      });

      const reply = res.choices[0]?.message?.content?.trim() || '';
      if (!reply || reply.toUpperCase() === 'NONE' || reply.includes('无法识别') || reply.includes('无法查看')) {
        return null;
      }

      const cleanTitle = reply.replace(/[《》""''「」\n\r]/g, '').trim();
      return cleanTitle || null;
    } catch (err: any) {
      console.error('[DeepSeek 多模态识别异常]', err.message);
      return null;
    }
  }

  /**
   * 处理用户发送的图片（识图搜剧闭环，呈现精简排版）
   */
  async handleImageMessage(imageBuffer: Buffer, userId: string = 'default_user'): Promise<string> {
    const detectedTitle = await this.recognizeMovieFromImage(imageBuffer, userId);

    if (detectedTitle) {
      const searchResultText = await this.commandHandler.renderSearch(detectedTitle, userId);
      return [
        `📸 收到图片！AI 识别出影视片名：【《${detectedTitle}》】`,
        searchResultText,
      ].join('\n');
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
      chatHistory = this.userHistories.get(userId) || [];
    }

    const appendUserHistory = (userText: string, assistantReply: string) => {
      let list = this.userHistories.get(userId) || [];
      list.push({ role: 'user', content: userText });
      list.push({ role: 'assistant', content: assistantReply });
      if (list.length > 12) {
        list = list.slice(-12);
      }
      this.userHistories.set(userId, list);
    };

    // 1. 优先匹配原版指令、快捷翻页或序号选择
    if (this.commandHandler.isCommand(trimmed, userId)) {
      const reply = await this.commandHandler.handle(trimmed, userId);
      appendUserHistory(trimmed, reply);
      return reply;
    }

    // 2. 意图快速嗅探：影视推荐与种草对话（支持指定年份、年代、档期、类似剧情、数量、时效、地区、类型及多轮追问等自然语言表达）
    const isRecommendIntent =
      /(?:推荐|有什么好看|有哪些好看|求推荐|安利|介绍几部|介绍一部|推几部|推一部|发几部|换一部.+|换几部.+|有没有类似|类似.+的(?:剧|电影|片|动漫)|像.+?(?:一样|那样|这种|那种).*?(?:的剧|的电影|的片|有哪些|有什么|推荐)|(?:来一部|来部|找一部|找部|看一部|有没有).*?(?:火|好看|新|高分|经典|悬疑|搞笑|喜剧|治愈|甜宠|科幻|动作|犯罪|下饭|恐怖|古装|武侠|奇幻|战争|历史|灾难|家庭|19\d\d|20\d\d|[789012]0年代)|(?:最近|近期|今年|去年|前年|这两个月|近两个月|这阵子|19\d\d年?|20\d\d年?|[789012]0年代|春节档|暑期档|国庆档).*?(?:新出|比較火|比较火|最火|热门|好看|热播|在播|高分|经典|有什么|有哪些).*?(?:电影|剧|动漫|片|综艺|纪录片)?|(?:韩剧|美剧|英剧|日剧|国剧|国产剧|港片|港剧|台剧|泰剧|动漫|电影|电视剧|悬疑片|科幻片|喜剧片|动作片|恐怖片|犯罪片).*?(?:有哪些|有什么|推荐))/i.test(
        trimmed
      );
    if (isRecommendIntent) {
      let type: 'movie' | 'tv' = 'tv';
      let tag = '热门';

      if (/(?:电影|大片|影史|高分片|院线|科幻片|动作片|喜剧片|恐怖片|悬疑片)/i.test(trimmed)) {
        type = 'movie';
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
    const { client, model } = this.getClientForUser(userId);

    if (!this.globalApiKey && (!client.apiKey || client.apiKey === '')) {
      return this.fallbackDirectSearch(trimmed, userId);
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
      ];

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: `你是一个微信端像朋友一样的智能影视云盘助手「WeSaver」。
你的性格：热情亲切、自然随和、说话通俗简单、接地气，绝不要输出冰冷呆板的客服话术或技术术语。
核心任务：
1. 当用户有看片、搜剧意图时（例如“我想看流浪地球”、“搜庆余年”），调用 search_cloud_resources 工具检索。
2. 当用户寻求影视推荐、询问“有什么好看的/有什么推荐的电视剧/韩剧/美剧/电影”时，调用 get_movie_recommendation 工具生成小红书风格的种草笔记清单。
3. 当用户询问状态、容量时，调用 get_system_status 工具。
4. 当用户想要修改网盘保存目录时，调用 set_save_directory 工具或引导其发送 /set-dir。
5. 日常闲聊像微信好友一样简短、风趣、有温度地回应。`,
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
          return await this.commandHandler.renderSearch(args.keyword, userId);
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
        }
      }

      const defaultReply = choice.message.content || '在呢在呢！今天想看什么好片子？告诉我名字，马上帮你搜网盘活链！';
      appendUserHistory(trimmed, defaultReply);
      return defaultReply;
    } catch (err: any) {
      const fallbackReply = await this.fallbackDirectSearch(trimmed, userId);
      appendUserHistory(trimmed, fallbackReply);
      return fallbackReply;
    }
  }

  private async fallbackDirectSearch(text: string, userId: string = 'default_user'): Promise<string> {
    const greetings = ['你好', '您好', 'hi', 'hello', '在吗', '早', '晚上好', '在么'];
    if (greetings.includes(text.toLowerCase())) {
      return '嗨，我是你的网盘看片小助手！\n平时想看什么电影、电视剧直接把名字发我就行（比如“庆余年”、“功夫之王”），我来帮你全网搜活链转存~';
    }

    return await this.commandHandler.renderSearch(text, userId);
  }
}
