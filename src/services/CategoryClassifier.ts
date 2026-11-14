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

export class CategoryClassifier {
  /**
   * 基于片名、标签与正文特征进行精准分类
   */
  static classify(title: string, rawText: string = ''): ResourceCategory {
    const text = `${title} ${rawText}`.toLowerCase();

    // 1. 动漫 / 番剧
    if (
      /动漫|动画|新番|番剧|剧场版|国漫|b站国创|ova|oad|manga|anime/i.test(text)
    ) {
      return '动漫';
    }

    // 2. 综艺
    if (
      /综艺|真人秀|脱口秀|选秀|晚会|跨年|脱口秀大会|奇葩说|奔跑吧|极限挑战/i.test(text)
    ) {
      return '综艺';
    }

    // 3. 纪录片
    if (
      /纪录片|纪录|discovery|bbc|国家地理|nhk|人文地理|自然传奇/i.test(text)
    ) {
      return '纪录片';
    }

    // 4. 韩剧
    if (
      /韩剧|韩国电视剧|韩国剧|tvn|jtbc|kbs|sbs|韩语中字|韩国电影|韩国/i.test(text) &&
      !/国产|国语/i.test(title)
    ) {
      // 区分韩影与韩剧
      if (/电影|原盘REMUX/i.test(title) && !/第.*[季集]|全.*集|更新/i.test(text)) {
        return '电影';
      }
      return '韩剧';
    }

    // 5. 日剧
    if (
      /日剧|日本电视剧|日剧中字|东京电视台|富士台|tbs/i.test(text)
    ) {
      if (/电影|原盘REMUX/i.test(title) && !/第.*[季集]|全.*集/i.test(text)) {
        return '电影';
      }
      return '日剧';
    }

    // 6. 美剧 / 欧美剧
    if (
      /美剧|英剧|欧美剧|hbo|netflix|网飞|disney\+|apple tv|paramount|amazon|cw台|season\s*[0-9]+|s[0-9]{2}e[0-9]{2}/i.test(text) &&
      !/国产剧|大陆剧|华语剧|港剧|tvb|台剧/i.test(text)
    ) {
      if (/电影|原盘REMUX/i.test(title) && !/第.*[季集]|全.*集|s[0-9]{2}e[0-9]{2}/i.test(text)) {
        return '电影';
      }
      return '美剧';
    }

    // 7. 国产剧 (含华语、港剧、台剧)
    if (
      /国产剧|大陆剧|华语剧|电视剧|连续剧|网剧|古装|仙侠|民国|港剧|tvb|台剧|更新至|全[0-9]+集|第[0-9]+集|ep[0-9]+/i.test(text) ||
      (/第[一二三四五六七八九十0-9]+季/i.test(title) && !/美剧|netflix/i.test(text))
    ) {
      return '国产剧';
    }

    // 8. 电影 (默认或特征匹配)
    if (
      /电影|影院|4k原盘|remux|bluray|web-dl|bd1080p|hd1080p|蓝光|杜比视界|片长[0-9]+分钟/i.test(text)
    ) {
      return '电影';
    }

    // 默认兜底：带有季、集的是国产剧，否则归入电影
    if (/第.*[季集]|全.*集|更新至/i.test(title)) {
      return '国产剧';
    }

    return '电影';
  }
}
