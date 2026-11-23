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
   * 识别“刚转存含压缩包提醒”后的极简快捷确认/拒绝回复
   */
  static parseQuickUnarchiveIntent(text: string, awaitingConfirm: boolean): QuickUnarchiveIntent | null {
    if (!awaitingConfirm) return null;
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.startsWith('/')) return null;

    if (/^(?:不用|不用了|不解压|先不解|先不用|不需要|算了|取消|不要|no|cancel)[!！。.~～]*$/i.test(trimmed)) {
      return { kind: 'decline' };
    }

    const deleteAfter = /(?:删掉?原|删除原|顺便删|解完删|删压缩包)/.test(trimmed);

    // 1. 纯确认词（如“好”“好的”“要”“解压”“解压吧”“帮我解压”）
    if (
      /^(?:解压|帮我解压|解压吧|解压一下|解一下|开始解压|云端解压|直接解压|要|要的|需要|好|好的|好呀|可以|行|嗯|嗯嗯|ok|yes)(?:并删除原(?:文件|压缩包|包)|顺便删(?:掉|了)?原(?:文件|压缩包|包))?[!！。.~～]*$/i.test(
        trimmed
      )
    ) {
      return { kind: 'confirm', deleteAfter };
    }

    // 2. 带密码的快捷确认（如“解压 密码1234”、“解压 1234”、“密码是1234”、“密码：abc”）
    const explicitPwd = QuarkOrganizer.extractArchivePasswordHint(trimmed);
    if (
      explicitPwd &&
      /^(?:解压|帮我解压|直接解压|云端解压|好的?|要|密码|解压密码|解压码|口令|pwd)/i.test(trimmed)
    ) {
      return { kind: 'confirm', password: explicitPwd, deleteAfter };
    }

    const barePwdMatch = trimmed.match(/^(?:解压|帮我解压|云端解压)\s+([A-Za-z0-9._@#\-!$%^&*]{1,32})$/i);
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
    const lines: string[] = [];
    if (batch.results.length === 1) {
      lines.push(batch.results[0].message);
    } else {
      lines.push(
        `📦 压缩包处理完成${targetHint ? `（${targetHint}）` : ''}：成功 ${batch.successCount} 个` +
          (batch.inProgressCount > 0 ? `，云端后台解压中 ${batch.inProgressCount} 个` : '') +
          (batch.failCount > 0 ? `，失败 ${batch.failCount} 个` : '')
      );
      lines.push('');
      for (const r of batch.results) {
        lines.push(`• ${r.message}`);
      }
    }
    if (batch.skippedSplitParts.length > 0) {
      lines.push(`\n💡 已自动跳过 ${batch.skippedSplitParts.length} 个后续分卷文件（由首个分卷统一解压）。`);
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
      size: 30,
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

    const summary = QuarkOrganizer.summarizeFileTypes(items);
    const heading = archivesOnly
      ? `📦 **网盘压缩包检索${query ? `：「${query}」` : ''}**（找到 ${items.length} 个）`
      : `🔍 **网盘文件搜索：「${query}」**（找到 ${items.length} 项）`;

    const lines: string[] = [heading, `• 文件类型：${summary.summaryLine}`, ''];
    items.slice(0, 15).forEach((item, idx) => {
      lines.push(this.formatNodeLine(item, idx + 1));
    });
    if (items.length > 15) {
      lines.push(`... 还有 ${items.length - 15} 项`);
    }

    lines.push('');
    if (summary.hasArchives) {
      lines.push('👉 直接对我说「解压第1个」「把这些压缩包全解压了」「把第2个重命名/删掉」就行~');
    } else {
      lines.push('👉 直接对我说「把第1个重命名成xxx」「移动到 /某目录」或「把第1个删掉」即可操作~');
    }
    return lines.join('\n').trim();
  }

  private async collectArchivesFromNodes(
    nodes: QuarkFileNode[],
    customCookie?: string
  ): Promise<QuarkFileNode[]> {
    const out: QuarkFileNode[] = [];
    const seen = new Set<string>();
    const pushIfArchive = (n: QuarkFileNode) => {
      if (n.dir || seen.has(n.fid)) return;
      if (QuarkOrganizer.isArchiveFile(n.file_name) || QuarkOrganizer.detectFakeArchiveVideo(n.file_name)) {
        seen.add(n.fid);
        out.push(n);
      }
    };

    let dirScanned = 0;
    for (const node of nodes) {
      if (!node.dir) {
        pushIfArchive(node);
      } else if (dirScanned < 3) {
        dirScanned++;
        const children = await this.quarkService.listFilesInFolder(node.fid, customCookie, 100);
        for (const c of children) {
          pushIfArchive({ ...c, pdir_fid: c.pdir_fid || node.fid });
        }
      }
    }
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

    let targets: QuarkFileNode[] = [];
    let targetHint = '';

    // 情况 1：按最近列表序号解压
    if (
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
    // 情况 2：明确解压刚刚转存的，或未传任何 query/path 但刚转存的正好含压缩包
    else if (
      input.target_scope === 'recent_saved' ||
      (!input.query && !input.path && recent && recent.fileTypeSummary.hasArchives)
    ) {
      if (!recent) {
        return '最近没有刚刚转存的记录哦~ 可以告诉我网盘里压缩包的名字或路径，我帮你找出来解压！';
      }
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
    }
    // 情况 4：按关键词搜网盘，或全盘扫压缩包
    else {
      const query = (input.query || input.path || '').trim();
      if (query) {
        const matched = await this.quarkService.searchFiles(query, {
          customCookie,
          rootDir,
          size: 30,
        });
        targets = await this.collectArchivesFromNodes(matched, customCookie);
        targetHint = `「${query}」`;
        if (targets.length === 0) {
          if (matched.length > 0) {
            const sum = QuarkOrganizer.summarizeFileTypes(matched);
            return `在网盘里找到了和「${query}」相关的 ${matched.length} 项（${sum.summaryLine}），但里面没有压缩包文件哦~`;
          }
          return `在夸克网盘里没有找到和「${query}」相关的压缩包，你可以先让我「查一下网盘里有哪些压缩包」看看准确名字~`;
        }
      } else {
        const allArchives = await this.quarkService.searchFiles('', {
          customCookie,
          rootDir,
          archivesOnly: true,
          size: 20,
        });
        if (allArchives.length === 0) {
          return '扫描了你的夸克网盘，目前没有发现待解压的压缩包哦~ 如果它在某个特定子目录里，把目录名或压缩包名告诉我就能精准定位！';
        }
        if (allArchives.length > 1 && !input.all_matches) {
          this.sessionManager.setNetdiskListing(userId, {
            source: 'archives',
            pathOrQuery: '网盘压缩包',
            items: allArchives,
          });
          const lines = [`📦 我帮你扫到网盘里有 **${allArchives.length}** 个压缩包，你想解压哪一个？`, ''];
          allArchives.slice(0, 12).forEach((item, idx) => {
            lines.push(this.formatNodeLine(item, idx + 1));
          });
          lines.push('');
          lines.push('👉 直接回复「解压第1个」「解压第2个 密码xxx」或者说「全部解压」我就帮你动手~');
          return lines.join('\n').trim();
        }
        targets = allArchives;
        targetHint = '网盘压缩包';
      }
    }

    const batch = await this.quarkService.unarchiveFilesBatch(targets, {
      toDirPath,
      password,
      customCookie,
      deleteAfter,
    });

    // 若仍需密码，保留 awaitingUnarchiveConfirm 方便用户直接回复密码继续
    const stillNeedsPassword = batch.results.some((r) => r.needPassword);
    if (!stillNeedsPassword) {
      this.sessionManager.clearAwaitingUnarchive(userId);
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
