import { QualityTags } from '../types';

export interface QualityPreferenceSpec {
  targetResolution?: '4K' | '1080P' | '原盘' | 'any';
  preferDolby?: boolean;
  preferHdr?: boolean;
  preferSmallSize?: boolean;
  preferHighBitrate?: boolean;
  preferSubtitle?: boolean;
  preferMandarinCantonese?: boolean;
}

/**
 * 画质、编码、音轨、字幕与体积标签结构化提取器
 */
export class QualityTagger {
  static extractTags(title: string, rawText: string = ''): QualityTags {
    const text = `${title || ''} ${rawText || ''}`;
    const badges: string[] = [];
    let bonus = 0;

    let resolution: QualityTags['resolution'];
    if (/(?:4k|2160p|uhd|超清4k)/i.test(text)) {
      resolution = '4K';
      badges.push('4K');
      bonus += 25;
    } else if (/1080[pi]/i.test(text)) {
      resolution = '1080P';
      badges.push('1080P');
      bonus += 12;
    } else if (/720p/i.test(text)) {
      resolution = '720P';
      badges.push('720P');
      bonus += 4;
    }

    let hdr: QualityTags['hdr'];
    let dolbyVision = false;
    if (/(?:杜比视界|dolby[\s._-]*vision|\bdovi\b|\bdv\b)/i.test(text)) {
      hdr = '杜比视界';
      dolbyVision = true;
      badges.push('杜比视界');
      bonus += 20;
    } else if (/(?:hdr10\+?|hdr)/i.test(text)) {
      hdr = 'HDR';
      badges.push('HDR');
      bonus += 12;
    }

    let codec: QualityTags['codec'];
    if (/(?:remux|蓝光原盘|原盘|bdmv|iso\b)/i.test(text)) {
      codec = '原盘/REMUX';
      badges.push('原盘');
      bonus += 18;
    } else if (/(?:高码率|高码|hq\b|60帧|60fps)/i.test(text)) {
      codec = '高码率';
      badges.push('高码率');
      bonus += 10;
    } else if (/(?:hevc|h\.?265|x265)/i.test(text)) {
      codec = 'HEVC';
    }

    let audio: string | undefined;
    let audioLanguage: QualityTags['audioLanguage'];
    if (/(?:国粤双语|国粤|双语配音)/i.test(text)) {
      audio = '国粤双语';
      audioLanguage = '国粤双语';
      badges.push('国粤双语');
      bonus += 8;
    } else if (/(?:国语配音|国配|台配|中配|国英双语)/i.test(text)) {
      audio = '国语配音';
      audioLanguage = '国语配音';
      badges.push('国语');
      bonus += 6;
    } else if (/(?:全景声|atmos|truehd|dts-hd)/i.test(text)) {
      audio = '全景声';
      badges.push('全景声');
      bonus += 8;
    }

    let subtitle: string | undefined;
    if (/(?:特效字幕|特效中字|双语特效)/i.test(text)) {
      subtitle = '特效中字';
      badges.push('特效中字');
      bonus += 8;
    } else if (/(?:内嵌中字|简繁中字|中英双字|中文字幕|官方中字|外挂字幕|中字)/i.test(text)) {
      subtitle = '中字';
      badges.push('中字');
      bonus += 5;
    }

    const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(GB|TB|MB|G\b)/i);
    let sizeHint: string | undefined;
    if (sizeMatch) {
      const unit = sizeMatch[2].toUpperCase() === 'G' ? 'GB' : sizeMatch[2].toUpperCase();
      sizeHint = `${sizeMatch[1]}${unit}`;
      badges.push(sizeHint);
    }

    const isSubtitleOnly =
      /(?:\.srt|\.ass|\.sub|\.ssa|外挂字幕|纯字幕|字幕包|字幕合集)/i.test(text) &&
      !/(?:2160p|1080p|remux|蓝光原盘)/i.test(title);

    return {
      resolution,
      hdr,
      dolbyVision,
      codec,
      audio,
      audioLanguage,
      subtitle,
      sizeHint,
      isSubtitleOnly,
      badges: Array.from(new Set(badges)).slice(0, 4),
      qualityScoreBonus: bonus,
    };
  }

  /**
   * 从自然语言需求中解析画质/版本偏好（如“4K杜比”“只要体积小的1080P”）
   */
  static parsePreferenceSpec(queryOrPref?: string): QualityPreferenceSpec {
    const raw = (queryOrPref || '').trim();
    const spec: QualityPreferenceSpec = {};
    if (!raw || raw.toLowerCase() === 'any') return spec;

    if (/(?:4k|2160p|uhd)/i.test(raw)) spec.targetResolution = '4K';
    else if (/(?:原盘|remux|蓝光)/i.test(raw)) spec.targetResolution = '原盘';
    else if (/1080/i.test(raw)) spec.targetResolution = '1080P';

    if (/(?:杜比|dolby)/i.test(raw)) spec.preferDolby = true;
    if (/hdr/i.test(raw)) spec.preferHdr = true;
    if (/(?:体积小|小体积|省流|压缩|轻量)/i.test(raw)) spec.preferSmallSize = true;
    if (/(?:高码|60帧|高帧率|无损)/i.test(raw)) spec.preferHighBitrate = true;
    if (/(?:中字|字幕|特效)/i.test(raw)) spec.preferSubtitle = true;
    if (/(?:国语|国粤|配音|双语)/i.test(raw)) spec.preferMandarinCantonese = true;

    return spec;
  }

  /**
   * 计算用户偏好对某条资源标签的加减分
   */
  static scoreByPreference(tags: QualityTags, prefInput?: string): number {
    if (!prefInput || prefInput === 'any') return 0;
    const spec = this.parsePreferenceSpec(prefInput);
    let score = 0;

    if (spec.targetResolution === '4K' && tags.resolution === '4K') score += 90;
    if (spec.targetResolution === '原盘' && tags.codec === '原盘/REMUX') score += 95;
    if (spec.targetResolution === '1080P' && tags.resolution === '1080P') score += 90;

    if (spec.preferDolby && (tags.dolbyVision || tags.hdr === '杜比视界')) score += 60;
    if (spec.preferHdr && tags.hdr) score += 45;
    if (spec.preferHighBitrate && (tags.codec === '高码率' || tags.codec === '原盘/REMUX')) score += 50;
    if (spec.preferSubtitle && tags.subtitle) score += 45;
    if (spec.preferMandarinCantonese && tags.audioLanguage) score += 45;

    if (spec.preferSmallSize && tags.sizeHint) {
      const m = tags.sizeHint.match(/^(\d+(?:\.\d+)?)(GB|MB|TB)$/i);
      if (m) {
        const val = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        const gb = unit === 'TB' ? val * 1024 : unit === 'MB' ? val / 1024 : val;
        if (gb > 0 && gb <= 4) score += 55;
        else if (gb > 20) score -= 35;
      }
    }

    return score;
  }
}
