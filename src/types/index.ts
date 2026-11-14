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

export interface CloudResource {
  title: string;
  shareUrl: string;
  shareId: string;
  passcode?: string;
  panType: 'quark' | 'aliyun' | 'uc' | '115' | 'other';
  rawText?: string;
  sourceChannel?: string;
  publishedAt?: string;
  category?: ResourceCategory;
}

export interface SearchOptions {
  keyword: string;
  aliasKeywords?: string[];
  actors?: string[];
  year?: string;
  quality?: string;
  maxResults?: number;
}

export interface SearchResult {
  keyword: string;
  items: CloudResource[];
  totalFound: number;
  durationMs: number;
}
