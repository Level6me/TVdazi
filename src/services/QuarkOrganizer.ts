import * as path from 'path';
import { QualityTagger } from './QualityTagger';

export interface QuarkFileNode {
  fid: string;
  file_name: string;
  dir: boolean;
  size?: number;
  pdir_fid?: string;
  updated_at?: number;
  path?: string;
}

export type QuarkFileCategory =
  | 'folder'
  | 'video'
  | 'archive'
  | 'fake_archive'
  | 'subtitle'
  | 'audio'
  | 'image'
  | 'document'
  | 'other';

export interface FakeArchiveDetection {
  isFake: boolean;
  restoredName: string;
  realExt: string;
  fakeExt: string;
}

export interface FileTypeSummary {
  totalFiles: number;
  folderCount: number;
  videoCount: number;
  archiveFiles: QuarkFileNode[];
  fakeArchiveFiles: Array<{ node: QuarkFileNode; restoredName: string; realExt: string; fakeExt: string }>;
  subtitleCount: number;
  audioCount: number;
  imageCount: number;
  documentCount: number;
  otherCount: number;
  extensions: string[];
  totalBytes: number;
  hasArchives: boolean;
  summaryLine: string;
}

export interface DuplicateGroup {
  normalizedKey: string;
  keep: QuarkFileNode;
  duplicates: QuarkFileNode[];
  reclaimableBytes: number;
}

/**
 * 夸克网盘空间治理、文件类型识别、压缩包检测与 Emby / Infuse / VidHub 标准媒体库命名工具
 */
export class QuarkOrganizer {
  private static readonly VIDEO_EXT_RE = /\.(mkv|mp4|avi|mov|ts|m2ts|flv|wmv|iso|rmvb|webm|m4v|mpg|mpeg)$/i;
  private static readonly ARCHIVE_EXT_RE =
    /(?:\.tar\.(?:gz|bz2|xz)|\.part\d+\.rar|\.(?:zip|rar|7z|tar|gz|tgz|bz2|xz|001|z01|r00|cab|arj))$/i;
  private static readonly FAKE_ARCHIVE_RE =
    /^(.+?\.(mkv|mp4|avi|mov|ts|m2ts|flv|wmv|rmvb|webm|m4v))\.(zip|rar|7z|tar|gz|pdf|bin|bak|txt|doc|docx|jpg|jpeg|png|apk|tmp|dat|删掉?|改名|去掉)$/i;
  private static readonly SUBTITLE_EXT_RE = /\.(srt|ass|ssa|sub|idx|vtt|sup)$/i;
  private static readonly AUDIO_EXT_RE = /\.(mp3|flac|wav|aac|m4a|ogg|ape|dsf|wma)$/i;
  private static readonly IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp|tiff|heic)$/i;
  private static readonly DOCUMENT_EXT_RE = /\.(pdf|txt|doc|docx|xls|xlsx|ppt|pptx|md|epub|mobi|nfo)$/i;

  static isVideoFile(fileName: string): boolean {
    return this.VIDEO_EXT_RE.test(fileName);
  }

  static detectFakeArchiveVideo(fileName: string): FakeArchiveDetection | null {
    const match = (fileName || '').trim().match(this.FAKE_ARCHIVE_RE);
    if (!match) return null;
    return {
      isFake: true,
      restoredName: match[1],
      realExt: `.${match[2].toLowerCase()}`,
      fakeExt: `.${match[3].toLowerCase()}`,
    };
  }

  static isArchiveFile(fileName: string): boolean {
    if (!fileName) return false;
    if (this.detectFakeArchiveVideo(fileName)) return false;
    return this.ARCHIVE_EXT_RE.test(fileName.trim());
  }

  /**
   * 判断是否为分卷压缩包的后续分卷（如 .part2.rar / .002 / .z01 / .r00），批量解压时避免重复触发
   */
  static isNonFirstSplitPart(fileName: string): boolean {
    const name = (fileName || '').trim();
    const partMatch = name.match(/\.part(\d+)\.rar$/i);
    if (partMatch && parseInt(partMatch[1], 10) > 1) return true;
    const numMatch = name.match(/\.(\d{3})$/);
    if (numMatch && parseInt(numMatch[1], 10) > 1) return true;
    if (/\.(?:z\d{2}|r\d{2})$/i.test(name)) return true;
    return false;
  }

  static isSubtitleFile(fileName: string): boolean {
    return this.SUBTITLE_EXT_RE.test(fileName || '');
  }

  static isAudioFile(fileName: string): boolean {
    return this.AUDIO_EXT_RE.test(fileName || '');
  }

  static isImageFile(fileName: string): boolean {
    return this.IMAGE_EXT_RE.test(fileName || '');
  }

  static isDocumentFile(fileName: string): boolean {
    return this.DOCUMENT_EXT_RE.test(fileName || '');
  }

  static classifyFile(file: Pick<QuarkFileNode, 'file_name' | 'dir'>): QuarkFileCategory {
    if (file.dir) return 'folder';
    const name = file.file_name || '';
    if (this.detectFakeArchiveVideo(name)) return 'fake_archive';
    if (this.isArchiveFile(name)) return 'archive';
    if (this.isVideoFile(name)) return 'video';
    if (this.isSubtitleFile(name)) return 'subtitle';
    if (this.isAudioFile(name)) return 'audio';
    if (this.isImageFile(name)) return 'image';
    if (this.isDocumentFile(name)) return 'document';
    return 'other';
  }

  static getFileIcon(file: Pick<QuarkFileNode, 'file_name' | 'dir'>): string {
    const cat = this.classifyFile(file);
    switch (cat) {
      case 'folder':
        return '📁';
      case 'video':
        return '🎬';
      case 'archive':
      case 'fake_archive':
        return '📦';
      case 'subtitle':
        return '💬';
      case 'audio':
        return '🎵';
      case 'image':
        return '🖼️';
      case 'document':
        return '📄';
      default:
        return '📎';
    }
  }

  static extractArchivePasswordHint(text: string): string | undefined {
    const raw = (text || '').trim();
    if (!raw) return undefined;
    // 先剥离末尾压缩包后缀（避免把 "电影_密码abc123.zip" 误截成 "abc123.zip"）
    const withoutArchiveExt = raw.replace(this.ARCHIVE_EXT_RE, '').trim();
    const match = withoutArchiveExt.match(
      /(?:解压密码|解压码|压缩密码|密码|口令|pwd|password)[：:=\s]*([A-Za-z0-9._@#\-!$%^&*]{1,32})/i
    );
    return match?.[1]?.replace(/[.)）\]】]+$/g, '').trim() || undefined;
  }

  /**
   * 重命名文件时自动保留原后缀（若用户新名字未包含后缀且目标是普通文件）
   */
  static preserveExtensionOnRename(oldName: string, newName: string, isDir: boolean): string {
    const cleanNew = (newName || '').replace(/[\\/:*?"<>|]/g, '').trim();
    if (!cleanNew) return oldName;
    if (isDir) return cleanNew;
    const oldExt = path.extname(oldName);
    const newExt = path.extname(cleanNew);
    if (oldExt && !newExt) {
      return `${cleanNew}${oldExt}`;
    }
    return cleanNew;
  }

  /**
   * 统计一组网盘节点的文件类型、体积、后缀与压缩包清单
   */
  static summarizeFileTypes(files: QuarkFileNode[]): FileTypeSummary {
    let folderCount = 0;
    let videoCount = 0;
    let subtitleCount = 0;
    let audioCount = 0;
    let imageCount = 0;
    let documentCount = 0;
    let otherCount = 0;
    let totalBytes = 0;
    const archiveFiles: QuarkFileNode[] = [];
    const fakeArchiveFiles: Array<{ node: QuarkFileNode; restoredName: string; realExt: string; fakeExt: string }> = [];
    const extCountMap = new Map<string, number>();

    for (const f of files) {
      if (f.size && Number.isFinite(f.size)) {
        totalBytes += f.size;
      }
      const cat = this.classifyFile(f);
      if (cat === 'folder') {
        folderCount++;
        continue;
      }

      const ext = path.extname(f.file_name || '').replace(/^\./, '').toUpperCase();
      if (ext && ext.length <= 8) {
        extCountMap.set(ext, (extCountMap.get(ext) || 0) + 1);
      }

      if (cat === 'fake_archive') {
        const fake = this.detectFakeArchiveVideo(f.file_name);
        if (fake) {
          fakeArchiveFiles.push({
            node: f,
            restoredName: fake.restoredName,
            realExt: fake.realExt,
            fakeExt: fake.fakeExt,
          });
        }
      } else if (cat === 'archive') {
        archiveFiles.push(f);
      } else if (cat === 'video') {
        videoCount++;
      } else if (cat === 'subtitle') {
        subtitleCount++;
      } else if (cat === 'audio') {
        audioCount++;
      } else if (cat === 'image') {
        imageCount++;
      } else if (cat === 'document') {
        documentCount++;
      } else {
        otherCount++;
      }
    }

    const extensions = Array.from(extCountMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext]) => ext);

    const parts: string[] = [];
    if (archiveFiles.length > 0) {
      const archExts = Array.from(
        new Set(
          archiveFiles
            .map((f) => path.extname(f.file_name).replace(/^\./, '').toUpperCase())
            .filter(Boolean)
        )
      ).slice(0, 3);
      parts.push(`压缩包 ${archiveFiles.length} 个${archExts.length ? `（${archExts.join('/')}）` : ''}`);
    }
    if (fakeArchiveFiles.length > 0) {
      parts.push(`伪装后缀视频 ${fakeArchiveFiles.length} 个`);
    }
    if (videoCount > 0) {
      const vidExts = Array.from(
        new Set(
          files
            .filter((f) => !f.dir && this.isVideoFile(f.file_name) && !this.detectFakeArchiveVideo(f.file_name))
            .map((f) => path.extname(f.file_name).replace(/^\./, '').toUpperCase())
            .filter(Boolean)
        )
      ).slice(0, 3);
      parts.push(`视频 ${videoCount} 个${vidExts.length ? `（${vidExts.join('/')}）` : ''}`);
    }
    if (subtitleCount > 0) parts.push(`字幕 ${subtitleCount} 个`);
    if (audioCount > 0) parts.push(`音频 ${audioCount} 个`);
    if (imageCount > 0) parts.push(`图片 ${imageCount} 张`);
    if (documentCount > 0) parts.push(`文档 ${documentCount} 个`);
    if (otherCount > 0) parts.push(`其他文件 ${otherCount} 个`);
    if (parts.length === 0 && folderCount > 0) {
      parts.push(`文件夹 ${folderCount} 个`);
    }

    const totalFiles = files.length - folderCount;
    const summaryLine = parts.length > 0 ? parts.join('、') : '未知类型';

    return {
      totalFiles,
      folderCount,
      videoCount,
      archiveFiles,
      fakeArchiveFiles,
      subtitleCount,
      audioCount,
      imageCount,
      documentCount,
      otherCount,
      extensions,
      totalBytes,
      hasArchives: archiveFiles.length > 0 || fakeArchiveFiles.length > 0,
      summaryLine,
    };
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
