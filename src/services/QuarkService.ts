import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { ResourceCategory } from '../types';
import { AntiCensorService } from './AntiCensorService';

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
  private dirCache: Map<string, string> = new Map();

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
      let content = '';
      if (fs.existsSync(this.envPath)) {
        content = fs.readFileSync(this.envPath, 'utf8');
      }
      const regex = /^QUARK_COOKIE=.*/m;
      if (regex.test(content)) {
        content = content.replace(regex, `QUARK_COOKIE=${this.cookie}`);
      } else {
        content += `\nQUARK_COOKIE=${this.cookie}\n`;
      }
      fs.writeFileSync(this.envPath, content, 'utf8');
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
   * 获取目录列表
   */
  async getFolderList(parentCid = '0', customCookie?: string): Promise<QuarkFolderItem[]> {
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

      if (response.data?.data?.list) {
        return response.data.data.list
          .filter((item: any) => item.dir)
          .map((item: any) => ({
            cid: item.fid,
            name: item.file_name,
          }));
      }
      return [];
    } catch (err: any) {
      console.error('[QuarkService] 获取文件夹列表失败:', err.message);
      return [];
    }
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

  /**
   * 递归解析并自动逐层创建多级路径，返回最底层目录 FID
   * 例如 "/我的资源/MI/电影"，会依次定位或创建 "我的资源" -> "MI" -> "电影"
   */
  async ensureDirectoryPath(fullPath: string, customCookie?: string): Promise<string> {
    const cacheKey = `${customCookie ? 'custom' : 'default'}:${fullPath}`;
    if (this.dirCache.has(cacheKey)) {
      return this.dirCache.get(cacheKey)!;
    }

    const segments = fullPath
      .replace(/^[\/\\]+|[\/\\]+$/g, '')
      .split(/[\/\\]+/)
      .filter(Boolean);

    let currentFid = '0';
    let currentPath = '';

    for (const segment of segments) {
      currentPath += `/${segment}`;
      const subCacheKey = `${customCookie ? 'custom' : 'default'}:${currentPath}`;
      if (this.dirCache.has(subCacheKey)) {
        currentFid = this.dirCache.get(subCacheKey)!;
        continue;
      }

      const folders = await this.getFolderList(currentFid, customCookie);
      const found = folders.find((f) => f.name === segment);

      if (found) {
        currentFid = found.cid;
      } else {
        const newFid = await this.createFolder(currentFid, segment, customCookie);
        if (newFid) {
          currentFid = newFid;
        } else {
          console.warn(`[QuarkService] 创建子目录【${segment}】失败 (父节点: ${currentFid})`);
          break;
        }
      }
      this.dirCache.set(subCacheKey, currentFid);
    }

    this.dirCache.set(cacheKey, currentFid);
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
  async pollTaskTopFids(taskId: string, customCookie?: string, maxAttempts = 3): Promise<string[]> {
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
        if (taskData?.status === 2 && taskData?.save_as?.save_as_top_fids) {
          return taskData.save_as.save_as_top_fids;
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

      // 2. 获取分享文件列表
      let fid_list: string[] = [];
      let fid_token_list: string[] = [];
      let shareItems: Array<{ fid: string; file_name: string }> = [];
      try {
        const dResp = await axios.get('https://drive-h.quark.cn/1/clouddrive/share/sharepage/detail', {
          params: {
            pr: 'ucpro',
            fr: 'pc',
            pwd_id: pwdId,
            stoken: stoken,
            pdir_fid: '0',
            _page: '1',
            _size: '50',
          },
          headers: this.getHeaders(customCookie),
          timeout: 8000,
        });

        const list = dResp.data?.data?.list || [];
        if (list.length > 0) {
          fid_list = list.map((item: any) => item.fid);
          fid_token_list = list.map((item: any) => item.share_fid_token);
          shareItems = list.map((item: any) => ({ fid: item.fid, file_name: item.file_name }));
        }
      } catch {}

      if (fid_list.length === 0) {
        fid_list = [pwdId];
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
      return {
        success: false,
        message: `转存接口返回: ${msg} (状态码: ${status || code})`,
        targetPath,
      };
    } catch (err: any) {
      if (err.response?.status === 401 || err.response?.data?.message?.includes('登录')) {
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

    const fileList: Array<{ fid: string; file_name: string }> = sortResp.data?.data?.list || [];
    const shareNameSet = new Set(shareItems.map((s) => s.file_name));
    const targetFidSet = new Set(targetFids);

    // 候选文件：命中 task_id top_fids 或者文件名与分享项一致的文件
    const candidates = fileList.filter((f) => targetFidSet.has(f.fid) || shareNameSet.has(f.file_name));

    for (const item of candidates) {
      const checkRes = await antiCensor.restoreTitle(item.file_name, standardTitle, userId);
      if (checkRes.isHarmonized && checkRes.restoredName && checkRes.restoredName !== item.file_name) {
        const renameRes = await this.renameFile(item.fid, checkRes.restoredName, customCookie);
        if (renameRes.success) {
          renamedItems.push({
            original: item.file_name,
            restored: checkRes.restoredName,
            reason: checkRes.reason,
          });
        }
      }
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
}
