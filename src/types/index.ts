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
  codec?: '原盘/REMUX' | '高码率' | 'HEVC';
  audio?: string;
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
