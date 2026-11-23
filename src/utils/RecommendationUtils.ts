import { DoubanSubject } from '../services/DoubanService';

/** 统一影视片名比较口径：兼容书名号、全半角标点和空格差异。 */
export function normalizeRecommendationTitle(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function getDoubanSubjectId(subject: Partial<DoubanSubject>): string | undefined {
  const id = String(subject.id || '').trim();
  return /^\d+$/.test(id) ? id : undefined;
}

/** 有豆瓣编号时按编号识别；否则用片名和年份兜底，避免同名翻拍被合并。 */
export function getRecommendationSubjectKey(subject: Partial<DoubanSubject>): string {
  const id = getDoubanSubjectId(subject);
  if (id) return `id:${id}`;
  const title = normalizeRecommendationTitle(subject.title);
  const year = String(subject.year || '').match(/(?:19|20)\d{2}/)?.[0] || '';
  return `title:${title}|year:${year}`;
}
