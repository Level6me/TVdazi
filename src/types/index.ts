export type ResourceCategory =
  | '电影'
  | '国产剧'
  | '美剧'
  | '韩剧'
  | '日剧'
  | '动漫'
  | '综艺'
  | '纪录片'
  | '其他';

export type PanType = 'quark' | 'aliyun' | 'uc' | '115' | 'baidu' | 'other';

export interface QualityTags {
  resolution?: '4K' | '1080P' | '720P';
  hdr?: '杜比视界' | 'HDR';
  dolbyVision?: boolean;
  codec?: '原盘/REMUX' | '高码率' | 'HEVC';
  audio?: string;
  audioLanguage?: '国粤双语' | '国语配音';
  subtitle?: string;
  sizeHint?: string;
  isSubtitleOnly?: boolean;
  badges: string[];
  qualityScoreBonus: number;
}

export interface CloudResource {
  title: string;
  shareUrl: string;
  shareId: string;
  passcode?: string;
  panType: PanType;
  rawText?: string;
  sourceChannel?: string;
  publishedAt?: string;
  category?: ResourceCategory;
  qualityTags?: QualityTags;
  /** 用于区分帖子正文中明确标注的片名与搜索词兜底值，避免低置信度资源触发自动转存。 */
  titleSource?: 'labeled' | 'first_line' | 'matched_line' | 'keyword_fallback';
  /** 链接附近的局部描述；多链接帖子中用于避免把整帖的集数、画质误套到每条链接。 */
  linkContext?: string;
}

export interface SearchOptions {
  keyword: string;
  aliasKeywords?: string[];
  actors?: string[];
  year?: string;
  quality?: string;
  maxResults?: number;
  subtitleOnly?: boolean;
}

export interface SearchResult {
  keyword: string;
  items: CloudResource[];
  totalFound: number;
  durationMs: number;
  fromCache?: boolean;
}
