import OpenAI from 'openai';
import { UserManager } from './UserManager';

export interface AntiCensorResult {
  isHarmonized: boolean;
  restoredName: string;
  standardTitle?: string;
  reason?: string;
}

export class AntiCensorService {
  private static instance: AntiCensorService;
  private globalClient: OpenAI;
  private userManager: UserManager;
  private globalApiKey: string;
  private globalBaseURL: string;
  private model: string;
  private cache: Map<string, { result: AntiCensorResult; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24小时内存缓存

  // 常见火星文与防和谐替代字字典（0 延迟离线快速映射）
  private static readonly MARS_CHAR_MAP: Record<string, string> = {
    '妗': '今',
    '兲': '天',
    '湜': '是',
    '忲': '太',
    '陽': '阳',
    '涐': '我',
    '啝': '和',
    '伱': '你',
    '莪': '我',
    '硪': '我',
    '噯': '爱',
    '戀': '恋',
    '莣': '忘',
    '煷': '亮',
    '畱': '留',
    '泩': '生',
    '圊': '青',
    '舂': '春',
    '莈': '没',
    '洧': '有',
    '芣': '不',
    '説': '说',
    '話': '话',
    '苩': '白',
    '液': '夜',
    '岥': '破',
    '茪': '光',
    '朙': '明',
    '點': '点',
    '媄': '美',
    '囸': '日',
    '仴': '月',
    '萷': '消',
    '妷': '失',
    '縋': '追',
    '嶶': '微',
    '潙': '为',
    '渼': '美',
    '俬': '私',
    '慶': '庆',
    '餘': '余',
    '魚': '余',
  };

  private constructor() {
    this.userManager = UserManager.getInstance();
    this.globalApiKey = process.env.DEEPSEEK_API_KEY || '';
    this.globalBaseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    this.globalClient = new OpenAI({
      apiKey: this.globalApiKey || 'dummy_key',
      baseURL: this.globalBaseURL,
      timeout: 4500,
    });
  }

  public static getInstance(): AntiCensorService {
    if (!AntiCensorService.instance) {
      AntiCensorService.instance = new AntiCensorService();
    }
    return AntiCensorService.instance;
  }

  /**
   * 检查文件名是否包含防和谐特征（火星文、字母前缀、防封标记、拆字等）
   */
  public hasHarmonizedFeatures(fileName: string): boolean {
    if (!fileName || typeof fileName !== 'string') return false;

    // 1. 防和谐关键词标签
    if (/【\s*(?:防和谐|防封|防失效|防屏蔽|防删|和谐)\s*】|\[\s*(?:防和谐|防封|防失效|防屏蔽|防删|和谐)\s*\]/i.test(fileName)) {
      return true;
    }

    // 2. 单字母前缀（如 "J 妗兲湜忲陽雨"、"Q 庆余年"）
    if (/^[A-Za-z][\s_\-\.][\u4e00-\u9fa5A-Za-z0-9]/i.test(fileName.trim())) {
      return true;
    }

    // 3. 拼音首字母拆分缩写（如 J.T.S.T.Y.Y）
    if (/^[A-Za-z](?:\.[A-Za-z]){2,}/i.test(fileName.trim())) {
      return true;
    }

    // 4. 拆字加点（如 今.天.是.太.阳.雨）
    if (/[\u4e00-\u9fa5]\.[\u4e00-\u9fa5]\.[\u4e00-\u9fa5]/.test(fileName)) {
      return true;
    }

    // 5. 命中已知火星文字符
    for (const char of Object.keys(AntiCensorService.MARS_CHAR_MAP)) {
      if (fileName.includes(char)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 本地规则快速清洗火星文与防和谐格式
   */
  public cleanWithLocalRules(fileName: string, standardTitle?: string): { isHarmonized: boolean; restoredName: string } {
    let cleaned = fileName.trim();
    let changed = false;

    // 1. 去除防和谐标签
    const tagRegex = /【\s*(?:防和谐|防封|防失效|防屏蔽|防删|和谐)\s*】|\[\s*(?:防和谐|防封|防失效|防屏蔽|防删|和谐)\s*\]/gi;
    if (tagRegex.test(cleaned)) {
      cleaned = cleaned.replace(tagRegex, '').trim();
      changed = true;
    }

    // 2. 去除单字母前缀 (如 "J 妗兲湜忲陽雨" -> "妗兲湜忲陽雨")
    const letterPrefixRegex = /^[A-Za-z][\s_\-\.]([\u4e00-\u9fa5])/;
    if (letterPrefixRegex.test(cleaned)) {
      cleaned = cleaned.replace(letterPrefixRegex, '$1').trim();
      changed = true;
    }

    // 3. 火星文字符逐字替换
    let marsReplaced = '';
    for (const char of cleaned) {
      if (AntiCensorService.MARS_CHAR_MAP[char]) {
        marsReplaced += AntiCensorService.MARS_CHAR_MAP[char];
        changed = true;
      } else {
        marsReplaced += char;
      }
    }
    cleaned = marsReplaced;

    // 4. 去除多余的点号分隔（如 今.天.是.太.阳.雨 -> 今天是太阳雨）
    if (/[\u4e00-\u9fa5]\.[\u4e00-\u9fa5]/.test(cleaned)) {
      cleaned = cleaned.replace(/([\u4e00-\u9fa5])\.([\u4e00-\u9fa5])/g, '$1$2');
      changed = true;
    }

    // 5. 如果提供了标准片名（如搜索上下文中的剧名《今天是太阳雨》），进一步智能对齐
    if (standardTitle && standardTitle.trim()) {
      const std = standardTitle.trim();
      // 如果清洗后的名称包含了标准片名的主要字或拼音前缀匹配
      if (cleaned.includes(std)) {
        // 已经完全包含标准片名
      } else {
        // 提取原名中的集数/画质/后缀等附加信息
        const extraMatch = cleaned.match(/(\s*\[(?:更新至|全|第)?[^\]]+\]|\s*(?:4K|1080P|720P|REMUX|S\d+E\d+|第\d+集|\.\w+$).*)/i);
        const extra = extraMatch ? extraMatch[0] : '';
        // 提取主干比较
        const mainPart = cleaned.replace(extra, '').trim();
        let matchCount = 0;
        for (const char of std) {
          if (mainPart.includes(char)) matchCount++;
        }
        if (matchCount >= Math.min(2, std.length)) {
          cleaned = `${std}${extra ? (extra.startsWith(' ') || extra.startsWith('.') ? extra : ' ' + extra) : ''}`.trim();
          changed = true;
        }
      }
    }

    return {
      isHarmonized: changed,
      restoredName: changed ? cleaned : fileName,
    };
  }

  /**
   * 综合分析并还原防和谐混淆资源名称
   * @param rawFileName 原始文件名或目录名（如 "J 妗兲湜忲陽雨 [更新至16集]"）
   * @param standardTitle 搜索上下文的标准片名（如 "今天是太阳雨"，可选）
   * @param userId 发起用户的微信 ID（用于获取独立 API Key，可选）
   */
  public async restoreTitle(
    rawFileName: string,
    standardTitle?: string,
    userId?: string
  ): Promise<AntiCensorResult> {
    if (!rawFileName || typeof rawFileName !== 'string') {
      return { isHarmonized: false, restoredName: rawFileName };
    }

    const trimmed = rawFileName.trim();

    // 检查缓存
    const cacheKey = `${trimmed}___${standardTitle || ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.result;
    }

    // 检查是否具备混淆特征
    const hasFeatures = this.hasHarmonizedFeatures(trimmed);
    const localRuleRes = this.cleanWithLocalRules(trimmed, standardTitle);

    // 如果未检测到混淆特征且无标准片名比对，且本地规则没有变动，直接返回原名（0 延迟）
    if (!hasFeatures && !standardTitle && !localRuleRes.isHarmonized) {
      const normalResult: AntiCensorResult = {
        isHarmonized: false,
        restoredName: trimmed,
        standardTitle: trimmed,
        reason: '正常标准文件名，未检测到防版权混淆特征',
      };
      this.cache.set(cacheKey, { result: normalResult, timestamp: Date.now() });
      return normalResult;
    }

    // 尝试使用 DeepSeek AI 进行高精度语义与拼音/谐音还原
    try {
      const userPlan = userId ? this.userManager.getUserPlan(userId) : null;
      const apiKey = userPlan?.deepseekApiKey || this.globalApiKey;
      const client =
        apiKey && apiKey !== this.globalApiKey
          ? new OpenAI({ apiKey, baseURL: this.globalBaseURL, timeout: 4000 })
          : this.globalClient;

      const systemPrompt = `你是一个专业的网盘资源防版权混淆与火星文名称还原专家。
网盘资源分享者为了防止被版权自动检测删除，经常使用火星文、谐音同音字、拼音首字母前缀、拆字加点、生僻字来篡改影视剧名（例如把《今天是太阳雨》改成 "J 妗兲湜忲陽雨"、把《庆余年》改成 "Q 慶餘年"、把《甄嬛传》改成 "真环传"、把《白夜破晓》改成 "B 苩液岥晓"）。

请分析输入的文件名：
1. 判断是否属于防版权/防和谐混淆改名。
2. 若是混淆名称，请将其还原为真实规范的影视原名（简体中文），同时必须完整保留版本信息、集数信息（如 [更新至16集]、4K、1080P、S01E01、第01-20集等）以及文件后缀（如 .mp4, .mkv 等）。
3. 若本身已经是规范正常的名称，则 isHarmonized 为 false，restoredName 与原名完全一致。
${standardTitle ? `4. 用户当前正在寻找的官方标准片名为：《${standardTitle}》，请优先参考此标准剧名进行还原。` : ''}

请务必只输出严格的 JSON 格式：
{
  "isHarmonized": true,
  "restoredName": "规范还原后的文件名",
  "standardTitle": "规范剧名",
  "reason": "简要说明还原依据"
}`;

      const completion = await client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `待分析文件名: "${trimmed}"` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const rawContent = completion.choices[0]?.message?.content?.trim();
      if (rawContent) {
        const parsed = JSON.parse(rawContent) as AntiCensorResult;
        if (parsed.restoredName) {
          const finalResult: AntiCensorResult = {
            isHarmonized: Boolean(parsed.isHarmonized && parsed.restoredName !== trimmed),
            restoredName: parsed.restoredName.trim(),
            standardTitle: parsed.standardTitle || standardTitle,
            reason: parsed.reason,
          };
          this.cache.set(cacheKey, { result: finalResult, timestamp: Date.now() });
          return finalResult;
        }
      }
    } catch (err: any) {
      console.warn(`[AntiCensorService] DeepSeek 分析超时或失败 (${err.message})，使用本地规则兜底`);
    }

    // AI 兜底：使用本地规则结果
    const fallbackResult: AntiCensorResult = {
      isHarmonized: localRuleRes.isHarmonized,
      restoredName: localRuleRes.restoredName,
      standardTitle: standardTitle || localRuleRes.restoredName,
      reason: localRuleRes.isHarmonized ? '本地规则识别并清洗火星文/防和谐标记' : '未检测到混淆',
    };
    this.cache.set(cacheKey, { result: fallbackResult, timestamp: Date.now() });
    return fallbackResult;
  }
}
