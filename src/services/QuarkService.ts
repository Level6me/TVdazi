import axios from 'axios';
import * as crypto from 'crypto';
import * as path from 'path';
import { ResourceCategory } from '../types';
import { AntiCensorService } from './AntiCensorService';
import { upsertEnvVar } from '../utils/FileUtils';

export interface QuarkUserInfo {
  nickname: string;
  totalCapacity: string;
  usedCapacity?: string;
  freeCapacity: string;
  usagePercent?: string;
  memberType?: string;
  freeBytes?: number;
}

export interface QuarkFolderItem {
  cid: string;
  name: string;
}

export class QuarkService {
  private cookie: string;
  private envPath: string;
  private defaultRootDir: string;
  private dirCache: Map<string, { fid: string; cachedAt: number }> = new Map();
  private static readonly DIR_CACHE_TTL_MS = 10 * 60 * 1000;

  constructor(cookie?: string, envPath?: string) {
    this.cookie = cookie || process.env.QUARK_COOKIE || '';
    this.envPath = envPath || path.resolve(process.cwd(), '.env');
    this.defaultRootDir = process.env.DEFAULT_SAVE_DIR || '/我的资源';
  }

  isConfigured(customCookie?: string): boolean {
    const active = customCookie || this.cookie;
    return Boolean(active && active.trim().length > 0);
  }

  getDefaultRootDir(): string {
    return this.defaultRootDir;
  }

  /**
   * 动态设置 Cookie 并持久化保存到 .env (全局默认)
   */
  setCookie(newCookie: string): boolean {
    this.cookie = newCookie.trim();
    process.env.QUARK_COOKIE = this.cookie;

    try {
      upsertEnvVar(this.envPath, 'QUARK_COOKIE', this.cookie);
      return true;
    } catch (err: any) {
      console.error('[QuarkService] 写入 Cookie 失败:', err.message);
      return false;
    }
  }

  private getHeaders(customCookie?: string) {
    return {
      Cookie: customCookie || this.cookie,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://pan.quark.cn/',
      Origin: 'https://pan.quark.cn',
    };
  }

  private static formatCapacityBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '未知';
    const tb = bytes / (1024 * 1024 * 1024 * 1024);
    const gb = bytes / (1024 * 1024 * 1024);
    const mb = bytes / (1024 * 1024);
    if (tb >= 1) {
      return `${tb.toFixed(2)} TB (${gb.toFixed(1)} GB)`;
    }
    if (gb >= 1) {
      return `${gb.toFixed(1)} GB`;
    }
    return `${mb.toFixed(1)} MB`;
  }

  /**
   * 获取网盘用户信息与真实容量（并发拉取 account/info 昵称与 clouddrive/member 容量数据）
   */
  async getUserInfo(customCookie?: string): Promise<QuarkUserInfo | null> {
    if (!this.isConfigured(customCookie)) return null;

    const headers = this.getHeaders(customCookie);

    try {
      const [accRes, memRes] = await Promise.allSettled([
        axios.get('https://pan.quark.cn/account/info', {
          headers,
          timeout: 6000,
        }),
        axios.get(
          'https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&uc_param_str=&fetch_subscribe=true&_ch=home&fetch_identity=true',
          {
            headers,
            timeout: 6000,
          }
        ),
      ]);

      const accData = accRes.status === 'fulfilled' ? accRes.value.data?.data : null;
      const memData = memRes.status === 'fulfilled' ? memRes.value.data?.data : null;

      if (!accData && !memData) {
        return null;
      }

      const nickname = accData?.nickname || '夸克用户';
      const totalBytes = Number(memData?.total_capacity ?? accData?.total_capacity);
      const usedBytes = Number(memData?.use_capacity ?? memData?.used_capacity ?? accData?.used_capacity);

      const memberMap: Record<string, string> = {
        SUPER_VIP: 'SVIP超级会员',
        VIP: 'VIP会员',
        NORMAL: '普通用户',
      };
      const rawMember = memData?.member_type;
      const memberType = rawMember ? memberMap[rawMember] || rawMember : undefined;

      if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(usedBytes) && usedBytes >= 0) {
        const freeBytes = Math.max(0, totalBytes - usedBytes);
        const usagePct = ((usedBytes / totalBytes) * 100).toFixed(1) + '%';
        return {
          nickname,
          totalCapacity: QuarkService.formatCapacityBytes(totalBytes),
          usedCapacity: QuarkService.formatCapacityBytes(usedBytes),
          freeCapacity: QuarkService.formatCapacityBytes(freeBytes),
          usagePercent: usagePct,
          memberType,
          freeBytes,
        };
      }

      return {
        nickname,
        totalCapacity: '充足',
        freeCapacity: '充足',
        memberType,
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取目录列表（严格区分接口成功返回空列表与请求失败/未登录）
   */
  private async getFolderListStrict(
    parentCid = '0',
    customCookie?: string
  ): Promise<{ ok: boolean; unauthorized?: boolean; folders: QuarkFolderItem[] }> {
    try {
      const response = await axios.get('https://drive-h.quark.cn/1/clouddrive/file/sort', {
        params: {
          pr: 'ucpro',
          fr: 'pc',
          uc_param_str: '',
          pdir_fid: parentCid,
          _page: '1',
          _size: '100',
          _fetch_total: 'false',
          _fetch_sub_dirs: '1',
          __dt: '2093126',
          __t: Date.now(),
        },
        headers: this.getHeaders(customCookie),
        timeout: 7000,
      });

      if (response.data?.status === 401 || response.data?.code === 40001 || response.data?.message?.includes('登录')) {
        return { ok: false, unauthorized: true, folders: [] };
      }

      if (response.data?.data?.list) {
        return {
          ok: true,
          folders: response.data.data.list
            .filter((item: any) => item.dir)
            .map((item: any) => ({
              cid: item.fid,
              name: item.file_name,
            })),
        };
      }
      return { ok: false, folders: [] };
    } catch (err: any) {
      const unauthorized = err.response?.status === 401 || err.response?.data?.message?.includes('登录');
      console.error('[QuarkService] 获取文件夹列表失败:', err.message);
      return { ok: false, unauthorized, folders: [] };
    }
  }

  /**
   * 获取目录列表
   */
  async getFolderList(parentCid = '0', customCookie?: string): Promise<QuarkFolderItem[]> {
    const res = await this.getFolderListStrict(parentCid, customCookie);
    return res.folders;
  }

  /**
   * 创建文件夹
   */
  async createFolder(pdirFid: string, folderName: string, customCookie?: string): Promise<string | null> {
    try {
      const resp = await axios.post(
        'https://drive-h.quark.cn/1/clouddrive/file?pr=ucpro&fr=pc',
        {
          pdir_fid: pdirFid,
          file_name: folderName,
          dir_path: '',
          dir_init_lock: '',
        },
        { headers: this.getHeaders(customCookie), timeout: 7000 }
      );
      if (resp.data?.data?.fid) {
        return resp.data.data.fid;
      }
      return null;
    } catch (err: any) {
      // 若出现同名冲突 (code 23008)，直接获取已有文件夹 fid 复用
      if (err.response?.data?.code === 23008) {
        try {
          const list = await this.getFolderList(pdirFid, customCookie);
          const found = list.find((f) => f.name === folderName);
          if (found) return found.cid;
        } catch {}
      }
      return null;
    }
  }

  private getCookieScopeKey(customCookie?: string): string {
    const raw = (customCookie || this.cookie || '').trim();
    if (!raw) return 'empty';
    return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
  }

  private getCachedDirFid(cacheKey: string): string | undefined {
    const entry = this.dirCache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > QuarkService.DIR_CACHE_TTL_MS) {
      this.dirCache.delete(cacheKey);
      return undefined;
    }
    return entry.fid;
  }

  private setCachedDirFid(cacheKey: string, fid: string): void {
    if (!this.dirCache.has(cacheKey) && this.dirCache.size >= 300) {
      const oldest = this.dirCache.keys().next().value;
      if (oldest) this.dirCache.delete(oldest);
    }
    this.dirCache.set(cacheKey, { fid, cachedAt: Date.now() });
  }

  private invalidateDirCacheForScope(customCookie?: string): void {
    const prefix = `${this.getCookieScopeKey(customCookie)}:`;
    for (const key of this.dirCache.keys()) {
      if (key.startsWith(prefix)) {
        this.dirCache.delete(key);
      }
    }
  }

  /**
   * 递归解析并自动逐层创建多级路径，返回最底层目录 FID
   * 例如 "/我的资源/MI/电影"，会依次定位或创建 "我的资源" -> "MI" -> "电影"
   */
  async ensureDirectoryPath(fullPath: string, customCookie?: string): Promise<string> {
    const scopeKey = this.getCookieScopeKey(customCookie);
    const cacheKey = `${scopeKey}:${fullPath}`;
    const hit = this.getCachedDirFid(cacheKey);
    if (hit) {
      return hit;
    }

    const segments = fullPath
      .replace(/^[\/\\]+|[\/\\]+$/g, '')
      .split(/[\/\\]+/)
      .filter(Boolean);

    let currentFid = '0';
    let currentPath = '';
    let allSucceeded = true;

    for (const segment of segments) {
      currentPath += `/${segment}`;
      const subCacheKey = `${scopeKey}:${currentPath}`;
      const subHit = this.getCachedDirFid(subCacheKey);
      if (subHit) {
        currentFid = subHit;
        continue;
      }

      const listRes = await this.getFolderListStrict(currentFid, customCookie);
      if (!listRes.ok) {
        allSucceeded = false;
        break;
      }

      const found = listRes.folders.find((f) => f.name === segment);
      if (found) {
        currentFid = found.cid;
      } else {
        const newFid = await this.createFolder(currentFid, segment, customCookie);
        if (newFid) {
          currentFid = newFid;
        } else {
          console.warn(`[QuarkService] 创建子目录【${segment}】失败 (父节点: ${currentFid})`);
          allSucceeded = false;
          break;
        }
      }
      this.setCachedDirFid(subCacheKey, currentFid);
    }

    // 仅当路径所有层级全部成功定位/创建时才写入完整路径缓存，防止半截父目录污染缓存
    if (allSucceeded && segments.length > 0) {
      this.setCachedDirFid(cacheKey, currentFid);
    }
    return currentFid;
  }

  /**
   * 解析或获取分类目标目录 FID
   * 支持多层级嵌套自动创建：例如 /我的资源/MI/电影 或 /追剧/国产剧
   */
  async getCategoryDir(
    category: ResourceCategory,
    rootDir?: string,
    customCookie?: string
  ): Promise<{ fid: string; path: string }> {
    const baseDir = rootDir || this.defaultRootDir;
    const fullPath = `${baseDir}/${category}`.replace(/\/+/g, '/');

    try {
      const fid = await this.ensureDirectoryPath(fullPath, customCookie);
      return { fid, path: fullPath };
    } catch (err: any) {
      console.error('[QuarkService] 解析分类目录失败:', err.message);
      return { fid: '0', path: fullPath };
    }
  }

  /**
   * 移动文件或文件夹到目标目录
   */
  async moveFile(
    fid: string,
    toPdirFid: string,
    customCookie?: string
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConfigured(customCookie)) {
      return { success: false, message: '未配置夸克 Cookie' };
    }
    try {
      const resp = await axios.post(
        'https://drive-h.quark.cn/1/clouddrive/file/move?pr=ucpro&fr=pc',
        {
          filelist: [fid],
          to_pdir_fid: toPdirFid,
          exclude_fids: [],
          action_type: 1,
        },
        {
          headers: this.getHeaders(customCookie),
          timeout: 8000,
        }
      );
      if (resp.data?.status === 200 || resp.data?.code === 0) {
        return { success: true };
      }
      return { success: false, message: resp.data?.message || '移动失败' };
    } catch (err: any) {
      return { success: false, message: err.response?.data?.message || err.message };
    }
  }

  /**
   * 获取夸克分享信息
   */
  async getShareInfo(pwdId: string, passcode: string = '', customCookie?: string) {
    try {
      const detailUrl = `https://drive-h.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=&__dt=994&__t=${Date.now()}`;
      const tokenResp = await axios.post(
        detailUrl,
        { pwd_id: pwdId, passcode },
        { headers: this.getHeaders(customCookie), timeout: 8000 }
      );
      return tokenResp.data;
    } catch {
      return null;
    }
  }

  /**
   * 重命名夸克网盘指定文件或文件夹
   */
  async renameFile(
    fid: string,
    newFileName: string,
    customCookie?: string
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConfigured(customCookie)) {
      return { success: false, message: '未配置夸克 Cookie' };
    }
    try {
      const resp = await axios.post(
        'https://drive-h.quark.cn/1/clouddrive/file/rename?pr=ucpro&fr=pc',
        {
          fid,
          file_name: newFileName,
        },
        {
          headers: this.getHeaders(customCookie),
          timeout: 8000,
        }
      );
      if (resp.data?.status === 200 || resp.data?.code === 0) {
        return { success: true };
      }
      return { success: false, message: resp.data?.message || '重命名失败' };
    } catch (err: any) {
      return { success: false, message: err.response?.data?.message || err.message };
    }
  }

  /**
   * 轮询异步转存任务状态并获取生成的文件/目录 fid 列表
   */
  async pollTaskTopFids(taskId: string, customCookie?: string, maxAttempts = 6): Promise<string[]> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const resp = await axios.get('https://drive-h.quark.cn/1/clouddrive/task', {
          params: {
            pr: 'ucpro',
            fr: 'pc',
            task_id: taskId,
            retry_index: attempt,
            __t: Date.now(),
          },
          headers: this.getHeaders(customCookie),
          timeout: 4000,
        });
        const taskData = resp.data?.data;
        if (taskData?.status === 2) {
          return taskData?.save_as?.save_as_top_fids || [];
        }
        if (taskData?.status === 3) {
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 600));
    }
    return [];
  }

  /**
   * 转存分享文件到用户指定分类目录（支持定制 Cookie、自定义保存根目录与智能防和谐自动还原）
   */
  async saveShareFiles(
    pwdId: string,
    passcode: string = '',
    category: ResourceCategory = '电影',
    options?: {
      customCookie?: string;
      rootDir?: string;
      standardTitle?: string;
      userId?: string;
      autoCleanCensor?: boolean;
    }
  ): Promise<{
    success: boolean;
    message: string;
    targetPath: string;
    renamedItems?: Array<{ original: string; restored: string; reason?: string }>;
  }> {
    const customCookie = options?.customCookie;
    const rootDir = options?.rootDir || this.defaultRootDir;

    if (!this.isConfigured(customCookie)) {
      return {
        success: false,
        message: '未配置夸克网盘 Cookie，无法执行自动转存。请先发送 /set-quark <cookie> 进行绑定。',
        targetPath: `${rootDir}/${category}`,
      };
    }

    const { fid: targetFid, path: targetPath } = await this.getCategoryDir(category, rootDir, customCookie);

    try {
      // 1. 获取分享详情与 stoken
      const tokenData = await this.getShareInfo(pwdId, passcode, customCookie);
      const stoken = tokenData?.data?.stoken;
      if (!stoken) {
        return {
          success: false,
          message: '获取分享凭证失败，分享链接可能已失效或需要提取码',
          targetPath,
        };
      }

      // 2. 分页获取分享文件列表（突破单页 50 条限制，最多拉取 500 条防止长剧集漏存）
      let fid_list: string[] = [];
      let fid_token_list: string[] = [];
      let shareItems: Array<{ fid: string; file_name: string }> = [];
      try {
        for (let page = 1; page <= 10; page++) {
          const dResp = await axios.get('https://drive-h.quark.cn/1/clouddrive/share/sharepage/detail', {
            params: {
              pr: 'ucpro',
              fr: 'pc',
              pwd_id: pwdId,
              stoken: stoken,
              pdir_fid: '0',
              _page: String(page),
              _size: '50',
            },
            headers: this.getHeaders(customCookie),
            timeout: 8000,
          });

          const list = dResp.data?.data?.list || [];
          if (list.length === 0) break;

          for (const item of list) {
            fid_list.push(item.fid);
            fid_token_list.push(item.share_fid_token);
            shareItems.push({ fid: item.fid, file_name: item.file_name });
          }
          if (list.length < 50) break;
        }
      } catch {}

      if (fid_list.length === 0) {
        return {
          success: false,
          message: '分享链接内没有可转存的文件，或分享内容已被删除',
          targetPath,
        };
      }

      // 3. 执行转存
      const saveUrl = `https://drive-h.quark.cn/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=&__dt=889&__t=${Date.now()}`;
      const saveResp = await axios.post(
        saveUrl,
        {
          pwd_id: pwdId,
          stoken: stoken,
          to_pdir_fid: targetFid,
          fid_list: fid_list,
          fid_token_list: fid_token_list,
        },
        {
          headers: this.getHeaders(customCookie),
          timeout: 10000,
        }
      );

      const status = saveResp.data?.status;
      const code = saveResp.data?.code;

      if (status === 200 || code === 0 || saveResp.data?.data?.task_id) {
        let baseMsg = `✅ 已成功自动转存至夸克网盘【${targetPath}】！`;
        const renamedItems: Array<{ original: string; restored: string; reason?: string }> = [];

        // 4. 自动防和谐检测与还原更名
        if (options?.autoCleanCensor !== false) {
          try {
            await this.handlePostSaveRename(
              targetFid,
              saveResp.data?.data?.task_id,
              shareItems,
              options?.standardTitle,
              options?.userId,
              customCookie,
              renamedItems
            );
          } catch (cleanErr: any) {
            console.warn('[QuarkService] 自动还原防和谐名称异常:', cleanErr.message);
          }
        }

        if (renamedItems.length > 0) {
          baseMsg += '\n✨ 【智能防和谐还原】检测到网盘资源原名为防侵权混淆名称：';
          for (const item of renamedItems) {
            baseMsg += `\n   • 原名：「${item.original}」\n   ➜ 已自动规整为：《${item.restored}》`;
          }
        }

        return {
          success: true,
          message: baseMsg,
          targetPath,
          renamedItems,
        };
      }

      const msg = saveResp.data?.message || '转存失败';
      if (status === 401 || code === 40001 || /登录|未授权/.test(msg)) {
        this.invalidateDirCacheForScope(customCookie);
        return {
          success: false,
          message: `⚠️ 转存至【${targetPath}】失败：夸克 Cookie 凭证未激活或已过期。\n💡 解决方式：请在电脑打开 pan.quark.cn 登录，按 F12 在 Network（网络）中点击任意请求复制完整 Cookie，发送「/set-quark <新Cookie>」即可！`,
          targetPath,
        };
      }
      if (/目录不存在|父目录/.test(msg)) {
        this.invalidateDirCacheForScope(customCookie);
      }
      return {
        success: false,
        message: `转存接口返回: ${msg} (状态码: ${status || code})`,
        targetPath,
      };
    } catch (err: any) {
      if (err.response?.status === 401 || err.response?.data?.message?.includes('登录')) {
        this.invalidateDirCacheForScope(customCookie);
        return {
          success: false,
          message: `⚠️ 转存至【${targetPath}】失败：夸克 Cookie 凭证未激活或已过期。\n💡 解决方式：请在电脑打开 pan.quark.cn 登录，按 F12 在 Network（网络）中点击任意请求复制完整 Cookie，发送「/set-quark <新Cookie>」即可！`,
          targetPath,
        };
      }
      return {
        success: false,
        message: `转存异常: ${err.message || '网络请求超时'}`,
        targetPath,
      };
    }
  }

  /**
   * 转存后处理防和谐重命名
   */
  private async handlePostSaveRename(
    targetFid: string,
    taskId: string | undefined,
    shareItems: Array<{ fid: string; file_name: string }>,
    standardTitle?: string,
    userId?: string,
    customCookie?: string,
    renamedItems: Array<{ original: string; restored: string; reason?: string }> = []
  ): Promise<void> {
    const antiCensor = AntiCensorService.getInstance();

    // 1. 如果有 taskId，尝试获取生成的文件 top_fids
    let targetFids: string[] = [];
    if (taskId) {
      targetFids = await this.pollTaskTopFids(taskId, customCookie);
    }

    // 2. 查询目标目录中的最新文件（最多取前 30 个）
    const sortResp = await axios.get('https://drive-h.quark.cn/1/clouddrive/file/sort', {
      params: {
        pr: 'ucpro',
        fr: 'pc',
        uc_param_str: '',
        pdir_fid: targetFid,
        _page: '1',
        _size: '30',
        _sort: 'updated_at:desc',
      },
      headers: this.getHeaders(customCookie),
      timeout: 7000,
    });

    const fileList: Array<{ fid: string; file_name: string; dir?: boolean }> = sortResp.data?.data?.list || [];
    const shareNameSet = new Set(shareItems.map((s) => s.file_name));
    const targetFidSet = new Set(targetFids);

    // 候选文件/目录：命中 task_id top_fids 或者文件名与分享项一致的项
    const candidates = fileList.filter((f) => targetFidSet.has(f.fid) || shareNameSet.has(f.file_name));

    const childDirsToScan: Array<{ fid: string; folderTitle: string }> = [];

    for (const item of candidates) {
      let effectiveName = item.file_name;
      const checkRes = await antiCensor.restoreTitle(item.file_name, standardTitle, userId);
      if (checkRes.isHarmonized && checkRes.restoredName && checkRes.restoredName !== item.file_name) {
        const renameRes = await this.renameFile(item.fid, checkRes.restoredName, customCookie);
        if (renameRes.success) {
          effectiveName = checkRes.restoredName;
          renamedItems.push({
            original: item.file_name,
            restored: checkRes.restoredName,
            reason: checkRes.reason,
          });
        }
      }
      if (item.dir && childDirsToScan.length < 5) {
        childDirsToScan.push({
          fid: item.fid,
          folderTitle: standardTitle || checkRes.standardTitle || effectiveName,
        });
      }
    }

    // 递归 1 层进入新转存的剧集/合集子目录，清洗内部被混淆的单集文件名（最多处理 5 个子目录）
    for (const child of childDirsToScan) {
      try {
        const childRes = await this.cleanAntiCensorFilesInFolder(child.fid, {
          standardTitle: child.folderTitle,
          userId,
          customCookie,
          maxScan: 30,
        });
        renamedItems.push(...childRes.renamedItems);
      } catch {}
    }
  }

  /**
   * 扫描指定目录并批量规整防和谐混淆资源名（支持存量文件一键治理）
   */
  async cleanAntiCensorFilesInFolder(
    folderFid = '0',
    options?: { standardTitle?: string; userId?: string; customCookie?: string; maxScan?: number }
  ): Promise<{
    scannedCount: number;
    renamedItems: Array<{ original: string; restored: string; reason?: string }>;
  }> {
    const customCookie = options?.customCookie;
    const antiCensor = AntiCensorService.getInstance();
    const maxScan = options?.maxScan || 50;

    const renamedItems: Array<{ original: string; restored: string; reason?: string }> = [];

    try {
      const sortResp = await axios.get('https://drive-h.quark.cn/1/clouddrive/file/sort', {
        params: {
          pr: 'ucpro',
          fr: 'pc',
          uc_param_str: '',
          pdir_fid: folderFid,
          _page: '1',
          _size: String(maxScan),
          _sort: 'updated_at:desc',
        },
        headers: this.getHeaders(customCookie),
        timeout: 8000,
      });

      const list: Array<{ fid: string; file_name: string; dir: boolean }> = sortResp.data?.data?.list || [];

      for (const item of list) {
        if (!antiCensor.hasHarmonizedFeatures(item.file_name)) {
          continue;
        }

        const checkRes = await antiCensor.restoreTitle(item.file_name, options?.standardTitle, options?.userId);
        if (checkRes.isHarmonized && checkRes.restoredName && checkRes.restoredName !== item.file_name) {
          const res = await this.renameFile(item.fid, checkRes.restoredName, customCookie);
          if (res.success) {
            renamedItems.push({
              original: item.file_name,
              restored: checkRes.restoredName,
              reason: checkRes.reason,
            });
          }
        }
      }

      return {
        scannedCount: list.length,
        renamedItems,
      };
    } catch (err: any) {
      console.error('[QuarkService] 批量清理防和谐名称失败:', err.message);
      return {
        scannedCount: 0,
        renamedItems,
      };
    }
  }

  /**
   * 仅解析已存在的路径 FID（只读查找，不自动创建不存在的空目录）
   */
  async resolveExistingPathFid(fullPath: string, customCookie?: string): Promise<string | null> {
    const segments = fullPath
      .replace(/^[\/\\]+|[\/\\]+$/g, '')
      .split(/[\/\\]+/)
      .filter(Boolean);
    if (segments.length === 0) return '0';

    let currentFid = '0';
    for (const segment of segments) {
      const folders = await this.getFolderList(currentFid, customCookie);
      const found = folders.find((f) => f.name === segment);
      if (!found) return null;
      currentFid = found.cid;
    }
    return currentFid;
  }

  /**
   * 全面扫描用户网盘工作区（根目录 + 用户保存根目录 + 全部已存在的影视分类子目录），不误建空文件夹
   */
  async cleanUserWorkspace(
    userRootDir?: string,
    options?: { userId?: string; customCookie?: string }
  ): Promise<{
    scannedCount: number;
    renamedItems: Array<{ original: string; restored: string; reason?: string }>;
  }> {
    const customCookie = options?.customCookie;
    const baseDir = userRootDir || this.defaultRootDir;
    let totalScanned = 0;
    const allRenamed: Array<{ original: string; restored: string; reason?: string }> = [];
    const scannedFids = new Set<string>();

    const antiCensor = AntiCensorService.getInstance();
    const scanOnce = async (fid: string, fallbackTitle?: string) => {
      if (!fid || scannedFids.has(fid)) return;
      scannedFids.add(fid);
      const res = await this.cleanAntiCensorFilesInFolder(fid, {
        ...options,
        standardTitle: options?.standardTitle || fallbackTitle,
      });
      totalScanned += res.scannedCount;
      allRenamed.push(...res.renamedItems);
    };

    // 1. 扫描网盘顶层根目录 '0'
    await scanOnce('0');

    // 2. 查找用户保存根目录（如 /我的资源），若存在则扫描该目录、全部分类子目录及其下 1 层影视文件夹（最多 15 个，防止触发接口限流）
    try {
      const rootFid = await this.resolveExistingPathFid(baseDir, customCookie);
      if (rootFid && rootFid !== '0') {
        await scanOnce(rootFid);
        const categoryFolders = await this.getFolderList(rootFid, customCookie);
        let nestedScanned = 0;
        for (const catFolder of categoryFolders) {
          await scanOnce(catFolder.cid);
          if (nestedScanned >= 15) continue;
          try {
            const mediaFolders = await this.getFolderList(catFolder.cid, customCookie);
            for (const mediaFolder of mediaFolders) {
              if (nestedScanned >= 15) break;
              nestedScanned++;
              const folderHint = antiCensor.hasHarmonizedFeatures(mediaFolder.name)
                ? undefined
                : mediaFolder.name.replace(/[《》]/g, '').trim();
              await scanOnce(mediaFolder.cid, folderHint);
            }
          } catch {}
        }
      }
    } catch {}

    return {
      scannedCount: totalScanned,
      renamedItems: allRenamed,
    };
  }
}
