import * as path from 'path';
import { QualityTagger } from './QualityTagger';

export interface QuarkFileNode {
  fid: string;
  file_name: string;
  dir: boolean;
  size?: number;
  pdir_fid?: string;
}

export interface DuplicateGroup {
  normalizedKey: string;
  keep: QuarkFileNode;
  duplicates: QuarkFileNode[];
  reclaimableBytes: number;
}

/**
 * 夸克网盘空间治理与 Emby / Infuse / VidHub 标准媒体库命名工具
 */
export class QuarkOrganizer {
  private static readonly VIDEO_EXT_RE = /\.(mkv|mp4|avi|mov|ts|m2ts|flv|wmv|iso|rmvb)$/i;

  static isVideoFile(fileName: string): boolean {
    return this.VIDEO_EXT_RE.test(fileName);
  }

  /**
   * 从文件名中提取剧集季号与集号（兼容 S01E05 / E05 / EP05 / 第05集）
   */
  static extractSeasonEpisode(fileName: string): { season: number; episode: number } | null {
    const seMatch = fileName.match(/S(\d{1,2})\s*[.\-_ ]?\s*E(?:P)?(\d{1,3})/i);
    if (seMatch) {
      return {
        season: parseInt(seMatch[1], 10),
        episode: parseInt(seMatch[2], 10),
      };
    }
    const cnMatch = fileName.match(/第\s*(\d{1,3})\s*[集话期]/);
    if (cnMatch) {
      return { season: 1, episode: parseInt(cnMatch[1], 10) };
    }
    const epMatch = fileName.match(/(?:^|[\s.\-_\[])E(?:P)?(\d{1,3})(?:[\s.\-_\]]|$)/i);
    if (epMatch) {
      return { season: 1, episode: parseInt(epMatch[1], 10) };
    }
    return null;
  }

  /**
   * 清洗出用于识别重复文件/标准化的核心片名 Key
   */
  static normalizeMediaKey(fileName: string): string {
    const ext = path.extname(fileName);
    const stem = ext ? fileName.slice(0, -ext.length) : fileName;
    const se = this.extractSeasonEpisode(stem);

    const cleanedTitle = stem
      .replace(/\[[^\]]*\]|【[^】]*】/g, ' ')
      .replace(/(?:2160p|4k|1080p|720p|uhd|hdr|hdr10\+?|dolby[\s._-]*vision|\bdv\b|remux|bluray|web-dl|webrip|x264|x265|h264|h265|hevc|aac|dts|atmos|60fps|国语|粤语|中字|简繁|双语|特效字幕)/gi, ' ')
      .replace(/S\d{1,2}\s*[.\-_ ]?\s*E(?:P)?\d{1,3}/gi, ' ')
      .replace(/第\s*\d{1,3}\s*[集话期]/g, ' ')
      .replace(/[《》()（）._\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (se) {
      return `${cleanedTitle}#s${String(se.season).padStart(2, '0')}e${String(se.episode).padStart(2, '0')}`;
    }
    return cleanedTitle;
  }

  /**
   * 生成符合 Emby / Infuse / VidHub 刮削规范的文件名或剧集名
   */
  static formatEmbyMediaName(
    fileName: string,
    standardTitle: string,
    year?: string
  ): string {
    const cleanTitle = (standardTitle || '').replace(/[《》<>:"/\\|?*]/g, '').trim();
    if (!cleanTitle) return fileName;

    const ext = path.extname(fileName);
    const yearSuffix = year && /^\d{4}$/.test(year) ? ` (${year})` : '';
    const se = this.extractSeasonEpisode(fileName);

    if (se) {
      const s = String(se.season).padStart(2, '0');
      const e = String(se.episode).padStart(2, '0');
      return `${cleanTitle}${yearSuffix} - S${s}E${e}${ext}`;
    }

    if (ext && this.isVideoFile(fileName)) {
      return `${cleanTitle}${yearSuffix}${ext}`;
    }

    return `${cleanTitle}${yearSuffix}`;
  }

  /**
   * 计算文件画质保留优先级（用于在重复资源中自动保留最高画质版本）
   */
  static scoreQualityPriority(file: QuarkFileNode): number {
    const tags = QualityTagger.extractTags(file.file_name);
    let score = tags.qualityScoreBonus * 10;
    if (file.size && Number.isFinite(file.size)) {
      score += Math.min(50, Math.round(file.size / (1024 * 1024 * 1024)));
    }
    return score;
  }

  /**
   * 识别同一目录下的重复资源组（同名不同清晰度或重复转存副本）
   */
  static findDuplicateGroups(files: QuarkFileNode[]): DuplicateGroup[] {
    const groups = new Map<string, QuarkFileNode[]>();

    for (const f of files) {
      if (f.dir) continue;
      if (!this.isVideoFile(f.file_name) && (f.size || 0) < 100 * 1024 * 1024) {
        continue;
      }
      const key = this.normalizeMediaKey(f.file_name);
      if (!key || key.length < 2) continue;
      const arr = groups.get(key) || [];
      arr.push(f);
      groups.set(key, arr);
    }

    const result: DuplicateGroup[] = [];
    for (const [normalizedKey, list] of groups.entries()) {
      if (list.length <= 1) continue;
      const sorted = [...list].sort((a, b) => this.scoreQualityPriority(b) - this.scoreQualityPriority(a));
      const keep = sorted[0];
      const duplicates = sorted.slice(1);
      const reclaimableBytes = duplicates.reduce((acc, d) => acc + (d.size || 0), 0);
      result.push({ normalizedKey, keep, duplicates, reclaimableBytes });
    }

    return result;
  }

  static formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
