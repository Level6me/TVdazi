import { LlmClientFactory } from '../utils/LlmClientFactory';

export interface CorrectionResult {
  originalKeyword: string;
  correctedKeyword: string;
  standardTitle: string;
  candidateKeywords: string[];
  isCorrected: boolean;
  isPlotInferred?: boolean;
  explanation?: string;
}

export class AiCorrector {
  private static instance: AiCorrector;
  private cache: Map<string, { result: CorrectionResult; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24小时缓存

  // 本地常见俗称、外号与别名映射库（0 延迟离线极速匹配）
  private static readonly LOCAL_ALIAS_RULES: Array<{
    pattern: RegExp;
    standardTitle: string;
    searchKeyword: string;
    candidateKeywords: string[];
    explanation: string;
  }> = [
    {
      pattern: /(?:荷兰弟|赫兰德)(?:的|演的|主演的)?\s*(?:最新)?(?:的)?\s*蜘蛛侠/i,
      standardTitle: '蜘蛛侠：英雄归来',
      searchKeyword: '蜘蛛侠',
      candidateKeywords: ['蜘蛛侠：英雄无归', '蜘蛛侠：英雄归来', '蜘蛛侠：英雄远征', '蜘蛛侠'],
      explanation: '“荷兰弟”指汤姆·赫兰德，对应其主演的漫威《蜘蛛侠》系列',
    },
    {
      pattern: /(?:小李子|莱昂纳多)(?:的|演的|主演的)?\s*盗梦空间/i,
      standardTitle: '盗梦空间',
      searchKeyword: '盗梦空间',
      candidateKeywords: ['盗梦空间'],
      explanation: '“小李子”指莱昂纳多·迪卡普里奥',
    },
    {
      pattern: /(?:小李子|莱昂纳多)(?:的|演的|主演的)?\s*泰坦尼克(?:号)?/i,
      standardTitle: '泰坦尼克号',
      searchKeyword: '泰坦尼克号',
      candidateKeywords: ['泰坦尼克号', '泰坦尼克'],
      explanation: '“小李子”指莱昂纳多·迪卡普里奥',
    },
    {
      pattern: /(?:小李子|莱昂纳多)(?:的|演的|主演的)?\s*荒野猎人/i,
      standardTitle: '荒野猎人',
      searchKeyword: '荒野猎人',
      candidateKeywords: ['荒野猎人'],
      explanation: '“小李子”指莱昂纳多·迪卡普里奥',
    },
    {
      pattern: /(?:甜茶|提莫西)(?:的|演的|主演的)?\s*沙丘/i,
      standardTitle: '沙丘',
      searchKeyword: '沙丘',
      candidateKeywords: ['沙丘2', '沙丘'],
      explanation: '“甜茶”指提莫西·查拉梅',
    },
    {
      pattern: /(?:甜茶|提莫西)(?:的|演的|主演的)?\s*旺卡/i,
      standardTitle: '旺卡',
      searchKeyword: '旺卡',
      candidateKeywords: ['旺卡'],
      explanation: '“甜茶”指提莫西·查拉梅',
    },
    {
      pattern: /(?:阿汤哥|克鲁斯)(?:的|演的|主演的)?\s*碟中谍/i,
      standardTitle: '碟中谍',
      searchKeyword: '碟中谍',
      candidateKeywords: ['碟中谍7', '碟中谍'],
      explanation: '“阿汤哥”指汤姆·克鲁斯',
    },
    {
      pattern: /(?:阿汤哥|克鲁斯)(?:的|演的|主演的)?\s*壮志凌云/i,
      standardTitle: '壮志凌云',
      searchKeyword: '壮志凌云',
      candidateKeywords: ['壮志凌云2', '壮志凌云'],
      explanation: '“阿汤哥”指汤姆·克鲁斯',
    },
    {
      pattern: /(?:星爷|周星驰)(?:的|演的|主演的)?\s*功夫/i,
      standardTitle: '功夫',
      searchKeyword: '功夫',
      candidateKeywords: ['功夫'],
      explanation: '“星爷”指周星驰经典电影《功夫》',
    },
    {
      pattern: /(?:星爷|周星驰)(?:的|演的|主演的)?\s*少林足球/i,
      standardTitle: '少林足球',
      searchKeyword: '少林足球',
      candidateKeywords: ['少林足球'],
      explanation: '“星爷”指周星驰经典电影《少林足球》',
    },
    {
      pattern: /(?:星爷|周星驰)(?:的|演的|主演的)?\s*大话西游/i,
      standardTitle: '大话西游之大圣娶亲',
      searchKeyword: '大话西游',
      candidateKeywords: ['大话西游之月光宝盒', '大话西游之大圣娶亲', '大话西游'],
      explanation: '“星爷”指周星驰经典电影《大话西游》系列',
    },
    {
      pattern: /^(?:球2|流浪月球|流浪地球二)$/i,
      standardTitle: '流浪地球2',
      searchKeyword: '流浪地球2',
      candidateKeywords: ['流浪地球2', '流浪地球'],
      explanation: '还原简称「球2」为《流浪地球2》',
    },
    {
      pattern: /^(?:球1|流浪地球一)$/i,
      standardTitle: '流浪地球',
      searchKeyword: '流浪地球',
      candidateKeywords: ['流浪地球'],
      explanation: '还原简称「球1」为《流浪地球》',
    },
    {
      pattern: /^(?:妇联4|复联4|复仇者联盟四)$/i,
      standardTitle: '复仇者联盟4：终局之战',
      searchKeyword: '复仇者联盟4',
      candidateKeywords: ['复仇者联盟4', '复仇者联盟'],
      explanation: '还原简称「复联4」为《复仇者联盟4：终局之战》',
    },
    {
      pattern: /^(?:妇联3|复联3|复仇者联盟三)$/i,
      standardTitle: '复仇者联盟3：无限战争',
      searchKeyword: '复仇者联盟3',
      candidateKeywords: ['复仇者联盟3', '复仇者联盟'],
      explanation: '还原简称「复联3」为《复仇者联盟3：无限战争》',
    },
    {
      pattern: /^(?:妇联|复联)$/i,
      standardTitle: '复仇者联盟',
      searchKeyword: '复仇者联盟',
      candidateKeywords: ['复仇者联盟4', '复仇者联盟3', '复仇者联盟'],
      explanation: '还原简称「复联」为《复仇者联盟》系列',
    },
    {
      pattern: /^(?:权游|权利的游戏)(?:\s*(?:第)?(\d+)(?:季)?)?$/i,
      standardTitle: '权力的游戏',
      searchKeyword: '权力的游戏',
      candidateKeywords: ['权力的游戏'],
      explanation: '纠正常见别名「权游」为 HBO 剧集《权力的游戏》',
    },
    {
      pattern: /^(?:真环传|甄环传|甄王争传)$/i,
      standardTitle: '甄嬛传',
      searchKeyword: '甄嬛传',
      candidateKeywords: ['甄嬛传', '后宫·甄嬛传'],
      explanation: '纠正错别字为经典清宫剧《甄嬛传》',
    },
    {
      pattern: /^(?:狂彪|狂风)$/i,
      standardTitle: '狂飙',
      searchKeyword: '狂飙',
      candidateKeywords: ['狂飙'],
      explanation: '纠正错别字为张译、张颂文主演电视剧《狂飙》',
    },
  ];

  private constructor() {}

  public static getInstance(): AiCorrector {
    if (!AiCorrector.instance) {
      AiCorrector.instance = new AiCorrector();
    }
    return AiCorrector.instance;
  }

  private setCachedResult(cacheKey: string, result: CorrectionResult): void {
    if (!this.cache.has(cacheKey) && this.cache.size >= 500) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(cacheKey, { result, timestamp: Date.now() });
  }

  /**
   * 清理用户口头修饰语，例如“我想看”、“搜索电影”、“有没有”、“求一个”
   */
  public cleanQuery(raw: string): string {
    return raw
      .replace(
        /^(?:我想看|我想找|我要看|我想要|帮我搜一下|帮我搜|帮我找一下|帮我找|搜索一下|搜索|搜一下|搜搜|搜|找找|找一部|找部|找|求一下|求|有没有一部|有没有|有无|来一部|来部|推荐一部|看下|看一下)\s*(?:电影|电视剧|网剧|剧集|动漫|动漫电影|韩剧|美剧|日剧|港片)?[\s:：]*/i,
        ''
      )
      .replace(/[《》""''「」]/g, '')
      .trim();
  }

  /**
   * 实体识别与智能纠错核心入口
   */
  public async correct(rawKeyword: string, userId: string = 'default_user'): Promise<CorrectionResult> {
    const cleaned = this.cleanQuery(rawKeyword);
    if (!cleaned) {
      return {
        originalKeyword: rawKeyword,
        correctedKeyword: rawKeyword,
        standardTitle: rawKeyword,
        candidateKeywords: [rawKeyword],
        isCorrected: false,
      };
    }

    // 1. 检查缓存
    const cacheKey = cleaned.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.result;
    }

    // 2. 本地快速规则匹配（0 毫秒，命中率高）
    for (const rule of AiCorrector.LOCAL_ALIAS_RULES) {
      if (rule.pattern.test(cleaned)) {
        const result: CorrectionResult = {
          originalKeyword: rawKeyword,
          correctedKeyword: rule.searchKeyword,
          standardTitle: rule.standardTitle,
          candidateKeywords: rule.candidateKeywords,
          isCorrected: true,
          explanation: rule.explanation,
        };
        this.setCachedResult(cacheKey, result);
        return result;
      }
    }

    // 3. 判断是否需要大模型纠错：
    // 若含有常见演员外号/角色/剧情线索或长度较长带有口语描述，才调用大模型；常规短片名直接直搜，避免额外延迟与额度消耗
    const hasColloquialClues =
      /(?:荷兰弟|小李子|甜茶|阿汤哥|星爷|发哥|大表姐|抖森|拔叔|锤哥|美队|桃总|寡姐|一美|法鲨|演的|主演|主角|男主|女主|讲的是|记不清|忘了叫|叫什么|哪部|什么电影|什么剧|那个|错别字|电视剧|电影|里有个|里面有)/i.test(
        cleaned
      );
    const looksLikePlotOrLongDesc = cleaned.length > 12 || /[，,。！？?!、\s]/.test(cleaned);

    const { client, model, hasValidKey } = LlmClientFactory.getClientForUser(userId, 7000);
    if (!hasValidKey || (!hasColloquialClues && !looksLikePlotOrLongDesc)) {
      const fallback: CorrectionResult = {
        originalKeyword: rawKeyword,
        correctedKeyword: cleaned,
        standardTitle: cleaned,
        candidateKeywords: [cleaned],
        isCorrected: false,
      };
      this.setCachedResult(cacheKey, fallback);
      return fallback;
    }

    try {
      const systemPrompt = `你是一个精通古今中外全部电影、电视剧、动漫、综艺的「剧情细节识片与实体推理专家」。
用户输入的搜索词可能是：
1. **具体的影视剧情细节 / 名场面 / 结局反转 / 人物设定 / 经典台词**（例如：“男女主在公交车上遇到高压锅炸弹一直时间循环的剧” -> 《开端》、“一家四口穷人挨个混进富豪别墅打工寄生的韩国电影” -> 《寄生虫》、“印度少年和一只孟加拉虎在海上漂流” -> 《少年派的奇幻漂流》、“卖鱼小贩高启强一步步黑化当老大的剧” -> 《狂飙》）
2. **演员俗称 / 外号 / 导演代称**（例如：荷兰弟、小李子、甜茶、阿汤哥、星爷、诺兰拍的太空穿越电影 -> 《星际穿越》）
3. **错别字 / 同音字 / 缩写简称**（例如：真环传 -> 《甄嬛传》、球2 -> 《流浪地球2》、妇联4 -> 《复仇者联盟4》）

任务要求：
1. 深度推理用户描述的剧情细节或线索對應哪一部影视作品；
2. 给出最匹配的【官方标准中文片名】（standardTitle，不带书名号，如 "开端"、"少年派的奇幻漂流"）；
3. 提取最适合在网盘资源库检索的【核心检索词】（searchKeyword，尽量精炼准确）；
4. 提供 2~3 个备选检索词或高度吻合该剧情的候选片名（candidateKeywords）；
5. 判断是否为通过剧情细节/线索推理出的片名（isPlotInferred: true/false）；
6. 给出自然简短的识别说明（explanation，35字以内，如“根据公交车爆炸时间循环的剧情细节，为您定位到白敬亭、赵今麦主演的《开端》”）；
7. 如果输入本身已经是标准短片名且无需推理纠错，isCorrected 设为 false。

请输出严格合法的 JSON 对象：
{
  "isCorrected": true,
  "isPlotInferred": true,
  "standardTitle": "开端",
  "searchKeyword": "开端",
  "candidateKeywords": ["开端"],
  "explanation": "根据公交车爆炸时间循环的剧情细节，为您定位到白敬亭、赵今麦主演的《开端》"
}`;

      const userContent = `用户输入描述或搜索词: "${cleaned}"`;

      const responsePromise = client.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      // 7 秒超时保障复杂剧情推理
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI识片超时')), 7000)
      );

      const completion = await Promise.race([responsePromise, timeoutPromise]);
      let rawJson = completion.choices[0]?.message?.content?.trim() || '';

      rawJson = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const parsed = JSON.parse(rawJson);

      const result: CorrectionResult = {
        originalKeyword: rawKeyword,
        correctedKeyword: parsed.searchKeyword || parsed.standardTitle || cleaned,
        standardTitle: parsed.standardTitle || parsed.searchKeyword || cleaned,
        candidateKeywords:
          Array.isArray(parsed.candidateKeywords) && parsed.candidateKeywords.length > 0
            ? parsed.candidateKeywords
            : [parsed.searchKeyword || parsed.standardTitle || cleaned],
        isCorrected: Boolean(parsed.isCorrected),
        isPlotInferred: Boolean(parsed.isPlotInferred),
        explanation: parsed.explanation,
      };

      this.setCachedResult(cacheKey, result);
      return result;
    } catch (err: any) {
      // 容错降级：如果识别失败，回退到原始已清理词
      const fallback: CorrectionResult = {
        originalKeyword: rawKeyword,
        correctedKeyword: cleaned,
        standardTitle: cleaned,
        candidateKeywords: [cleaned],
        isCorrected: false,
      };
      return fallback;
    }
  }
}
