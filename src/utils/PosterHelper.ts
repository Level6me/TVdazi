import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LruCache } from './LruCache';
import { PushGateway } from '../services/PushGateway';
import { MetadataResolver } from '../services/MetadataResolver';

export interface FetchedPoster {
  buffer: Buffer;
  mime: string;
  ext: string;
}

const POSTER_HOST_SUFFIXES = [
  'doubanio.com',
  'tmdb.org',
  'bgm.tv',
  'mzstatic.com',
  'media-amazon.com',
  'ssl-images-amazon.com',
];

const posterCache = new LruCache<string, FetchedPoster>(120, 30 * 60 * 1000);

const TMP_POSTER_DIR = path.resolve(__dirname, '../../data/posters_tmp');

/**
 * 校验海报地址是否属于受信任的公开影视图床域名，防止 SSRF 与内网探测
 */
export function isAllowedPosterUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return POSTER_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function normalizePosterUrl(rawUrl?: string): string | undefined {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || !isAllowedPosterUrl(trimmed)) return undefined;
  return trimmed.replace(/^http:\/\//i, 'https://');
}

/**
 * 通过文件魔数校验是否为有效图片格式，避免把防盗链 HTML 错误页下发给用户
 */
export function detectImageMimeAndExt(buf: Buffer): { mime: string; ext: string } | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  return null;
}

/**
 * 拉取受信任图床的影视封面并内存缓存（自动携带豆瓣 Referer 绕过浏览器防盗链）
 */
export async function fetchPosterBuffer(rawUrl: string, timeoutMs = 4000): Promise<FetchedPoster | null> {
  const normalized = normalizePosterUrl(rawUrl);
  if (!normalized) return null;

  const cached = posterCache.get(normalized);
  if (cached) return cached;

  try {
    const host = new URL(normalized).hostname.toLowerCase();
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    };
    if (host.endsWith('doubanio.com')) {
      headers.Referer = 'https://movie.douban.com/';
    }

    const resp = await axios.get<ArrayBuffer>(normalized, {
      headers,
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxContentLength: 4 * 1024 * 1024,
      maxBodyLength: 4 * 1024 * 1024,
    });

    const buffer = Buffer.from(resp.data);
    const detected = detectImageMimeAndExt(buffer);
    if (!detected) return null;

    const entry: FetchedPoster = {
      buffer,
      mime: detected.mime,
      ext: detected.ext,
    };
    posterCache.set(normalized, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * 向微信用户推送影视资源海报封面（全程限时降级，绝不阻塞主文本回复）
 */
export async function sendCoverToWechatUser(
  userId: string,
  opts: {
    title?: string;
    knownCover?: string;
    year?: string;
    mediaType?: 'movie' | 'tv';
    timeoutMs?: number;
  }
): Promise<boolean> {
  const gateway = PushGateway.getInstance();
  if (!gateway.isImageReady()) return false;

  const timeoutMs = opts.timeoutMs ?? 3500;
  try {
    let coverUrl = normalizePosterUrl(opts.knownCover);
    if (!coverUrl && opts.title) {
      coverUrl = await Promise.race([
        MetadataResolver.getInstance().resolveCoverUrl(opts.title, {
          year: opts.year,
          mediaType: opts.mediaType,
        }),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2200)),
      ]);
      coverUrl = normalizePosterUrl(coverUrl);
    }
    if (!coverUrl) return false;

    const fetched = await fetchPosterBuffer(coverUrl, timeoutMs);
    if (!fetched) return false;

    if (!fs.existsSync(TMP_POSTER_DIR)) {
      fs.mkdirSync(TMP_POSTER_DIR, { recursive: true });
    }
    const hash = crypto.createHash('sha1').update(coverUrl).digest('hex').slice(0, 12);
    const tmpPath = path.join(TMP_POSTER_DIR, `poster_${hash}_${Date.now()}.${fetched.ext}`);
    fs.writeFileSync(tmpPath, fetched.buffer);
    try {
      return await gateway.sendImageToUser(userId, tmpPath);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
    }
  } catch {
    return false;
  }
}
