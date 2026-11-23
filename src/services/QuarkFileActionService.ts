import * as path from 'path';
import { QuarkService, QuarkUnarchiveResult } from './QuarkService';
import { QuarkFileNode, QuarkOrganizer } from './QuarkOrganizer';
import { SessionManager, RecentSavedSession } from './SessionManager';
import { UserManager } from './UserManager';

export type QuarkFileActionType =
  | 'list'
  | 'search'
  | 'recent_saved'
  | 'unarchive'
  | 'rename'
  | 'delete'
  | 'move'
  | 'mkdir'
  | 'clean_censor'
  | 'organize'
  | 'dedup';

export interface QuarkFileActionInput {
  action: QuarkFileActionType;
  target_scope?: 'recent_saved' | 'search' | 'index' | 'path';
  query?: string;
  path?: string;
  index?: number;
  indices?: number[];
  new_name?: string;
  to_dir?: string;
  password?: string;
  delete_after?: boolean;
  archives_only?: boolean;
  all_matches?: boolean;
  execute_delete?: boolean;
  dry_run?: boolean;
}

export interface QuickUnarchiveIntent {
  kind: 'confirm' | 'decline';
  password?: string;
  deleteAfter?: boolean;
}

/**
 * 夸克网盘文件管理与云端解压统一编排服务（供 DeepSeekAgent 工具调用、快捷回复与斜杠命令共用）
 */
export class QuarkFileActionService {
  private quarkService: QuarkService;
  private userManager: UserManager;
  private sessionManager: SessionManager;

  constructor(quarkService?: QuarkService, userManager?: UserManager, sessionManager?: SessionManager) {
    this.quarkService = quarkService || new QuarkService();
    this.userManager = userManager || UserManager.getInstance();
    this.sessionManager = sessionManager || SessionManager.getInstance();
  }

  /**
   * 识别“待解压压缩包提醒”后的快捷确认/拒绝回复（支持“全部解压”“19个全部解压”“全部”“解压 密码xxx”等）
   */
  static parseQuickUnarchiveIntent(text: string, awaitingConfirm: boolean): QuickUnarchiveIntent | null {
    if (!awaitingConfirm) return null;
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.startsWith('/')) return null;

    if (/^(?:不用|不用了|不解压|先不解|先不用|不需要|算了|取消|不要|no|cancel)[!！。.~～]*$/i.test(trimmed)) {
      return { kind: 'decline' };
    }

    const deleteAfter = /(?:删掉?原|删除原|顺便删|解完删|删压缩包)/.test(trimmed);

    // 1. 纯确认词、全量确认词或补解重试词（如“全部解压”“19个全部解压”“全部”“重试”“继续解压”“补解”“好的”）
    if (
      /^(?:(?:\d+\s*个)?(?:全部|全都|全|都|所有)?(?:帮我)?(?:云端|直接)?解压(?:全部|吧|一下|完)?|全部(?:\d+\s*个)?(?:都)?(?:解压|解)?|重试(?:解压)?|继续(?:解压)?|补解(?:一下)?|再试一次|把失败的(?:都)?解压|解压失败的|解一下|开始解压|要|要的|需要|好|好的|好呀|可以|行|嗯|嗯嗯|ok|yes)(?:并删除原(?:文件|压缩包|包)|顺便删(?:掉|了)?原(?:文件|压缩包|包))?[!！。.~～]*$/i.test(
        trimmed
      )
    ) {
      return { kind: 'confirm', deleteAfter };
    }

    // 2. 带密码的快捷确认（如“全部解压 密码1234”、“解压 密码1234”、“密码是1234”、“密码：abc”）
    const explicitPwd = QuarkOrganizer.extractArchivePasswordHint(trimmed);
    if (
      explicitPwd &&
      /^(?:(?:\d+\s*个)?(?:全部|全都|全|都)?(?:帮我)?(?:直接|云端)?解压|全部|好的?|要|密码|解压密码|解压码|口令|pwd)/i.test(
        trimmed
      )
    ) {
      return { kind: 'confirm', password: explicitPwd, deleteAfter };
    }

    const barePwdMatch = trimmed.match(/^(?:(?:\d+\s*个)?(?:全部|全)?(?:帮我)?(?:云端)?解压|全部)\s+([A-Za-z0-9._@#\-!$%^&*]{1,32})$/i);
    if (barePwdMatch && barePwdMatch[1]) {
      return { kind: 'confirm', password: barePwdMatch[1], deleteAfter };
    }

    return null;
  }

  private normalizePath(rawPath: string | undefined, defaultRootDir: string): string {
    const clean = (rawPath || '').trim();
    if (!clean || clean === '根目录' || clean === '顶层' || clean === '/') {
      return '/';
    }
    if (clean.startsWith('/')) {
      return clean.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    }
    if (clean === '默认目录' || clean === '保存目录') {
      return defaultRootDir;
    }
    return `/${clean}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }

  private formatNodeLine(node: QuarkFileNode, seq: number): string {
    const icon = QuarkOrganizer.getFileIcon(node);
    const sizeText = !node.dir && node.size && node.size > 0 ? ` · ${QuarkOrganizer.formatBytes(node.size)}` : '';
    const fakeInfo = !node.dir ? QuarkOrganizer.detectFakeArchiveVideo(node.file_name) : null;
    const tag = fakeInfo
      ? ' [疑似伪装后缀]'
      : !node.dir && QuarkOrganizer.isArchiveFile(node.file_name)
      ? ' [压缩包]'
      : '';
    const loc = node.path ? `\n   📍 ${node.path}` : '';
    return `**${seq}.** ${icon} ${node.file_name}${sizeText}${tag}${loc}`;
  }

  private pickFromListing(userId: string, index?: number, indices?: number[]): QuarkFileNode[] {
    const listing = this.sessionManager.getNetdiskListing(userId);
    if (!listing || listing.items.length === 0) return [];
    const reqIndices =
      Array.isArray(indices) && indices.length > 0
        ? indices
        : typeof index === 'number' && index > 0
        ? [index]
        : [];
    const out: QuarkFileNode[] = [];
    for (const i of reqIndices) {
      const idx = Math.floor(i) - 1;
      if (idx >= 0 && idx < listing.items.length) {
        out.push(listing.items[idx]);
      }
    }
    return out;
  }

  private async resolveNodeByExactPath(
    fullPath: string,
    customCookie?: string
  ): Promise<{ node?: QuarkFileNode; parentFid?: string; parentPath?: string }> {
    const normalized = this.normalizePath(fullPath, this.quarkService.getDefaultRootDir());
    if (normalized === '/') {
      return {
        node: { fid: '0', file_name: '/', dir: true, pdir_fid: '0', path: '/' },
        parentFid: '0',
        parentPath: '/',
      };
    }

    const dirName = path.posix.dirname(normalized);
    const baseName = path.posix.basename(normalized);
    const parentFid = await this.quarkService.resolveExistingPathFid(dirName, customCookie);
    if (!parentFid) return {};

    const siblings = await this.quarkService.listFilesInFolder(parentFid, customCookie, 100);
    const exact =
      siblings.find((s) => s.file_name === baseName) ||
      siblings.find((s) => s.file_name.toLowerCase() === baseName.toLowerCase());
    if (exact) {
      return {
        node: { ...exact, pdir_fid: exact.pdir_fid || parentFid, path: normalized },
        parentFid,
        parentPath: dirName,
      };
    }
    return { parentFid, parentPath: dirName };
  }

  private async resolveTargetNodes(
    userId: string,
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<{ nodes: QuarkFileNode[]; sourceLabel: string }> {
    // 1. 按列表序号定位
    if (
      input.target_scope === 'index' ||
      (typeof input.index === 'number' && input.index > 0) ||
      (Array.isArray(input.indices) && input.indices.length > 0)
    ) {
      const picked = this.pickFromListing(userId, input.index, input.indices);
      return { nodes: picked, sourceLabel: '当前列表序号' };
    }

    // 2. 刚转存的文件
    if (input.target_scope === 'recent_saved') {
      const recent = this.sessionManager.getRecentSaved(userId);
      if (!recent) return { nodes: [], sourceLabel: '最近转存' };
      const list = recent.topItems.length > 0 ? recent.topItems : recent.allInspectedItems;
      return { nodes: list, sourceLabel: `刚转存的【${recent.targetPath}】` };
    }

    // 3. 明确网盘路径
    if (input.target_scope === 'path' || (input.path && input.path.includes('/'))) {
      const resolved = await this.resolveNodeByExactPath(input.path || '', customCookie);
      if (resolved.node) {
        return { nodes: [resolved.node], sourceLabel: `路径 ${input.path}` };
      }
      return { nodes: [], sourceLabel: `路径 ${input.path}` };
    }

    // 4. 关键词搜索
    const query = (input.query || input.path || '').trim();
    if (query) {
      const found = await this.quarkService.searchFiles(query, {
        customCookie,
        rootDir,
        size: 30,
      });
      return { nodes: found, sourceLabel: `关键词「${query}」` };
    }

    return { nodes: [], sourceLabel: '未指定目标' };
  }

  private formatArchiveCountPrompt(items: QuarkFileNode[], targetHint?: string): string {
    const summary = QuarkOrganizer.summarizeFileTypes(items);
    const totalCount = items.length;
    const sizeText = summary.totalBytes > 0 ? `，共约 ${QuarkOrganizer.formatBytes(summary.totalBytes)}` : '';
    const scopeText = targetHint ? `在 ${targetHint} 中` : '在你的夸克网盘中';

    if (summary.fakeArchiveFiles.length > 0 && summary.archiveFiles.length === 0) {
      return [
        `📦 ${scopeText}共找到 **${totalCount}** 个防和谐伪装后缀文件（${summary.summaryLine}${sizeText}）。`,
        `👉 要全部帮你改回真实视频后缀吗？直接回复 **「全部解压」** 就行~`,
      ].join('\n');
    }

    return [
      `📦 ${scopeText}共找到 **${totalCount}** 个压缩包文件（${summary.summaryLine}${sizeText}）。`,
      `👉 要全部帮你云端解压吗？直接回复 **「全部解压」**（带密码回 **「全部解压 密码xxx」**）就能一口气解压全部 ${totalCount} 个~`,
    ].join('\n');
  }

  private formatUnarchiveBatchReply(
    batch: {
      results: QuarkUnarchiveResult[];
      skippedSplitParts: string[];
      successCount: number;
      inProgressCount: number;
      failCount: number;
    },
    targetHint?: string
  ): string {
    const totalProcessed = batch.results.length;
    if (totalProcessed === 1) {
      const singleMsg = batch.results[0].message;
      if (batch.skippedSplitParts.length > 0) {
        return `${singleMsg}\n💡 已自动跳过 ${batch.skippedSplitParts.length} 个后续分卷文件（由首个分卷统一解压）。`;
      }
      return singleMsg;
    }

    const totalAll = totalProcessed + batch.skippedSplitParts.length;
    const parts: string[] = [];
    if (batch.successCount > 0) parts.push(`已完成 **${batch.successCount}** 个`);
    if (batch.inProgressCount > 0) parts.push(`已提交夸克云端后台解压 **${batch.inProgressCount}** 个`);
    if (batch.failCount > 0) parts.push(`失败 **${batch.failCount}** 个`);

    const lines: string[] = [
      `📦 全部 **${totalAll}** 个压缩包已处理${targetHint ? `（${targetHint}）` : ''}：${parts.join('，')}。`,
    ];

    if (batch.inProgressCount > 0) {
      lines.push('⏳ 云端后台解压中的文件稍等片刻直接在夸克网盘里就能看到啦~');
    }
    if (batch.failCount > 0) {
      const failResults = batch.results.filter((r) => !r.success);
      const failReasons = Array.from(new Set(failResults.map((r) => r.message))).slice(0, 3);
      for (const reason of failReasons) {
        lines.push(`• ${reason}`);
      }
      const needPwdOrCookie = failResults.some((r) => r.needPassword || r.message.includes('Cookie'));
      if (!needPwdOrCookie) {
        lines.push(
          `👉 已只为你保留这 **${batch.failCount}** 个未完成的文件，稍等几秒直接回复 **「重试」** 或 **「继续解压」** 即可补解（不会重复解压已成功的）~`
        );
      }
    }
    if (batch.skippedSplitParts.length > 0) {
      lines.push(`💡 其中 ${batch.skippedSplitParts.length} 个为后续分卷文件，已自动由首卷一并解压。`);
    }
    return lines.join('\n').trim();
  }

  async execute(userId: string, input: QuarkFileActionInput): Promise<string> {
    const userPlan = this.userManager.getUserPlan(userId);
    const customCookie = userPlan.quarkCookie;
    const rootDir = userPlan.saveRootDir || this.quarkService.getDefaultRootDir();

    if (!this.quarkService.isConfigured(customCookie)) {
      return '还没有绑定夸克网盘 Cookie 哦！先发 `/set-quark <你的Cookie>` 绑定后，我就能直接帮你查看、解压、重命名和清理网盘文件啦~';
    }

    switch (input.action) {
      case 'recent_saved':
        return this.handleRecentSaved(userId);
      case 'list':
        return this.handleList(userId, input, customCookie, rootDir);
      case 'search':
        return this.handleSearch(userId, input, customCookie, rootDir);
      case 'unarchive':
        return this.handleUnarchive(userId, input, customCookie, rootDir);
      case 'rename':
        return this.handleRename(userId, input, customCookie, rootDir);
      case 'delete':
        return this.handleDelete(userId, input, customCookie, rootDir);
      case 'move':
        return this.handleMove(userId, input, customCookie, rootDir);
      case 'mkdir':
        return this.handleMkdir(input, customCookie, rootDir);
      case 'clean_censor':
        return this.handleCleanCensor(userId, customCookie, rootDir);
      case 'organize':
        return this.handleOrganize(input, customCookie, rootDir);
      case 'dedup':
        return this.handleDedup(input, customCookie, rootDir);
      default:
        return '没看懂要对网盘执行什么操作，你可以让我查看网盘目录、搜索文件、解压压缩包、重命名、移动或删除文件~';
    }
  }

  private handleRecentSaved(userId: string): string {
    const recent = this.sessionManager.getRecentSaved(userId);
    if (!recent) {
      return '最近 2 小时内还没有通过我转存过新资源哦~ 你可以让我「看看网盘目录」或者直接搜一下网盘里的文件名。';
    }

    const items = recent.allInspectedItems.length > 0 ? recent.allInspectedItems : recent.topItems;
    this.sessionManager.setNetdiskListing(userId, {
      source: 'recent_saved',
      pathOrQuery: recent.targetPath,
      dirFid: recent.targetDirFid,
      items,
    });

    const sizeStr =
      recent.fileTypeSummary.totalBytes > 0
        ? `（总计约 ${QuarkOrganizer.formatBytes(recent.fileTypeSummary.totalBytes)}）`
        : '';
    const lines: string[] = [
      `📂 **刚刚转存的资源${recent.title ? `：《${recent.title}》` : ''}**`,
      `• 存放目录：${recent.targetPath}`,
      `• 文件类型：${recent.fileTypeSummary.summaryLine}${sizeStr}`,
      '',
    ];

    items.slice(0, 15).forEach((item, idx) => {
      lines.push(this.formatNodeLine(item, idx + 1));
    });
    if (items.length > 15) {
      lines.push(`... 还有 ${items.length - 15} 个文件`);
    }

    lines.push('');
    if (recent.fileTypeSummary.hasArchives) {
      lines.push('👉 检测到包含压缩包，直接回复 **「解压」**（或 **「解压 密码xxx」**）就能云端解压；也可以说「把第1个重命名/删掉」。');
    } else {
      lines.push('👉 直接回复序号操作，比如「把第1个重命名成xxx」或「把刚转存的删掉」。');
    }
    return lines.join('\n').trim();
  }

  private async handleList(
    userId: string,
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const targetPath = input.path ? this.normalizePath(input.path, rootDir) : rootDir;
    let res = await this.quarkService.listDirectoryByPath(targetPath, customCookie, 60);

    // 若未手动指定路径且默认保存目录尚未创建，自动回退列出网盘根目录 '/'
    if (!res.ok && !input.path && targetPath !== '/') {
      res = await this.quarkService.listDirectoryByPath('/', customCookie, 60);
    }

    if (!res.ok) {
      return `⚠️ ${res.message || `无法打开目录【${targetPath}】`}`;
    }

    if (res.items.length === 0) {
      return `📂 目录 **${res.path}** 目前是空的哦~`;
    }

    // 文件夹置前，文件按更新时间倒序
    const sorted = [...res.items].sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return (b.updated_at || 0) - (a.updated_at || 0);
    });

    this.sessionManager.setNetdiskListing(userId, {
      source: 'list',
      pathOrQuery: res.path,
      dirFid: res.fid,
      items: sorted,
    });

    const lines: string[] = [
      `📂 **夸克网盘目录：${res.path}**（共 ${sorted.length} 项）`,
      `📦 类型分布：${res.summary.summaryLine}`,
      '',
    ];

    sorted.slice(0, 20).forEach((item, idx) => {
      lines.push(this.formatNodeLine(item, idx + 1));
    });
    if (sorted.length > 20) {
      lines.push(`... 还有 ${sorted.length - 20} 项`);
    }

    lines.push('');
    lines.push('👉 你可以直接对我说「解压第X个」「把第X个重命名成xxx」「把第X个删掉」或「打开第X个文件夹」~');
    return lines.join('\n').trim();
  }

  private async handleSearch(
    userId: string,
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const query = (input.query || '').trim();
    const archivesOnly = Boolean(input.archives_only);
    const items = await this.quarkService.searchFiles(query, {
      customCookie,
      size: archivesOnly ? 200 : 50,
      archivesOnly,
      rootDir,
    });

    if (items.length === 0) {
      if (archivesOnly) {
        return query
          ? `🔍 在你的夸克网盘里没有搜到和「${query}」相关的压缩包。`
          : `🔍 扫描了你的网盘目录，目前没有发现需要解压的压缩包哦~`;
      }
      return `🔍 在你的夸克网盘里没有找到包含「${query || '该关键词'}」的文件或文件夹。`;
    }

    this.sessionManager.setNetdiskListing(userId, {
      source: archivesOnly ? 'archives' : 'search',
      pathOrQuery: query || '压缩包',
      items,
    });

    // 专项查找压缩包时：不刷屏发具体文件名列表，只报总数并写入待确认全量解压队列
    if (archivesOnly) {
      const hint = query ? `「${query}」` : '你的夸克网盘';
      this.sessionManager.setPendingUnarchive(userId, hint, items);
      return this.formatArchiveCountPrompt(items, hint);
    }

    const summary = QuarkOrganizer.summarizeFileTypes(items);
    const lines: string[] = [
      `🔍 **网盘文件搜索：「${query}」**（找到 ${items.length} 项）`,
      `• 文件类型：${summary.summaryLine}`,
      '',
    ];
    items.slice(0, 15).forEach((item, idx) => {
      lines.push(this.formatNodeLine(item, idx + 1));
    });
    if (items.length > 15) {
      lines.push(`... 还有 ${items.length - 15} 项`);
    }

    lines.push('');
    if (summary.hasArchives) {
      const archList = [...summary.archiveFiles, ...summary.fakeArchiveFiles.map((f) => f.node)];
      this.sessionManager.setPendingUnarchive(userId, `「${query}」`, archList);
      lines.push(`👉 检测到 ${archList.length} 个压缩包，直接回复 **「全部解压」** 即可全部云端解压；也可以按序号重命名或删除~`);
    } else {
      lines.push('👉 直接对我说「把第1个重命名成xxx」「移动到 /某目录」或「把第1个删掉」即可操作~');
    }
    return lines.join('\n').trim();
  }

  private async collectArchivesFromNodes(
    nodes: QuarkFileNode[],
    customCookie?: string,
    maxDepth: number = 2
  ): Promise<QuarkFileNode[]> {
    const out: QuarkFileNode[] = [];
    const seen = new Set<string>();
    const visitedDirs = new Set<string>();

    const pushIfArchive = (n: QuarkFileNode) => {
      if (n.dir || seen.has(n.fid)) return;
      if (QuarkOrganizer.isArchiveFile(n.file_name) || QuarkOrganizer.detectFakeArchiveVideo(n.file_name)) {
        seen.add(n.fid);
        out.push(n);
      }
    };

    const walk = async (list: QuarkFileNode[], depth: number) => {
      for (const node of list) {
        if (!node.dir) {
          pushIfArchive(node);
        } else if (depth > 0 && !visitedDirs.has(node.fid) && visitedDirs.size < 15) {
          visitedDirs.add(node.fid);
          const children = await this.quarkService.listFilesInFolder(node.fid, customCookie, 200);
          const enriched = children.map((c) => ({ ...c, pdir_fid: c.pdir_fid || node.fid }));
          await walk(enriched, depth - 1);
        }
      }
    };

    await walk(nodes, maxDepth);
    return out;
  }

  private async handleUnarchive(
    userId: string,
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const password = (input.password || '').trim() || undefined;
    const toDirPath = input.to_dir ? this.normalizePath(input.to_dir, rootDir) : undefined;
    const deleteAfter = Boolean(input.delete_after);
    const recent: RecentSavedSession | undefined = this.sessionManager.getRecentSaved(userId);
    const pendingBatch = this.sessionManager.getPendingUnarchive(userId);

    let targets: QuarkFileNode[] = [];
    let targetHint = '';

    // 情况 0：已有待确认的全量压缩包队列，且用户未指定新的 query/path/index（如回复“全部解压”“19个全部解压”“全部”）
    if (
      pendingBatch &&
      pendingBatch.items.length > 0 &&
      !input.query &&
      !input.path &&
      input.target_scope !== 'index' &&
      !input.index &&
      !(input.indices && input.indices.length > 0) &&
      input.target_scope !== 'recent_saved'
    ) {
      targets = pendingBatch.items;
      targetHint = pendingBatch.targetHint;
    }
    // 情况 1：按最近列表序号解压
    else if (
      input.target_scope === 'index' ||
      (typeof input.index === 'number' && input.index > 0) ||
      (Array.isArray(input.indices) && input.indices.length > 0)
    ) {
      const picked = this.pickFromListing(userId, input.index, input.indices);
      if (picked.length === 0) {
        return '没有在刚才的文件列表里找到对应序号哦，先让我「看看网盘」或告诉我压缩包名字吧~';
      }
      targets = await this.collectArchivesFromNodes(picked, customCookie);
      targetHint = picked.map((p) => p.file_name).slice(0, 2).join('、');
      if (targets.length === 0) {
        return `选中的「${picked[0].file_name}」不是压缩包（里面也没发现压缩文件），不需要解压哦~`;
      }
    }
    // 情况 2：明确解压刚刚转存的（若存在刚转存记录直接处理；若没有记录则顺手扫描网盘压缩包兜底）
    else if (
      (input.target_scope === 'recent_saved' && recent) ||
      (!input.query && !input.path && recent && recent.fileTypeSummary.hasArchives)
    ) {
      targets = [
        ...recent.archiveFiles,
        ...recent.fakeArchiveFiles.map((f) => f.node),
      ];
      targetHint = recent.title ? `《${recent.title}》` : recent.targetPath;
      if (targets.length === 0) {
        return `刚刚转存到【${recent.targetPath}】的资源里没有压缩包哦（文件类型：${recent.fileTypeSummary.summaryLine}），可以直接在夸克网盘里观看！`;
      }
    }
    // 情况 3：明确路径
    else if (input.target_scope === 'path' || (input.path && input.path.includes('/'))) {
      const resolved = await this.resolveNodeByExactPath(input.path || '', customCookie);
      if (!resolved.node) {
        return `⚠️ 网盘里没有找到路径【${input.path}】，请确认路径或直接告诉我压缩包名称让我搜一下~`;
      }
      targets = await this.collectArchivesFromNodes([resolved.node], customCookie);
      targetHint = input.path || resolved.node.file_name;
      if (targets.length === 0) {
        return `路径【${input.path}】下没有发现压缩包文件哦~`;
      }
      if (targets.length > 1 && !input.all_matches && !password) {
        this.sessionManager.setPendingUnarchive(userId, targetHint, targets);
        return this.formatArchiveCountPrompt(targets, targetHint);
      }
    }
    // 情况 4：按关键词搜网盘，或全盘扫压缩包
    else {
      const query = (input.query || input.path || '').trim();
      if (query) {
        const matched = await this.quarkService.searchFiles(query, {
          customCookie,
          rootDir,
          size: 200,
        });
        targets = await this.collectArchivesFromNodes(matched, customCookie);
        targetHint = `「${query}」`;
        if (targets.length === 0) {
          if (matched.length > 0) {
            const sum = QuarkOrganizer.summarizeFileTypes(matched);
            return `在网盘里找到了和「${query}」相关的 ${matched.length} 项（${sum.summaryLine}），但里面没有压缩包文件哦~`;
          }
          const authProbe = await this.quarkService.listFilesInFolderStrict('0', customCookie, 1);
          if (authProbe.unauthorized) {
            return '⚠️ 夸克网盘 Cookie 凭证已过期或未激活，先发送 `/set-quark <新Cookie>` 绑定后我就能帮你搜文件并云端解压啦~';
          }
          return `在夸克网盘里没有找到和「${query}」相关的压缩包，你可以先让我「查一下网盘里有哪些压缩包」看看准确名字~`;
        }
        // 多压缩包且用户未明确指示“全部解压”时，先只汇报总数量并等待确认（绝不刷屏列文件名）
        if (targets.length > 1 && !input.all_matches && !password) {
          this.sessionManager.setPendingUnarchive(userId, targetHint, targets);
          return this.formatArchiveCountPrompt(targets, targetHint);
        }
      } else {
        // 若此前刚刚列过网盘压缩包且用户说“全部解压”，优先复用完整列表
        const listing = this.sessionManager.getNetdiskListing(userId);
        if (input.all_matches && listing && listing.items.length > 0) {
          const listingArchives = await this.collectArchivesFromNodes(listing.items, customCookie);
          if (listingArchives.length > 0) {
            targets = listingArchives;
            targetHint = listing.pathOrQuery || '网盘压缩包';
          }
        }

        if (targets.length === 0) {
          const authProbe = await this.quarkService.listFilesInFolderStrict('0', customCookie, 1);
          if (authProbe.unauthorized) {
            return '可以帮你云端解压呀！不过当前夸克网盘 Cookie 凭证已过期或未绑定，先发 `/set-quark <你的Cookie>` 更新后，我就能直接扫描并帮你解压网盘里的压缩包啦~';
          }
          const allArchives = await this.quarkService.searchFiles('', {
            customCookie,
            rootDir,
            archivesOnly: true,
            size: 200,
          });
          if (allArchives.length === 0) {
            return '可以帮你解压呀！我支持夸克云端在线解压（含密码压缩包、分卷包）和防和谐假后缀秒还原。刚才顺手扫了一遍你的网盘常用目录，暂时没发现待解压的压缩包；如果它藏在某个具体文件夹里，直接把文件夹名或压缩包名字告诉我，我立马帮你解~';
          }
          if (allArchives.length > 1 && !input.all_matches) {
            this.sessionManager.setNetdiskListing(userId, {
              source: 'archives',
              pathOrQuery: '网盘压缩包',
              items: allArchives,
            });
            this.sessionManager.setPendingUnarchive(userId, '你的夸克网盘', allArchives);
            return this.formatArchiveCountPrompt(allArchives, '你的夸克网盘');
          }
          targets = allArchives;
          targetHint = '网盘压缩包';
        }
      }
    }

    const batch = await this.quarkService.unarchiveFilesBatch(targets, {
      toDirPath,
      password,
      customCookie,
      deleteAfter,
    });

    // 若仍需密码，保留原待解压队列方便直接回复密码；若仅部分失败，仅保留失败项供“重试/继续解压”补解；全成功则清空
    const stillNeedsPassword = batch.results.some((r) => r.needPassword);
    const cookieExpired = batch.results.some((r) => r.message.includes('Cookie'));
    if (!stillNeedsPassword) {
      this.sessionManager.clearAwaitingUnarchive(userId);
      if (batch.failedFiles.length > 0 && !cookieExpired) {
        const retryNodes: QuarkFileNode[] = batch.failedFiles.map((f) => ({
          fid: f.fid,
          file_name: f.file_name,
          dir: false,
          pdir_fid: f.pdir_fid,
        }));
        this.sessionManager.setPendingUnarchive(
          userId,
          targetHint ? `${targetHint}·待补解` : '待补解压缩包',
          retryNodes
        );
      }
    }

    return this.formatUnarchiveBatchReply(batch, targetHint);
  }

  private async handleRename(
    userId: string,
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const rawNewName = (input.new_name || '').trim();
    if (!rawNewName) {
      return '请告诉我你想改成什么新名字哦，比如「把第1个重命名成 沙丘2 (2024)」~';
    }

    const { nodes, sourceLabel } = await this.resolveTargetNodes(userId, input, customCookie, rootDir);
    if (nodes.length === 0) {
      return `在网盘里没找到要重命名的目标（${sourceLabel}），可以先让我「看看网盘」确认一下名字或序号~`;
    }

    if (nodes.length > 1 && input.target_scope !== 'index' && !input.index) {
      this.sessionManager.setNetdiskListing(userId, {
        source: 'search',
        pathOrQuery: input.query || sourceLabel,
        items: nodes,
      });
      const lines = [`找到 **${nodes.length}** 个匹配项，为了避免改错，请告诉我你想重命名第几个：`, ''];
      nodes.slice(0, 10).forEach((n, idx) => lines.push(this.formatNodeLine(n, idx + 1)));
      lines.push('');
      lines.push(`👉 回复「把第1个重命名成 ${rawNewName}」我就马上改好~`);
      return lines.join('\n').trim();
    }

    const target = nodes[0];
    const oldName = target.file_name;
    const finalName = QuarkOrganizer.preserveExtensionOnRename(oldName, rawNewName, target.dir);
    if (finalName === oldName) {
      return `「${oldName}」本来就是这个名字啦，不需要改~`;
    }

    const res = await this.quarkService.renameFile(target.fid, finalName, customCookie);
    if (res.success) {
      target.file_name = finalName;
      if (target.path) {
        const dirPart = path.posix.dirname(target.path);
        target.path = `${dirPart === '/' ? '' : dirPart}/${finalName}`.replace(/\/+/g, '/');
      }
      return `✅ 重命名成功！\n• 原名：「${oldName}」\n• 新名：「${finalName}」`;
    }
    return `⚠️ 重命名失败：${res.message || '请稍后重试'}`;
  }

  private async handleDelete(
    userId: string,
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const { nodes, sourceLabel } = await this.resolveTargetNodes(userId, input, customCookie, rootDir);
    if (nodes.length === 0) {
      return `在网盘里没找到要删除的文件（${sourceLabel}），可以先让我「看看网盘」确认准确名字或序号~`;
    }

    // 关键词搜出多个同名/相近文件且未指定全部或序号时，先列出来防止误删
    const isExplicit =
      input.target_scope === 'index' ||
      input.target_scope === 'recent_saved' ||
      input.target_scope === 'path' ||
      Boolean(input.index) ||
      Boolean(input.indices?.length) ||
      Boolean(input.all_matches);

    if (nodes.length > 1 && !isExplicit) {
      this.sessionManager.setNetdiskListing(userId, {
        source: 'search',
        pathOrQuery: input.query || sourceLabel,
        items: nodes,
      });
      const lines = [`⚠️ 找到 **${nodes.length}** 个相关文件，为防误删，请确认你要删哪一个：`, ''];
      nodes.slice(0, 10).forEach((n, idx) => lines.push(this.formatNodeLine(n, idx + 1)));
      lines.push('');
      lines.push('👉 回复「删掉第1个」「删掉第1和第2个」或「把这些全删了」我就帮你移入回收站~');
      return lines.join('\n').trim();
    }

    const fids = nodes.map((n) => n.fid);
    const delRes = await this.quarkService.deleteFilesDetailed(fids, customCookie);
    if (delRes.success) {
      const names = nodes.map((n) => `「${n.file_name}」`).slice(0, 5).join('、');
      const more = nodes.length > 5 ? ` 等 ${nodes.length} 项` : '';
      return `🗑️ 已将 ${names}${more} 移入夸克网盘回收站！（如后续误删，可在夸克网盘回收站内恢复）`;
    }
    return `⚠️ 删除失败：${delRes.message || '请稍后重试'}`;
  }

  private async handleMove(
    userId: string,
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    if (!input.to_dir || !input.to_dir.trim()) {
      return '请告诉我你要把文件移动到哪个目录哦，例如「移动到 /我的资源/电影」~';
    }

    const { nodes, sourceLabel } = await this.resolveTargetNodes(userId, input, customCookie, rootDir);
    if (nodes.length === 0) {
      return `在网盘里没找到要移动的文件（${sourceLabel}），可以先让我「看看网盘」确认名称或序号~`;
    }

    const isExplicit =
      input.target_scope === 'index' ||
      input.target_scope === 'recent_saved' ||
      input.target_scope === 'path' ||
      Boolean(input.index) ||
      Boolean(input.indices?.length) ||
      Boolean(input.all_matches);

    if (nodes.length > 1 && !isExplicit) {
      this.sessionManager.setNetdiskListing(userId, {
        source: 'search',
        pathOrQuery: input.query || sourceLabel,
        items: nodes,
      });
      const lines = [`找到 **${nodes.length}** 个相关项，请确认要移动哪一个到【${input.to_dir}】：`, ''];
      nodes.slice(0, 10).forEach((n, idx) => lines.push(this.formatNodeLine(n, idx + 1)));
      lines.push('');
      lines.push(`👉 回复「把第1个移动到 ${input.to_dir}」或「全部移动到 ${input.to_dir}」即可~`);
      return lines.join('\n').trim();
    }

    const destPath = this.normalizePath(input.to_dir, rootDir);
    const destFid = await this.quarkService.ensureDirectoryPath(destPath, customCookie);
    const moveRes = await this.quarkService.moveFiles(
      nodes.map((n) => n.fid),
      destFid,
      customCookie
    );

    if (moveRes.success) {
      const names = nodes.map((n) => `「${n.file_name}」`).slice(0, 4).join('、');
      const more = nodes.length > 4 ? ` 等 ${nodes.length} 项` : '';
      return `✅ 已将 ${names}${more} 移动至夸克网盘【${destPath}】！`;
    }
    return `⚠️ 移动失败：${moveRes.message || '请稍后重试'}`;
  }

  private async handleMkdir(
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const raw = (input.path || input.new_name || input.query || '').trim();
    if (!raw) {
      return '请告诉我新建文件夹的名字或路径，例如「新建文件夹 /我的资源/科幻」~';
    }
    const targetPath = raw.startsWith('/') ? this.normalizePath(raw, rootDir) : `${rootDir}/${raw}`.replace(/\/+/g, '/');
    const fid = await this.quarkService.ensureDirectoryPath(targetPath, customCookie);
    if (fid && fid !== '0') {
      return `📁 已在夸克网盘为你准备好文件夹：【${targetPath}】！`;
    }
    return `⚠️ 创建文件夹【${targetPath}】失败，请检查夸克 Cookie 是否有效。`;
  }

  private async handleCleanCensor(
    userId: string,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const cleanRes = await this.quarkService.cleanUserWorkspace(rootDir, {
      userId,
      customCookie,
    });
    if (cleanRes.renamedItems.length === 0) {
      return `🎉 巡检了 ${cleanRes.scannedCount} 个文件/目录，名称都很规整，没发现防和谐火星文混淆文件~`;
    }
    const lines = [`✨ 已清理并还原 ${cleanRes.renamedItems.length} 处防和谐混淆名称（共扫描 ${cleanRes.scannedCount} 项）：`];
    for (const item of cleanRes.renamedItems.slice(0, 15)) {
      lines.push(`• 「${item.original}」➜ 《${item.restored}》`);
    }
    return lines.join('\n');
  }

  private async handleOrganize(
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const dryRun = Boolean(input.dry_run);
    const res = await this.quarkService.organizeMediaLibrary(rootDir, { customCookie, dryRun });
    if (res.renamed.length === 0) {
      return `✨ 已巡检 ${res.scannedFolders} 个媒体文件夹，所有视频命名都已符合 Emby / Infuse 标准规范！`;
    }
    const lines = [
      `${dryRun ? '👀 媒体库标准命名预览' : '✅ 媒体库 Emby/Infuse 规范整理完成'}（${dryRun ? '待整理' : '已重命名'} ${res.renamed.length} 个）：`,
    ];
    for (const item of res.renamed.slice(0, 15)) {
      lines.push(`• ${item.from} ➜ ${item.to}`);
    }
    return lines.join('\n');
  }

  private async handleDedup(
    input: QuarkFileActionInput,
    customCookie: string | undefined,
    rootDir: string
  ): Promise<string> {
    const executeDelete = Boolean(input.execute_delete);
    const res = await this.quarkService.scanAndCleanDuplicates(rootDir, { customCookie, executeDelete });
    if (res.groups.length === 0) {
      return `🎉 扫描 ${res.scannedCount} 个文件完成，没有发现同片重复或冗余低画质副本！`;
    }
    const lines = [`🧹 扫描 ${res.scannedCount} 个文件，发现 ${res.groups.length} 组重复影视资源：`];
    for (const g of res.groups.slice(0, 10)) {
      const dupNames = g.duplicates.map((d) => d.file_name).join('、');
      lines.push(`• 保留：${g.keep.file_name}\n  冗余（可省 ${QuarkOrganizer.formatBytes(g.reclaimableBytes)}）：${dupNames}`);
    }
    if (executeDelete) {
      lines.push(`\n✅ 已清理 ${res.deletedCount} 个冗余副本至回收站，释放约 ${QuarkOrganizer.formatBytes(res.reclaimedBytes)} 空间！`);
    } else {
      lines.push('\n💡 当前为预览模式；想直接清理可以对我说「帮我清理网盘重复文件」或发送 `/dedup-clean`。');
    }
    return lines.join('\n');
  }
}
