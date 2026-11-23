import axios from 'axios';
import * as crypto from 'crypto';
import * as path from 'path';
import { ResourceCategory } from '../types';
import { AntiCensorService } from './AntiCensorService';
import { QuarkFileNode, QuarkOrganizer, DuplicateGroup, FileTypeSummary } from './QuarkOrganizer';
import { SessionManager } from './SessionManager';
import { upsertEnvVar } from '../utils/FileUtils';

export interface QuarkTaskPollResult {
  done: boolean;
  success: boolean;
  inProgress?: boolean;
  status: number;
  message?: string;
  topFids: string[];
  rawData?: any;
}

export interface QuarkUnarchiveResult {
  success: boolean;
  inProgress?: boolean;
  needPassword?: boolean;
  needVip?: boolean;
  concurrentLimit?: boolean;
  mode: 'cloud_unarchive' | 'fake_ext_renamed' | 'failed';
  sourceFile: string;
  restoredName?: string;
  targetDirFid?: string;
  extractedCount?: number;
  deletedOriginal?: boolean;
  message: string;
}

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
   * 批量移动文件或文件夹到目标目录
   */
  async moveFiles(
    fids: string[],
    toPdirFid: string,
    customCookie?: string
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConfigured(customCookie)) {
      return { success: false, message: '未配置夸克 Cookie' };
    }
    if (!fids || fids.length === 0) {
      return { success: false, message: '未指定要移动的文件' };
    }
    try {
      const resp = await axios.post(
        'https://drive-h.quark.cn/1/clouddrive/file/move?pr=ucpro&fr=pc',
        {
          filelist: fids,
          to_pdir_fid: toPdirFid,
          exclude_fids: [],
          action_type: 1,
        },
        {
          headers: this.getHeaders(customCookie),
          timeout: 8000,
        }
      );
      if (resp.data?.status === 200 || resp.data?.code === 0 || resp.data?.data?.task_id) {
        this.invalidateDirCacheForScope(customCookie);
        return { success: true };
      }
      return { success: false, message: resp.data?.message || '移动失败' };
    } catch (err: any) {
      return { success: false, message: err.response?.data?.message || err.message };
    }
  }

  /**
   * 移动单个文件或文件夹到目标目录
   */
  async moveFile(
    fid: string,
    toPdirFid: string,
    customCookie?: string
  ): Promise<{ success: boolean; message?: string }> {
    return this.moveFiles([fid], toPdirFid, customCookie);
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
   * 通用异步任务轮询（适用于转存、云端解压、批量移动等任务）
   */
  async pollTaskResult(
    taskId: string,
    customCookie?: string,
    options?: { maxAttempts?: number; intervalMs?: number; baseHost?: string }
  ): Promise<QuarkTaskPollResult> {
    const maxAttempts = options?.maxAttempts ?? 6;
    const intervalMs = options?.intervalMs ?? 600;
    const baseHost = options?.baseHost || 'https://drive-h.quark.cn';
    let lastStatus = 0;
    let lastMsg = '';
    let lastRaw: any;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const resp = await axios.get(`${baseHost}/1/clouddrive/task`, {
          params: {
            pr: 'ucpro',
            fr: 'pc',
            uc_param_str: '',
            task_id: taskId,
            retry_index: attempt,
            __t: Date.now(),
          },
          headers: this.getHeaders(customCookie),
          timeout: 5000,
        });
        const taskData = resp.data?.data;
        lastRaw = taskData;
        lastStatus = Number(taskData?.status ?? 0);
        lastMsg = String(taskData?.message || resp.data?.message || '');

        if (lastStatus === 2) {
          const topFids: string[] =
            taskData?.save_as?.save_as_top_fids ||
            taskData?.archive_unarchive?.top_fids ||
            taskData?.unarchive?.top_fids ||
            [];
          return {
            done: true,
            success: true,
            status: 2,
            message: lastMsg,
            topFids,
            rawData: taskData,
          };
        }
        if (lastStatus === 3) {
          return {
            done: true,
            success: false,
            status: 3,
            message: lastMsg || '云端任务执行失败',
            topFids: [],
            rawData: taskData,
          };
        }
      } catch (err: any) {
        lastMsg = err?.response?.data?.message || err?.message || lastMsg;
      }
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }

    return {
      done: false,
      success: false,
      inProgress: true,
      status: lastStatus,
      message: lastMsg || '云端任务仍在处理中',
      topFids: [],
      rawData: lastRaw,
    };
  }

  /**
   * 轮询异步转存任务状态并获取生成的文件/目录 fid 列表
   */
  async pollTaskTopFids(taskId: string, customCookie?: string, maxAttempts = 6): Promise<string[]> {
    const res = await this.pollTaskResult(taskId, customCookie, { maxAttempts, intervalMs: 600 });
    return res.topFids;
  }

  /**
   * 转存分享文件到用户指定分类目录（支持定制 Cookie、自定义保存根目录、文件类型巡检与智能防和谐自动还原）
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
    targetDirFid?: string;
    renamedItems?: Array<{ original: string; restored: string; reason?: string }>;
    savedItems?: QuarkFileNode[];
    fileTypeSummary?: FileTypeSummary;
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
      let shareItems: Array<{ fid: string; file_name: string; dir: boolean; size: number }> = [];
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
            shareItems.push({
              fid: item.fid,
              file_name: item.file_name,
              dir: Boolean(item.dir),
              size: Number(item.size || 0),
            });
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
        const taskId: string | undefined = saveResp.data?.data?.task_id;
        let savedTopFids: string[] = [];

        if (taskId) {
          savedTopFids = await this.pollTaskTopFids(taskId, customCookie);
        }

        // 4. 自动防和谐检测与还原更名
        if (options?.autoCleanCensor !== false) {
          try {
            await this.handlePostSaveRename(
              targetFid,
              savedTopFids,
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

        // 5. 巡检刚转存的真实文件类型（深入探测 1 层子目录），识别压缩包并记录到用户会话上下文
        let inspectedTopItems: QuarkFileNode[] = [];
        let inspectedAllItems: QuarkFileNode[] = [];
        let fileTypeSummary: FileTypeSummary | undefined;
        try {
          const inspect = await this.inspectSavedFiles(targetFid, targetPath, savedTopFids, shareItems, customCookie);
          inspectedTopItems = inspect.topItems;
          inspectedAllItems = inspect.allItems;
          fileTypeSummary = inspect.summary;
        } catch (inspErr: any) {
          console.warn('[QuarkService] 转存文件类型巡检异常:', inspErr.message);
        }

        if (fileTypeSummary && (inspectedAllItems.length > 0 || inspectedTopItems.length > 0)) {
          const sizeStr =
            fileTypeSummary.totalBytes > 0 ? `（共约 ${QuarkOrganizer.formatBytes(fileTypeSummary.totalBytes)}）` : '';
          baseMsg += `\n📦 文件类型：${fileTypeSummary.summaryLine}${sizeStr}`;

          if (fileTypeSummary.hasArchives) {
            const totalArchives = fileTypeSummary.archiveFiles.length + fileTypeSummary.fakeArchiveFiles.length;
            baseMsg += `\n⚠️ 检测到刚转存的内容包含 **${totalArchives}** 个压缩包文件。`;
            if (fileTypeSummary.fakeArchiveFiles.length > 0 && fileTypeSummary.archiveFiles.length === 0) {
              baseMsg += '\n👉 这些文件是防和谐改后缀的伪装视频，直接回复「全部解压」我就能秒帮你全部改回真实视频后缀！';
            } else {
              baseMsg += `\n👉 要全部帮你云端解压吗？直接回复「${totalArchives > 1 ? '全部解压' : '解压'}」（带密码回「全部解压 密码xxx」）就行~`;
            }
          }

          if (options?.userId) {
            SessionManager.getInstance().setRecentSaved(options.userId, {
              title: options.standardTitle || inspectedTopItems[0]?.file_name,
              targetPath,
              targetDirFid: targetFid,
              topItems: inspectedTopItems,
              allInspectedItems: inspectedAllItems,
              archiveFiles: fileTypeSummary.archiveFiles,
              fakeArchiveFiles: fileTypeSummary.fakeArchiveFiles,
              fileTypeSummary,
              awaitingUnarchiveConfirm: fileTypeSummary.hasArchives,
            });
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
          targetDirFid: targetFid,
          renamedItems,
          savedItems: inspectedAllItems.length > 0 ? inspectedAllItems : inspectedTopItems,
          fileTypeSummary,
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
   * 巡检刚转存到目标目录的真实文件（深入探测顶层子目录 1 层，精准识别嵌套压缩包与视频类型）
   */
  async inspectSavedFiles(
    targetFid: string,
    targetPath: string,
    savedTopFids: string[],
    shareItems: Array<{ fid: string; file_name: string; dir?: boolean; size?: number }>,
    customCookie?: string
  ): Promise<{
    topItems: QuarkFileNode[];
    allItems: QuarkFileNode[];
    summary: FileTypeSummary;
  }> {
    const dirItems = await this.listFilesInFolder(targetFid, customCookie, 50);
    const fidSet = new Set(savedTopFids);
    const shareNameSet = new Set(shareItems.map((s) => s.file_name));

    let topItems = dirItems.filter((item) => fidSet.has(item.fid) || shareNameSet.has(item.file_name));
    if (topItems.length === 0 && shareItems.length > 0) {
      // 若接口短暂延迟未刷新出新项，先基于分享项做静态类型兜底
      topItems = shareItems.map((s) => ({
        fid: s.fid,
        file_name: s.file_name,
        dir: Boolean(s.dir),
        size: Number(s.size || 0),
        pdir_fid: targetFid,
        path: `${targetPath}/${s.file_name}`.replace(/\/+/g, '/'),
      }));
    } else {
      topItems = topItems.map((item) => ({
        ...item,
        pdir_fid: item.pdir_fid || targetFid,
        path: `${targetPath}/${item.file_name}`.replace(/\/+/g, '/'),
      }));
    }

    const allItems: QuarkFileNode[] = [];
    let probedDirs = 0;

    for (const item of topItems) {
      if (item.dir && probedDirs < 3) {
        probedDirs++;
        const children = await this.listFilesInFolder(item.fid, customCookie, 100);
        if (children.length > 0) {
          for (const child of children) {
            const childPath = `${item.path || targetPath}/${child.file_name}`.replace(/\/+/g, '/');
            allItems.push({
              ...child,
              pdir_fid: child.pdir_fid || item.fid,
              path: childPath,
            });
          }
          // 若子目录里还套了一层子目录且无直接文件，再往下探 1 层（最多 2 个）
          const directNonDirs = children.filter((c) => !c.dir);
          if (directNonDirs.length === 0) {
            for (const subDir of children.filter((c) => c.dir).slice(0, 2)) {
              const grandChildren = await this.listFilesInFolder(subDir.fid, customCookie, 100);
              for (const gc of grandChildren) {
                allItems.push({
                  ...gc,
                  pdir_fid: gc.pdir_fid || subDir.fid,
                  path: `${item.path || targetPath}/${subDir.file_name}/${gc.file_name}`.replace(/\/+/g, '/'),
                });
              }
            }
          }
        } else {
          allItems.push(item);
        }
      } else {
        allItems.push(item);
      }
    }

    const summary = QuarkOrganizer.summarizeFileTypes(allItems.length > 0 ? allItems : topItems);
    return { topItems, allItems, summary };
  }

  /**
   * 转存后处理防和谐重命名
   */
  private async handlePostSaveRename(
    targetFid: string,
    savedTopFids: string[],
    shareItems: Array<{ fid: string; file_name: string }>,
    standardTitle?: string,
    userId?: string,
    customCookie?: string,
    renamedItems: Array<{ original: string; restored: string; reason?: string }> = []
  ): Promise<void> {
    const antiCensor = AntiCensorService.getInstance();

    // 1. 查询目标目录中的最新文件（最多取前 30 个）
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
    const targetFidSet = new Set(savedTopFids);

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
    options?: { userId?: string; customCookie?: string; standardTitle?: string }
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

  /**
   * 列出指定目录下的全部文件和子目录节点（严格区分空目录与登录凭证过期 401，size > 100 时自动翻页）
   */
  async listFilesInFolderStrict(
    folderFid = '0',
    customCookie?: string,
    size = 100
  ): Promise<{ ok: boolean; unauthorized?: boolean; items: QuarkFileNode[] }> {
    if (!this.isConfigured(customCookie)) {
      return { ok: false, unauthorized: true, items: [] };
    }
    const targetLimit = Math.min(500, Math.max(1, size));
    const pageSize = Math.min(100, targetLimit);
    const maxPages = Math.ceil(targetLimit / pageSize);
    const allItems: QuarkFileNode[] = [];

    try {
      for (let page = 1; page <= maxPages; page++) {
        const resp = await axios.get('https://drive-h.quark.cn/1/clouddrive/file/sort', {
          params: {
            pr: 'ucpro',
            fr: 'pc',
            uc_param_str: '',
            pdir_fid: folderFid,
            _page: String(page),
            _size: String(pageSize),
            _sort: 'updated_at:desc',
          },
          headers: this.getHeaders(customCookie),
          timeout: 8000,
        });
        if (resp.data?.status === 401 || resp.data?.code === 40001 || resp.data?.message?.includes('登录')) {
          return { ok: false, unauthorized: true, items: [] };
        }
        const list = resp.data?.data?.list || [];
        for (const item of list) {
          allItems.push({
            fid: item.fid,
            file_name: item.file_name,
            dir: Boolean(item.dir),
            size: Number(item.size || 0),
            pdir_fid: item.pdir_fid || folderFid,
            updated_at: Number(item.updated_at || item.l_updated_at || 0) || undefined,
          });
        }
        if (list.length < pageSize || allItems.length >= targetLimit) {
          break;
        }
      }
      return {
        ok: true,
        items: allItems.slice(0, targetLimit),
      };
    } catch (err: any) {
      const unauthorized = err.response?.status === 401 || err.response?.data?.message?.includes('登录');
      return { ok: false, unauthorized, items: [] };
    }
  }

  /**
   * 列出指定目录下的全部文件和子目录节点（含大小、更新时间与目录标志）
   */
  async listFilesInFolder(folderFid = '0', customCookie?: string, size = 100): Promise<QuarkFileNode[]> {
    const res = await this.listFilesInFolderStrict(folderFid, customCookie, size);
    return res.items;
  }

  /**
   * 按网盘路径列出目录内容并汇总文件类型
   */
  async listDirectoryByPath(
    dirPath: string = '/',
    customCookie?: string,
    size = 100
  ): Promise<{
    ok: boolean;
    unauthorized?: boolean;
    fid: string;
    path: string;
    items: QuarkFileNode[];
    summary: FileTypeSummary;
    message?: string;
  }> {
    const normalizedPath = `/${(dirPath || '/').replace(/^[\/\\]+|[\/\\]+$/g, '')}`.replace(/\/+/g, '/');
    if (!this.isConfigured(customCookie)) {
      return {
        ok: false,
        unauthorized: true,
        fid: '0',
        path: normalizedPath,
        items: [],
        summary: QuarkOrganizer.summarizeFileTypes([]),
        message: '还没有绑定夸克网盘 Cookie 哦，请先发送 `/set-quark <Cookie>` 绑定后再试。',
      };
    }

    const fid = await this.resolveExistingPathFid(normalizedPath, customCookie);
    if (!fid) {
      // 检查是否因 Cookie 过期导致找不到目录
      const probe = await this.listFilesInFolderStrict('0', customCookie, 1);
      if (probe.unauthorized) {
        this.invalidateDirCacheForScope(customCookie);
        return {
          ok: false,
          unauthorized: true,
          fid: '',
          path: normalizedPath,
          items: [],
          summary: QuarkOrganizer.summarizeFileTypes([]),
          message: '夸克网盘 Cookie 凭证已过期或未激活，请重新复制 Cookie 发送 `/set-quark <新Cookie>` 更新后再试。',
        };
      }
      return {
        ok: false,
        fid: '',
        path: normalizedPath,
        items: [],
        summary: QuarkOrganizer.summarizeFileTypes([]),
        message: `夸克网盘里没有找到目录【${normalizedPath}】`,
      };
    }

    const listed = await this.listFilesInFolderStrict(fid, customCookie, size);
    if (listed.unauthorized) {
      this.invalidateDirCacheForScope(customCookie);
      return {
        ok: false,
        unauthorized: true,
        fid,
        path: normalizedPath,
        items: [],
        summary: QuarkOrganizer.summarizeFileTypes([]),
        message: '夸克网盘 Cookie 凭证已过期或未激活，请重新复制 Cookie 发送 `/set-quark <新Cookie>` 更新后再试。',
      };
    }
    const items = listed.items.map((it) => ({
      ...it,
      pdir_fid: it.pdir_fid || fid,
      path: `${normalizedPath === '/' ? '' : normalizedPath}/${it.file_name}`.replace(/\/+/g, '/'),
    }));
    return {
      ok: true,
      fid,
      path: normalizedPath,
      items,
      summary: QuarkOrganizer.summarizeFileTypes(items),
    };
  }

  /**
   * 按关键词全盘搜索夸克网盘文件（主走 file/search 接口，失败时自动降级为工作区目录扫描）
   */
  async searchFiles(
    keyword: string = '',
    options?: {
      customCookie?: string;
      size?: number;
      archivesOnly?: boolean;
      rootDir?: string;
    }
  ): Promise<QuarkFileNode[]> {
    const customCookie = options?.customCookie;
    if (!this.isConfigured(customCookie)) return [];

    const query = (keyword || '').trim();
    const size = Math.min(500, Math.max(10, options?.size || 200));
    const archivesOnly = Boolean(options?.archivesOnly);

    const filterArchive = (nodes: QuarkFileNode[]) =>
      archivesOnly
        ? nodes.filter(
            (n) => !n.dir && (QuarkOrganizer.isArchiveFile(n.file_name) || Boolean(QuarkOrganizer.detectFakeArchiveVideo(n.file_name)))
          )
        : nodes;

    const cleanFileName = (raw: string) => String(raw || '').replace(/<\/?em>/gi, '').trim();

    if (query) {
      const endpoints = [
        'https://drive-pc.quark.cn/1/clouddrive/file/search',
        'https://drive-h.quark.cn/1/clouddrive/file/search',
      ];
      const pageSize = Math.min(100, size);
      const maxPages = Math.min(5, Math.ceil(size / pageSize));
      for (const endpoint of endpoints) {
        try {
          const allMapped: QuarkFileNode[] = [];
          let apiOk = false;
          for (let page = 1; page <= maxPages; page++) {
            const resp = await axios.get(endpoint, {
              params: {
                pr: 'ucpro',
                fr: 'pc',
                uc_param_str: '',
                q: query,
                _page: String(page),
                _size: String(pageSize),
                _fetch_total: '1',
                _sort: 'file_type:desc,updated_at:desc',
                _is_hl: '0',
              },
              headers: this.getHeaders(customCookie),
              timeout: 8000,
            });
            const list = resp.data?.data?.list;
            if (!Array.isArray(list)) break;
            apiOk = true;
            for (const item of list) {
              allMapped.push({
                fid: item.fid,
                file_name: cleanFileName(item.file_name),
                dir: Boolean(item.dir),
                size: Number(item.size || 0),
                pdir_fid: item.pdir_fid || '0',
                updated_at: Number(item.updated_at || item.l_updated_at || 0) || undefined,
              });
            }
            if (list.length < pageSize || allMapped.length >= size) break;
          }
          if (apiOk) {
            const filtered = filterArchive(allMapped).slice(0, size);
            if (filtered.length > 0 || allMapped.length === 0) {
              return filtered;
            }
          }
        } catch {}
      }
    }

    // 无关键词扫全盘压缩包，或 file/search 接口异常时：扫描根目录 + 保存根目录及分类子目录（最多 3 层、80 个目录）
    const baseDir = options?.rootDir || this.defaultRootDir;
    const collected: QuarkFileNode[] = [];
    const visited = new Set<string>();
    const lowerQ = query.toLowerCase();

    const scanFolder = async (fid: string, pathPrefix: string, depth: number) => {
      if (!fid || visited.has(fid) || visited.size >= 80) return;
      visited.add(fid);
      const children = await this.listFilesInFolder(fid, customCookie, 200);
      for (const c of children) {
        const fullPath = `${pathPrefix === '/' ? '' : pathPrefix}/${c.file_name}`.replace(/\/+/g, '/');
        const node: QuarkFileNode = { ...c, pdir_fid: c.pdir_fid || fid, path: fullPath };
        const matchQ = !lowerQ || node.file_name.toLowerCase().includes(lowerQ) || fullPath.toLowerCase().includes(lowerQ);
        if (matchQ) {
          collected.push(node);
        }
        if (c.dir && depth > 0 && visited.size < 80) {
          await scanFolder(c.fid, fullPath, depth - 1);
        }
      }
    };

    const rootFid = await this.resolveExistingPathFid(baseDir, customCookie);
    if (rootFid && rootFid !== '0') {
      await scanFolder(rootFid, baseDir, 3);
    }
    await scanFolder('0', '/', 2);

    // 按 fid 去重
    const uniq = new Map<string, QuarkFileNode>();
    for (const item of collected) {
      if (!uniq.has(item.fid)) uniq.set(item.fid, item);
    }
    return filterArchive(Array.from(uniq.values())).slice(0, size);
  }

  /**
   * 删除指定文件或文件夹（移入回收站），返回详细结果
   */
  async deleteFilesDetailed(
    fids: string[],
    customCookie?: string
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConfigured(customCookie)) {
      return { success: false, message: '未配置夸克 Cookie' };
    }
    if (fids.length === 0) {
      return { success: false, message: '未指定要删除的文件' };
    }
    try {
      const resp = await axios.post(
        'https://drive-h.quark.cn/1/clouddrive/file/delete?pr=ucpro&fr=pc',
        { action_type: 2, filelist: fids, exclude_fids: [] },
        { headers: this.getHeaders(customCookie), timeout: 8000 }
      );
      if (resp.data?.status === 200 || resp.data?.code === 0 || resp.data?.data?.task_id) {
        this.invalidateDirCacheForScope(customCookie);
        return { success: true };
      }
      return { success: false, message: resp.data?.message || '删除失败' };
    } catch (err: any) {
      return { success: false, message: err.response?.data?.message || err.message || '删除请求异常' };
    }
  }

  /**
   * 删除指定文件或文件夹（移入回收站）
   */
  async deleteFiles(fids: string[], customCookie?: string): Promise<boolean> {
    const res = await this.deleteFilesDetailed(fids, customCookie);
    return res.success;
  }

  /**
   * 云端在线解压单个压缩包（若检测到防和谐伪装视频后缀，自动秒级重命名还原）
   */
  async unarchiveFile(
    file: Pick<QuarkFileNode, 'fid' | 'file_name' | 'pdir_fid'>,
    options?: {
      toPdirFid?: string;
      toDirPath?: string;
      password?: string;
      customCookie?: string;
      deleteAfter?: boolean;
      conflictMode?: number;
      maxPollAttempts?: number;
    }
  ): Promise<QuarkUnarchiveResult> {
    const customCookie = options?.customCookie;
    if (!this.isConfigured(customCookie)) {
      return {
        success: false,
        mode: 'failed',
        sourceFile: file.file_name,
        message: '还没有绑定夸克网盘 Cookie，请先发 `/set-quark <Cookie>` 绑定后再试。',
      };
    }

    // 1. 优先检测防和谐“假压缩包”后缀（如 movie.mp4.zip），直接改回真实视频后缀，免会员秒完成
    const fakeInfo = QuarkOrganizer.detectFakeArchiveVideo(file.file_name);
    if (fakeInfo) {
      const ren = await this.renameFile(file.fid, fakeInfo.restoredName, customCookie);
      if (ren.success) {
        return {
          success: true,
          mode: 'fake_ext_renamed',
          sourceFile: file.file_name,
          restoredName: fakeInfo.restoredName,
          targetDirFid: file.pdir_fid || '0',
          extractedCount: 1,
          message: `✨ 「${file.file_name}」其实是防和谐改后缀的伪装视频，已直接改回真实文件名：「${fakeInfo.restoredName}」，可以直接播放啦！`,
        };
      }
      return {
        success: false,
        mode: 'failed',
        sourceFile: file.file_name,
        message: `尝试还原伪装后缀「${file.file_name}」失败：${ren.message || '重命名出错'}`,
      };
    }

    // 2. 解析解压目标目录 FID
    let targetPdirFid = options?.toPdirFid || file.pdir_fid || '0';
    if (options?.toDirPath) {
      const resolved = await this.ensureDirectoryPath(options.toDirPath, customCookie);
      if (resolved) targetPdirFid = resolved;
    }

    const password = (options?.password ?? QuarkOrganizer.extractArchivePasswordHint(file.file_name) ?? '').trim();
    const payload = {
      fid: file.fid,
      to_pdir_fid: targetPdirFid,
      conflict_mode: options?.conflictMode ?? 3,
      suffix_type: 0,
      pwd: password,
      select_mode: 0,
    };

    const translateUnarchiveError = (rawMsg: string, code?: number, httpStatus?: number): {
      message: string;
      needPassword?: boolean;
      needVip?: boolean;
      concurrentLimit?: boolean;
    } => {
      const text = rawMsg || '';
      if (httpStatus === 401 || code === 40001 || /登录|未授权/.test(text)) {
        this.invalidateDirCacheForScope(customCookie);
        return {
          message: '夸克 Cookie 凭证已过期，请发 `/set-quark <新Cookie>` 更新后再试。',
        };
      }
      if (/密码|pwd|password|加密|encrypt/i.test(text)) {
        return {
          needPassword: true,
          message: `压缩包「${file.file_name}」需要解压密码${password ? '（刚才提供的密码不对）' : ''}，请直接回复「解压 密码xxx」再试~`,
        };
      }
      if (/concurrent|并发|task\s*limit|too\s*many|频繁|排队|正在解压/i.test(text)) {
        return {
          concurrentLimit: true,
          message: `「${file.file_name}」因夸克云端同时解压任务数达上限暂未提交成功（${text}），稍等几秒重试即可。`,
        };
      }
      if (/vip|svip|会员|权益|上限|超过|太大|容量|空间不足|size|limit/i.test(text)) {
        return {
          needVip: true,
          message: `夸克云端在线解压「${file.file_name}」受账号会员权益或体积限制（${text || '需 VIP/SVIP 会员'}），建议升级会员或用电脑端解压。`,
        };
      }
      if (/损坏|corrupt|不支持|unsupported|格式|分卷/i.test(text)) {
        return {
          message: `压缩包「${file.file_name}」无法云端解压（${text}），可能是格式不支持、分卷不全或文件损坏。`,
        };
      }
      return {
        message: `云端解压「${file.file_name}」失败：${text || `接口返回异常 (code=${code ?? httpStatus ?? 'unknown'})`}`,
      };
    };

    const hosts = ['https://drive-pc.quark.cn', 'https://drive-h.quark.cn'];
    let lastResp: any = null;
    let lastHost = hosts[0];
    let lastErr: any = null;

    for (const host of hosts) {
      lastHost = host;
      try {
        const resp = await axios.post(`${host}/1/clouddrive/archive/unarchive`, payload, {
          params: {
            pr: 'ucpro',
            fr: 'pc',
            uc_param_str: '',
          },
          headers: this.getHeaders(customCookie),
          timeout: 12000,
        });
        lastResp = resp;
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        // 400/403/401 等明确业务错误无需换域名重试
        if (err.response && err.response.status < 500) {
          break;
        }
      }
    }

    if (lastErr && !lastResp) {
      const errData = lastErr.response?.data;
      const translated = translateUnarchiveError(
        String(errData?.message || lastErr.message || ''),
        errData?.code,
        lastErr.response?.status
      );
      return {
        success: false,
        mode: 'failed',
        sourceFile: file.file_name,
        needPassword: translated.needPassword,
        needVip: translated.needVip,
        concurrentLimit: translated.concurrentLimit,
        message: translated.message,
      };
    }

    const body = lastResp?.data || {};
    const status = body.status;
    const code = body.code;
    const taskId: string | undefined = body.data?.task_id;

    if (taskId) {
      const poll = await this.pollTaskResult(taskId, customCookie, {
        maxAttempts: options?.maxPollAttempts ?? 12,
        intervalMs: 750,
        baseHost: lastHost,
      });

      if (poll.success) {
        let deletedOriginal = false;
        if (options?.deleteAfter) {
          deletedOriginal = await this.deleteFiles([file.fid], customCookie);
        }
        const delHint = deletedOriginal ? '（原压缩包已移入回收站）' : '';
        return {
          success: true,
          mode: 'cloud_unarchive',
          sourceFile: file.file_name,
          targetDirFid: targetPdirFid,
          extractedCount: poll.topFids.length || undefined,
          deletedOriginal,
          message: `✅ 「${file.file_name}」已在夸克云端解压完成！${delHint}`,
        };
      }

      if (poll.inProgress) {
        return {
          success: true,
          inProgress: true,
          mode: 'cloud_unarchive',
          sourceFile: file.file_name,
          targetDirFid: targetPdirFid,
          message: `⏳ 「${file.file_name}」云端解压任务已提交，文件较大正在夸克后台解压中，稍等一会儿打开网盘就能看到啦~`,
        };
      }

      const translated = translateUnarchiveError(poll.message || '', code, status);
      return {
        success: false,
        mode: 'failed',
        sourceFile: file.file_name,
        needPassword: translated.needPassword,
        needVip: translated.needVip,
        concurrentLimit: translated.concurrentLimit,
        message: translated.message,
      };
    }

    if (status === 200 || code === 0) {
      let deletedOriginal = false;
      if (options?.deleteAfter) {
        deletedOriginal = await this.deleteFiles([file.fid], customCookie);
      }
      const delHint = deletedOriginal ? '（原压缩包已移入回收站）' : '';
      return {
        success: true,
        mode: 'cloud_unarchive',
        sourceFile: file.file_name,
        targetDirFid: targetPdirFid,
        deletedOriginal,
        message: `✅ 「${file.file_name}」已在夸克云端解压完成！${delHint}`,
      };
    }

    const translated = translateUnarchiveError(String(body.message || ''), code, status);
    return {
      success: false,
      mode: 'failed',
      sourceFile: file.file_name,
      needPassword: translated.needPassword,
      needVip: translated.needVip,
      concurrentLimit: translated.concurrentLimit,
      message: translated.message,
    };
  }

  /**
   * 批量云端解压多个压缩包（默认串行防撞并发槽位上限，遇 concurrent task limit 自动退避重试，并返回失败项供一键补解）
   */
  async unarchiveFilesBatch(
    files: Array<Pick<QuarkFileNode, 'fid' | 'file_name' | 'pdir_fid'>>,
    options?: {
      toPdirFid?: string;
      toDirPath?: string;
      password?: string;
      customCookie?: string;
      deleteAfter?: boolean;
      maxCount?: number;
      concurrency?: number;
      retryDelaysMs?: number[];
    }
  ): Promise<{
    results: QuarkUnarchiveResult[];
    failedFiles: Array<Pick<QuarkFileNode, 'fid' | 'file_name' | 'pdir_fid'>>;
    skippedSplitParts: string[];
    successCount: number;
    inProgressCount: number;
    failCount: number;
  }> {
    const maxCount = options?.maxCount ?? 500;
    const skippedSplitParts: string[] = [];
    const queue: Array<Pick<QuarkFileNode, 'fid' | 'file_name' | 'pdir_fid'>> = [];

    for (const f of files) {
      if (QuarkOrganizer.isNonFirstSplitPart(f.file_name)) {
        skippedSplitParts.push(f.file_name);
        continue;
      }
      queue.push(f);
    }

    const targets = queue.slice(0, maxCount);
    const isLargeBatch = targets.length > 3;
    // 夸克服务端对同时运行的云端解压任务槽位有严格并发限制（通常 1~2 个），默认串行最稳妥
    const concurrency = Math.max(1, Math.min(2, options?.concurrency ?? 1));
    const retryDelays = options?.retryDelaysMs ?? [2500, 4000, 6000, 8000];
    const singleOpts = {
      ...options,
      // 批量解压时适度轮询让快速完成的包立即释放并发槽位，超大包则记为后台运行不阻塞
      maxPollAttempts: isLargeBatch ? 4 : 12,
    };

    const runWithConcurrentRetry = async (
      item: Pick<QuarkFileNode, 'fid' | 'file_name' | 'pdir_fid'>
    ): Promise<QuarkUnarchiveResult> => {
      let res = await this.unarchiveFile(item, singleOpts);
      for (const delayMs of retryDelays) {
        if (!res.concurrentLimit) break;
        await new Promise((r) => setTimeout(r, delayMs));
        res = await this.unarchiveFile(item, singleOpts);
      }
      return res;
    };

    const results: QuarkUnarchiveResult[] = [];
    const failedFiles: Array<Pick<QuarkFileNode, 'fid' | 'file_name' | 'pdir_fid'>> = [];
    let aborted = false;

    for (let i = 0; i < targets.length && !aborted; i += concurrency) {
      const chunk = targets.slice(i, i + concurrency);
      const chunkRes = await Promise.all(chunk.map((item) => runWithConcurrentRetry(item)));
      for (let j = 0; j < chunkRes.length; j++) {
        const res = chunkRes[j];
        const item = chunk[j];
        results.push(res);
        if (!res.success) {
          failedFiles.push(item);
        }
        // 若触发密码错误或 Cookie 过期，提前中止后续批次避免连续报错
        if (res.needPassword || res.message.includes('Cookie')) {
          aborted = true;
        }
      }
    }

    const successCount = results.filter((r) => r.success && !r.inProgress).length;
    const inProgressCount = results.filter((r) => r.success && r.inProgress).length;
    const failCount = results.filter((r) => !r.success).length;

    return {
      results,
      failedFiles,
      skippedSplitParts,
      successCount,
      inProgressCount,
      failCount,
    };
  }

  /**
   * 按 Emby / Infuse / VidHub 规范整理并标准化媒体库文件名
   */
  async organizeMediaLibrary(
    userRootDir?: string,
    options?: { customCookie?: string; dryRun?: boolean }
  ): Promise<{ scannedFolders: number; renamed: Array<{ from: string; to: string }> }> {
    const customCookie = options?.customCookie;
    const baseDir = userRootDir || this.defaultRootDir;
    const renamed: Array<{ from: string; to: string }> = [];
    let scannedFolders = 0;

    if (!this.isConfigured(customCookie)) {
      return { scannedFolders, renamed };
    }

    const rootFid = await this.resolveExistingPathFid(baseDir, customCookie);
    if (!rootFid) return { scannedFolders, renamed };

    const catFolders = await this.getFolderList(rootFid, customCookie);
    for (const cat of catFolders.slice(0, 10)) {
      scannedFolders++;
      const subFolders = await this.getFolderList(cat.cid, customCookie);
      for (const mediaDir of subFolders.slice(0, 15)) {
        scannedFolders++;
        const yearMatch = mediaDir.name.match(/\b(19\d{2}|20\d{2})\b/);
        const standardTitle = mediaDir.name.replace(/[《》]|\(\d{4}\)/g, '').trim();
        const files = await this.listFilesInFolder(mediaDir.cid, customCookie, 80);

        for (const f of files) {
          if (f.dir || !QuarkOrganizer.isVideoFile(f.file_name)) continue;
          const targetName = QuarkOrganizer.formatEmbyMediaName(f.file_name, standardTitle, yearMatch?.[1]);
          if (targetName && targetName !== f.file_name) {
            if (!options?.dryRun) {
              const ok = await this.renameFile(f.fid, targetName, customCookie);
              if (ok.success) {
                renamed.push({ from: f.file_name, to: targetName });
              }
            } else {
              renamed.push({ from: f.file_name, to: targetName });
            }
          }
        }
      }
    }

    return { scannedFolders, renamed };
  }

  /**
   * 扫描网盘分类目录下的重复影视资源（同名多清晰度或重复转存），支持预览或自动删除低清晰度冗余副本
   */
  async scanAndCleanDuplicates(
    userRootDir?: string,
    options?: { customCookie?: string; executeDelete?: boolean }
  ): Promise<{
    scannedCount: number;
    groups: DuplicateGroup[];
    deletedCount: number;
    reclaimedBytes: number;
  }> {
    const customCookie = options?.customCookie;
    const baseDir = userRootDir || this.defaultRootDir;
    const allGroups: DuplicateGroup[] = [];
    let scannedCount = 0;
    let deletedCount = 0;
    let reclaimedBytes = 0;

    if (!this.isConfigured(customCookie)) {
      return { scannedCount, groups: allGroups, deletedCount, reclaimedBytes };
    }

    const rootFid = await this.resolveExistingPathFid(baseDir, customCookie);
    if (!rootFid) return { scannedCount, groups: allGroups, deletedCount, reclaimedBytes };

    const catFolders = await this.getFolderList(rootFid, customCookie);
    for (const cat of catFolders.slice(0, 10)) {
      const files = await this.listFilesInFolder(cat.cid, customCookie, 100);
      scannedCount += files.length;
      const dirGroups = QuarkOrganizer.findDuplicateGroups(files);
      allGroups.push(...dirGroups);

      if (options?.executeDelete && dirGroups.length > 0) {
        const toDelFids = dirGroups.flatMap((g) => g.duplicates.map((d) => d.fid));
        if (toDelFids.length > 0 && (await this.deleteFiles(toDelFids, customCookie))) {
          deletedCount += toDelFids.length;
          reclaimedBytes += dirGroups.reduce((acc, g) => acc + g.reclaimableBytes, 0);
        }
      }
    }

    return { scannedCount, groups: allGroups, deletedCount, reclaimedBytes };
  }
}
