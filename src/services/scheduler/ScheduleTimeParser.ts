export interface ParsedScheduleTime {
  timeStr: string;
  daysOfWeek?: number[];
  oneShotDate?: string;
  isRelative?: boolean;
  triggerAt?: number;
  invalid?: boolean;
}

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 定时任务时间与片名自然语言解析引擎（从 SchedulerService 解耦，支持独立单元测试）
 */
export class ScheduleTimeParser {
  static parseChineseNumber(s: string, fallback: number = Number.NaN): number {
    const raw = String(s || '').trim();
    if (/^\d+(?:\.\d+)?$/.test(raw)) return parseFloat(raw);
    if (raw === '半') return 0.5;
    const normalized = raw.replace(/廿/g, '二十').replace(/卅/g, '三十');
    if (!normalized || !/^[零〇一二两三四五六七八九十百千万]+$/.test(normalized)) return fallback;

    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of normalized) {
      if (char in CN_DIGITS) {
        number = CN_DIGITS[char];
      } else if (char === '十' || char === '百' || char === '千') {
        const unit = char === '十' ? 10 : char === '百' ? 100 : 1000;
        section += (number || (unit === 10 ? 1 : 0)) * unit;
        number = 0;
      } else if (char === '万') {
        section += number;
        total += (section || 1) * 10000;
        section = 0;
        number = 0;
      }
    }
    return total + section + number;
  }

  static getBeijingParts(timestampMs: number = Date.now()): {
    dateStr: string;
    timeStr: string;
    dayOfWeek: number;
    minuteKey: string;
    bjDate: Date;
  } {
    const now = new Date(timestampMs);
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const bjNow = new Date(utcMs + 8 * 3600000);

    const year = bjNow.getFullYear();
    const month = String(bjNow.getMonth() + 1).padStart(2, '0');
    const day = String(bjNow.getDate()).padStart(2, '0');
    const hours = String(bjNow.getHours()).padStart(2, '0');
    const minutes = String(bjNow.getMinutes()).padStart(2, '0');
    const dayOfWeek = bjNow.getDay();

    const dateStr = `${year}-${month}-${day}`;
    const timeStr = `${hours}:${minutes}`;
    return {
      dateStr,
      timeStr,
      dayOfWeek,
      minuteKey: `${dateStr} ${timeStr}`,
      bjDate: bjNow,
    };
  }

  /**
   * 从自然语言文本中解析时间（支持相对延时“两分钟后/半小时后”以及定点“早上8点/20:30/后天”）
   */
  static parseTimeFromText(text: string, nowMs: number = Date.now()): ParsedScheduleTime {
    const isPollingExpr = /(?:每|每隔|间隔|改成|改为|设为|设置成|调整为|调成)\s*(?:\d+(?:\.\d+)?|半|[零〇一二两三四五六七八九十百千万廿卅]+)\s*(?:分钟|分|个?\s*小时|钟头|min|h\b|m\b)/i.test(
      text
    );

    let offsetMs = 0;
    let invalidRelative = false;
    if (!isPollingExpr) {
      const relativeHalfHourMatch = text.match(
        /(?:等|过)?\s*半\s*个?\s*小时\s*(?:之?后|再|内|给|帮|替|提醒|叫|通知|转存|存|推|发|搜|查|看|$)/i
      );
      const relativeMinMatch = text.match(
        /(?:等|过)?\s*(\d+(?:\.\d+)?|半|[零〇一二两三四五六七八九十百千万廿卅]+)\s*(?:分钟|分(?!钟|辨|享|类|数|析|集|季|片|账)|min(?:utes?)?|m\b)\s*(?:之?后|再|内|给|帮|替|提醒|叫|通知|转存|存|推|发|搜|查|看|$)/i
      );
      const relativeHourMatch = text.match(
        /(?:等|过)?\s*(\d+(?:\.\d+)?|半|[零〇一二两三四五六七八九十百千万廿卅]+)\s*(?:个?\s*小时|钟头|hours?|h\b)\s*(?:之?后|再|内|给|帮|替|提醒|叫|通知|转存|存|推|发|搜|查|看|$)/i
      );
      const relativeSecMatch = text.match(
        /(?:等|过)?\s*(\d+(?:\.\d+)?|半|[零〇一二两三四五六七八九十百千万廿卅]+)\s*(?:秒钟?|sec(?:onds?)?|s\b)\s*(?:之?后|再|内|给|帮|替|提醒|叫|通知|转存|存|推|发|搜|查|看|$)/i
      );
      const hourAndHalfMatch = text.match(
        /(?:等|过)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万廿卅]+)\s*(?:个?\s*小时|钟头)\s*半\s*(?:之?后|再|内|给|帮|替|提醒|叫|通知|转存|存|推|发|搜|查|看|$)/i
      );

      if (/一个半\s*小时/.test(text)) {
        offsetMs = 90 * 60 * 1000;
      } else if (hourAndHalfMatch) {
        const val = this.parseChineseNumber(hourAndHalfMatch[1]);
        if (Number.isFinite(val) && val > 0) offsetMs = Math.round((val + 0.5) * 60 * 60 * 1000);
        else invalidRelative = true;
      } else if (relativeHalfHourMatch) {
        offsetMs = 30 * 60 * 1000;
      } else if (relativeMinMatch) {
        const val = this.parseChineseNumber(relativeMinMatch[1]);
        if (Number.isFinite(val) && val > 0) {
          offsetMs = Math.round(val * 60 * 1000);
        } else invalidRelative = true;
      } else if (relativeHourMatch) {
        const val = this.parseChineseNumber(relativeHourMatch[1]);
        if (Number.isFinite(val) && val > 0) {
          offsetMs = Math.round(val * 60 * 60 * 1000);
        } else invalidRelative = true;
      } else if (relativeSecMatch) {
        const val = this.parseChineseNumber(relativeSecMatch[1]);
        if (Number.isFinite(val) && val > 0) {
          offsetMs = Math.round(val * 1000);
        } else invalidRelative = true;
      }
    }

    if (invalidRelative) return { timeStr: '', invalid: true };

    if (offsetMs > 0) {
      const triggerAt = nowMs + offsetMs;
      const bj = this.getBeijingParts(triggerAt);
      return {
        timeStr: bj.timeStr,
        oneShotDate: bj.dateStr,
        isRelative: true,
        triggerAt,
      };
    }

    let hour = 8;
    let minute = 0;

    const colonMatch = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
    const pointMatch = text.match(
      /(早上|早晨|今早|明早|每早|上午|中午|下午|傍晚|晚上|今晚|明晚|每晚|夜里|今夜|凌晨)?\s*(\d{1,2}|[零〇一二两三四五六七八九十百千万廿卅]+)\s*(?:点|时)(?:(\d{1,2}|半|[零〇一二两三四五六七八九十百千万廿卅]+)\s*分?)?/
    );

    if (colonMatch) {
      hour = parseInt(colonMatch[1], 10);
      minute = parseInt(colonMatch[2], 10);
      if (hour > 23 || minute > 59) return { timeStr: '', invalid: true };
      const prefix = text.slice(0, colonMatch.index);
      const periods = Array.from(prefix.matchAll(/早上|早晨|今早|明早|每早|上午|中午|下午|傍晚|晚上|今晚|明晚|每晚|夜里|今夜|凌晨/g));
      const period = periods.length > 0 ? periods[periods.length - 1][0] : '';
      if (/(?:下午|傍晚|晚上|今晚|明晚|每晚|夜里|今夜)/.test(period) && hour < 12) {
        hour += 12;
      } else if (period === '中午' && hour < 11) {
        hour += 12;
      } else if (period === '凌晨' && hour === 12) {
        hour = 0;
      }
    } else if (pointMatch) {
      const period = pointMatch[1] || '';
      hour = this.parseChineseNumber(pointMatch[2]);
      if (pointMatch[3]) {
        minute = pointMatch[3] === '半' ? 30 : this.parseChineseNumber(pointMatch[3]);
      }
      if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) {
        return { timeStr: '', invalid: true };
      }
      if (/(?:下午|傍晚|晚上|今晚|明晚|每晚|夜里|今夜)/.test(period) && hour < 12) {
        hour += 12;
      } else if (period === '中午' && hour < 11) {
        hour += 12;
      } else if (period === '凌晨' && hour === 12) {
        hour = 0;
      }
    } else if (/早上|早晨|明早|今早/.test(text)) {
      hour = 8;
    } else if (/中午/.test(text)) {
      hour = 12;
    } else if (/下午/.test(text)) {
      hour = 15;
    } else if (/晚上|今晚|明晚|每晚/.test(text)) {
      hour = 20;
    }

    hour = Math.max(0, Math.min(23, hour));
    minute = Math.max(0, Math.min(59, minute));
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    let daysOfWeek: number[] | undefined;
    if (/周末|周六周日/.test(text)) {
      daysOfWeek = [6, 0];
    } else if (/工作日|周一到周五/.test(text)) {
      daysOfWeek = [1, 2, 3, 4, 5];
    } else {
      const dayMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
      const weekMatches = text.match(/周([一二三四五六日天])/g);
      if (weekMatches && weekMatches.length > 0) {
        daysOfWeek = weekMatches.map((w) => dayMap[w.replace('周', '')]).filter((n) => n !== undefined);
      }
    }

    let oneShotDate: string | undefined;
    if (!/每天|每日|每晚|每早|每周/.test(text) && /(?:后天|明天|明早|明晚|今天|今早|今晚)/.test(text)) {
      const bj = this.getBeijingParts(nowMs).bjDate;
      if (/后天/.test(text)) {
        bj.setDate(bj.getDate() + 2);
      } else if (/明天|明早|明晚/.test(text)) {
        bj.setDate(bj.getDate() + 1);
      }
      const y = bj.getFullYear();
      const m = String(bj.getMonth() + 1).padStart(2, '0');
      const d = String(bj.getDate()).padStart(2, '0');
      oneShotDate = `${y}-${m}-${d}`;
    }

    return { timeStr, daysOfWeek, oneShotDate };
  }

  /**
   * 提取自然语言中的目标片名
   */
  static extractCleanMovieTitle(text: string): string {
    const bookMatch = text.match(/《([^》]+)》/);
    if (bookMatch && bookMatch[1]) {
      return bookMatch[1].trim();
    }

    const durationExpr =
      '(?:半\\s*个?\\s*(?:小时|钟头)|(?:\\d+(?:\\.\\d+)?|[一二两三四五六七八九十]{1,3})\\s*(?:个?半\\s*(?:小时|钟头)|个?\\s*小时|钟头|分钟?|秒钟?|sec|s\\b|min|m\\b|h\\b))';
    const transferOnlyRe = new RegExp(
      `^(?:过|等|在)?\\s*(?:${durationExpr})?\\s*(?:之?[后内]|以后|再)?\\s*(?:把?(?:这部|这个|它|片子|电影|剧集))?\\s*(?:自动)?(?:转存|存一下|存下|帮我存|自动存|存入|保存到)(?:(?:到|进|至)?(?:夸克)?网盘)?$`,
      'i'
    );
    if (transferOnlyRe.test(text.trim())) {
      return '';
    }

    return text
      .replace(new RegExp(`(?:过|等|在)?\\s*${durationExpr}\\s*(?:之?[后内]|以后|再)?`, 'gi'), '')
      .replace(
        /(?:每|每隔|间隔)\s*(?:半\s*个?\s*(?:小时|钟头)|(?:\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(?:个?\s*小时|钟头|分钟?|秒钟?|sec|s\b|min|m\b|h\b))\s*(?:一次|一轮|一扫|巡检|扫描|检测|轮询)?/gi,
        ''
      )
      .replace(/^(?:请|帮我|给我|麻烦|我想|我要|自动|全网)*/g, '')
      .replace(
        /(?:蹲守|蹲一下|蹲一个|蹲|追更|订阅更新|监控|扫描|巡检|检测|看看|查查|转存|存到网盘|存进网盘|存入网盘|保存到网盘|存一下|存下|帮我搜|搜一下|搜索)/g,
        ''
      )
      .replace(/(?:如果|要是|等|当)?(.+?)(?:有4K资源了|出4K资源了|出4K了|有4K了|有资源了|出资源了|更新了|出了).*$/i, '$1')
      .replace(/(?:推送消息给我|推送给我|通知我|告诉我|发给我|自动帮我存.*|帮我存.*|存进网盘.*|到夸克网盘|到网盘)$/g, '')
      .replace(/^[，,。！!？?\s]+|[，,。！!？?\s]+$/g, '')
      .trim();
  }
}
