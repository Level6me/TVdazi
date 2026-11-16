import { LlmClientFactory } from './LlmClientFactory';

const lastVariantByKey = new Map<string, number>();

/**
 * 从多个自然表达变体中轮换挑选，避免每次都回复一模一样的话
 */
export function pickVariant(variants: string[], avoidKey?: string): string {
  if (!variants || variants.length === 0) return '';
  if (variants.length === 1) return variants[0];

  const key = avoidKey || '__default__';
  const prevIdx = lastVariantByKey.get(key);
  let idx = Math.floor(Math.random() * variants.length);
  if (prevIdx !== undefined && idx === prevIdx) {
    idx = (idx + 1 + Math.floor(Math.random() * (variants.length - 1))) % variants.length;
  }
  lastVariantByKey.set(key, idx);
  return variants[idx];
}

/**
 * 结合用户原话与工具执行事实，用“真人微信好友”语气自然润色回复；
 * 测试环境、无 Key 或超时自动毫秒级回退到多变体自然文案
 */
export async function humanizeWithLlm(
  userId: string | undefined,
  opts: {
    userInput?: string;
    actionDesc: string;
    rawResult: string;
    preserveExact?: string[];
    timeoutMs?: number;
  }
): Promise<string> {
  if (process.env.NODE_TEST_CONTEXT) {
    return opts.rawResult;
  }

  const { client, model, hasValidKey } = LlmClientFactory.getClientForUser(userId, opts.timeoutMs || 3200);
  if (!hasValidKey) {
    return opts.rawResult;
  }

  const mustKeep = (opts.preserveExact || []).map((s) => String(s || '').trim()).filter(Boolean);

  try {
    const promptLines = [
      '你是微信里一个特别熟、性格爽朗幽默又热心的朋友「电视搭子」。',
      '请把下面后台刚办好的事，用真人随手打微信的口吻跟对方说出来。',
      '要求：',
      '1. 像真人一样自然接地气，绝不能出现“全局唯一昵称 / 计划任务 / 算法分析 / 通道异常 / 置信度 / 小提示 / 玩法提示 / 系统”等机器或客服腔词；',
      '2. 禁止出现任何 `----` / `────` 分割线，不要用僵硬的条目模板；',
      '3. 每次换点新说法，别老用同一个句式，简短利落（1~3句），可以偶尔带一点日常语气词但别油腻；',
      '4. 下面【必须原样保留】的信息一个字都别改、别漏。',
      '',
      `【刚办的事】：${opts.actionDesc}`,
      opts.userInput ? `【对方刚发的原话】：${opts.userInput}` : '',
      `【结果详情】：${opts.rawResult}`,
      mustKeep.length > 0 ? `【必须原样保留的关键词/原话】：${mustKeep.map((k) => `[${k}]`).join('、')}` : '',
      '',
      '请直接输出最终发给微信的聊天消息文本（不要加引号或多余说明）：',
    ]
      .filter(Boolean)
      .join('\n');

    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: promptLines }],
      temperature: 0.85,
      max_tokens: 260,
    });

    const polished = (completion.choices?.[0]?.message?.content || '')
      .trim()
      .replace(/^["'「]|["'」]$/g, '')
      .trim();

    if (!polished) {
      return opts.rawResult;
    }

    // 校验关键事实一个都不许丢
    for (const token of mustKeep) {
      if (!polished.includes(token)) {
        return opts.rawResult;
      }
    }

    return polished;
  } catch {
    return opts.rawResult;
  }
}
