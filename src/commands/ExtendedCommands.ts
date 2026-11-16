import { UserManager } from '../services/UserManager';
import { QuarkService } from '../services/QuarkService';
import { QuarkOrganizer } from '../services/QuarkOrganizer';
import { WatchlistService } from '../services/WatchlistService';
import { ChannelHealthService } from '../services/ChannelHealthService';
import { ChannelManager } from '../services/ChannelManager';
import { ResourceSearcher } from '../services/Searcher';
import { getPanRegistry } from '../services/pan';
import { WebhookService } from '../services/WebhookService';
import { DashboardServer } from '../web/DashboardServer';
import { RelayService } from '../services/RelayService';
import { UserProfileService } from '../services/UserProfileService';
import { ResourceCategory } from '../types';

export interface ExtendedCmdContext {
  userManager: UserManager;
  quarkService: QuarkService;
  channelManager: ChannelManager;
  searcher: ResourceSearcher;
}

/**
 * 扩展指令模块化处理器（网盘治理 / 多网盘 / 媒体库联动 / 批量导入 / 控制台 / 字幕）
 * 返回 null 表示不属于扩展指令，交由主路由器处理
 */
export async function handleExtendedCommand(
  cmd: string,
  args: string[],
  userId: string,
  ctx: ExtendedCmdContext
): Promise<string | null> {
  const userPlan = ctx.userManager.getUserPlan(userId);
  const rawArg = args.join(' ').trim();

  if (['/web', '/panel', '/控制台', '控制台'].includes(cmd)) {
    const port = await DashboardServer.ensureStandaloneStarted();
    const url = DashboardServer.buildPanelUrl(userId, port);
    return [
      '🖥️ 【电视搭子 (TVdazi) 个人控制面板已就绪】',
      '----------------------------------------',
      '点击下方专属链接即可可视化管理：',
      '• 夸克 / 阿里 / 115 网盘凭证绑定',
      '• 画质偏好、保存目录与 Alist/Emby Webhook',
      '• 追剧片单批量导入与定时追更开关',
      '• 50+ 资源频道健康度实时看板',
      '',
      `🔗 ${url}`,
      '⏱️ 链接含 15 分钟有效签名令牌，请勿转发给他人。',
    ].join('\n');
  }

  if (cmd === '/set-aliyun') {
    if (!rawArg) {
      return '请提供阿里云盘 Refresh Token，格式：`/set-aliyun <refresh_token>`（或发 `/set-aliyun reset` 清除）';
    }
    ctx.userManager.setUserAliyunToken(userId, rawArg);
    return ['reset', 'clear', '清除'].includes(rawArg.toLowerCase())
      ? '✅ 已清除阿里云盘独立凭证。'
      : '🎉 阿里云盘 Refresh Token 绑定成功！后续选中阿里云盘资源将尝试自动转存。';
  }

  if (cmd === '/set-115') {
    if (!rawArg) {
      return '请提供 115 网盘 Cookie（需含 UID/CID/SEID），格式：`/set-115 <Cookie>`（或发 `/set-115 reset` 清除）';
    }
    ctx.userManager.setUser115Cookie(userId, rawArg);
    return ['reset', 'clear', '清除'].includes(rawArg.toLowerCase())
      ? '✅ 已清除 115 网盘独立凭证。'
      : '🎉 115 网盘 Cookie 绑定成功！后续选中 115 分享资源将支持直接接收转存。';
  }

  if (cmd === '/set-webhook') {
    if (!rawArg) {
      const cur = userPlan.webhookUrl || process.env.MEDIA_WEBHOOK_URL || '未配置';
      return [
        `🔔 当前媒体库联动 Webhook：${cur}`,
        '💡 配置后每次转存成功将自动推送事件通知 Alist / Emby / Jellyfin 扫库。',
        '• 设置：`/set-webhook https://your-host/webhook`',
        '• 关闭：`/set-webhook reset`',
      ].join('\n');
    }
    ctx.userManager.setUserWebhookUrl(userId, rawArg);
    return ['reset', 'clear', '清除', 'off'].includes(rawArg.toLowerCase())
      ? '✅ 已关闭个人媒体库 Webhook 通知。'
      : '🎉 媒体库联动 Webhook 配置成功！后续每次资源入库都会自动触发通知。';
  }

  if (cmd === '/transfer-115' || cmd === '/transfer-aliyun') {
    const is115 = cmd === '/transfer-115';
    const panType = is115 ? '115' : 'aliyun';
    const rawTarget = args[0] || '';
    const passcode = args[1] || '';
    if (!rawTarget) {
      return `请提供${is115 ? '115' : '阿里云盘'}分享链接或分享码，例如：\`${cmd} https://...\``;
    }
    const idMatch = is115
      ? rawTarget.match(/(?:115|anxia|115cdn)\.com\/s\/([a-zA-Z0-9]+)/i)
      : rawTarget.match(/(?:alipan|aliyundrive)\.com\/s\/([a-zA-Z0-9]+)/i);
    const shareId = idMatch ? idMatch[1] : rawTarget;

    const provider = getPanRegistry().get(panType);
    if (!provider) return '当前网盘适配器尚未加载。';
    const credential = is115 ? userPlan.pan115Cookie : userPlan.aliyunToken;
    const res = await provider.saveShare(shareId, passcode, '电影', {
      credential,
      rootDir: userPlan.saveRootDir,
      userId,
    });
    if (res.success) {
      ctx.userManager.recordSave(userId, undefined, rawTarget, '电影');
      WebhookService.notifyMediaSaved(userPlan.webhookUrl, {
        userId,
        panType,
        targetPath: res.targetPath,
        shareUrl: rawTarget,
      }).catch(() => {});
    }
    return res.message;
  }

  if (['/organize', '/emby-rename', '/整理媒体库'].includes(cmd)) {
    if (!ctx.quarkService.isConfigured(userPlan.quarkCookie)) {
      return '还没有绑定夸克网盘 Cookie 哦！请先发送 `/set-quark <Cookie>` 绑定后再试。';
    }
    const dryRun = ['preview', '预览', 'dry'].includes((args[0] || '').toLowerCase());
    const userRootDir = userPlan.saveRootDir || ctx.quarkService.getDefaultRootDir();
    const res = await ctx.quarkService.organizeMediaLibrary(userRootDir, {
      customCookie: userPlan.quarkCookie,
      dryRun,
    });
    if (res.renamed.length === 0) {
      return `✨ 已巡检 ${res.scannedFolders} 个媒体文件夹，所有视频文件命名均已符合 Emby / Infuse 标准规范！`;
    }
    const lines = [
      `${dryRun ? '👀 【媒体库标准命名预览】' : '✅ 【媒体库 Emby/Infuse 规范整理完成】'}（共巡检 ${res.scannedFolders} 个目录，${dryRun ? '待整理' : '已重命名'} ${res.renamed.length} 个文件）：`,
      '----------------------------------------',
    ];
    for (const item of res.renamed.slice(0, 15)) {
      lines.push(`• ${item.from}\n  ➜ ${item.to}`);
    }
    if (res.renamed.length > 15) {
      lines.push(`... 还有 ${res.renamed.length - 15} 个文件`);
    }
    if (dryRun) {
      lines.push('💡 确认无误后发送 `/organize` 即可执行批量规范重命名！');
    }
    return lines.join('\n');
  }

  if (['/dedup', '/dedup-clean', '/网盘去重', '/清理重复'].includes(cmd)) {
    if (!ctx.quarkService.isConfigured(userPlan.quarkCookie)) {
      return '还没有绑定夸克网盘 Cookie 哦！请先发送 `/set-quark <Cookie>` 绑定后再试。';
    }
    const executeDelete = cmd === '/dedup-clean' || ['clean', '执行', '清理'].includes((args[0] || '').toLowerCase());
    const userRootDir = userPlan.saveRootDir || ctx.quarkService.getDefaultRootDir();
    const res = await ctx.quarkService.scanAndCleanDuplicates(userRootDir, {
      customCookie: userPlan.quarkCookie,
      executeDelete,
    });
    if (res.groups.length === 0) {
      return `🎉 扫描 ${res.scannedCount} 个文件完成，未发现同片重复或冗余低画质副本！`;
    }
    const lines = [
      `🧹 扫描 ${res.scannedCount} 个文件，发现 ${res.groups.length} 组重复影视资源：`,
      '----------------------------------------',
    ];
    for (const g of res.groups.slice(0, 10)) {
      const dupNames = g.duplicates.map((d) => d.file_name).join('、');
      lines.push(`• 保留：${g.keep.file_name}\n  冗余（可省 ${QuarkOrganizer.formatBytes(g.reclaimableBytes)}）：${dupNames}`);
    }
    if (executeDelete) {
      lines.push(`\n✅ 已清理 ${res.deletedCount} 个冗余副本，释放约 ${QuarkOrganizer.formatBytes(res.reclaimedBytes)} 空间！`);
    } else {
      lines.push('\n💡 当前为只读预览；发送 `/dedup-clean` 将自动保留最高画质并清理冗余副本至回收站。');
    }
    return lines.join('\n');
  }

  if (['/import-list', '/批量导入', '/导入片单'].includes(cmd)) {
    if (!rawArg) {
      return [
        '📥 【跨平台片单批量导入】',
        '支持粘贴：豆瓣片单/豆列链接、小红书含《片名》的种草文案、或多行剧名清单：',
        '示例：`/import-list 《沙丘2》《三体》《奥本海默》`',
      ].join('\n');
    }
    const titles = await WatchlistService.parseBatchInput(rawArg);
    if (titles.length === 0) {
      return '未能从输入中解析出有效片名，请用《书名号》或换行分隔片名后再试~';
    }
    const { added, skipped } = ctx.userManager.importToWatchlist(userId, titles);
    return [
      `📥 批量片单解析完成（共识别 ${titles.length} 部）：`,
      `• 新增收录 ${added.length} 部：${added.slice(0, 10).join('、')}${added.length > 10 ? ' 等' : ''}`,
      skipped.length > 0 ? `• 已在清单中跳过 ${skipped.length} 部` : '',
      '💡 发送 `/追剧` 查看完整片单，或直接发片名即可搜存！',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (['/channels-health', '/频道健康', '/channel-health'].includes(cmd)) {
    const ids = ctx.channelManager.loadChannels().map((c) => c.id);
    const stats = ChannelHealthService.getInstance().getAllStats(ids);
    const openCount = stats.filter((s) => s.circuitOpen).length;
    const lines = [
      `📡 【全网 ${stats.length} 个资源频道健康度面板】（当前熔断跳过 ${openCount} 个）`,
      '----------------------------------------',
      '🏆 Top 10 优先健康频道：',
    ];
    stats.slice(0, 10).forEach((s, idx) => {
      const state = s.circuitOpen ? '🔴熔断' : '🟢正常';
      lines.push(`${idx + 1}. @${s.channelId} | 分:${s.score} | ${s.avgLatencyMs}ms | 命中:${s.hitCount} | ${state}`);
    });
    return lines.join('\n');
  }

  if (['/subtitle', '/字幕', '找字幕'].includes(cmd)) {
    if (!rawArg) {
      return '请告诉我需要找哪部影视的字幕，例如：`/subtitle 沙丘2`';
    }
    const res = await ctx.searcher.searchSubtitles(rawArg, { maxResults: 10 });
    if (res.items.length === 0) {
      return `暂时没有找到《${rawArg}》的独立字幕包资源，建议直接搜索《${rawArg}》筛选带有 [中字] 或 [特效中字] 标签的版本！`;
    }
    const lines = [`💬 【${rawArg}】外挂/中字字幕相关资源 (${res.items.length}条)：`, '----------------------------------------'];
    res.items.slice(0, 8).forEach((item, i) => {
      const tags = item.qualityTags?.badges?.length ? `[${item.qualityTags.badges.join('/')}]` : '';
      lines.push(`${i + 1}. ${tags} ${item.title}\n   🔗 ${item.shareUrl}`);
    });
    return lines.join('\n');
  }

  const relay = RelayService.getInstance();

  if (['/users', '/contacts', '/通讯录', '/用户列表', '通讯录', '用户列表'].includes(cmd)) {
    return relay.renderDirectoryText(userId);
  }

  if (['/name', '/nick', '/nickname', '/改名', '/昵称'].includes(cmd)) {
    if (!rawArg) {
      const cur = relay.getDisplayName(userId, userId);
      return `你当前在通讯录里的名字是「${cur}」~ 发送 \`/name 你的新昵称\`（或直接说“叫我小明”）即可修改！`;
    }
    return relay.setMyNickname(userId, rawArg).message;
  }

  if (['/alias', '/remark', '/备注'].includes(cmd)) {
    const targetQuery = args[0] || '';
    const remark = args.slice(1).join(' ').trim();
    if (!targetQuery || !remark) {
      return '用法：`/alias <序号或原名> <备注名>`，例如 `/alias 2 小红`（先发 `/users` 可看序号）';
    }
    return relay.setContactRemark(userId, targetQuery, remark).message;
  }

  if (['/say', '/relay', '/tell', '/传话', '/带话'].includes(cmd)) {
    const targetQuery = args[0] || '';
    const content = args.slice(1).join(' ').trim();
    if (!targetQuery || !content) {
      return '用法：`/say <对方名字或序号> <要说的话>`，例如 `/say 小明 最近有什么好看的电影`';
    }
    const res = await relay.sendRelayMessage(userId, targetQuery, content);
    return res.replyToSender;
  }

  if (['/share-movie', '/recommend-to', '/推片', '/安利'].includes(cmd)) {
    const targetQuery = args[0] || '';
    const movieTitle = args.slice(1).join(' ').trim();
    if (!targetQuery) {
      return '用法：`/share-movie <对方名字或序号> [片名]`（不填片名时会自动分享刚刚看中的电影哦！）';
    }
    const res = await relay.shareMovieToUser(userId, targetQuery, {
      movieTitle: movieTitle || undefined,
    });
    return res.replyToSender;
  }

  if (['/reply', '/回复传话', '/回话'].includes(cmd)) {
    if (!rawArg) {
      return '请写上要回复给对方的话，例如：`/reply 最近《周处除三害》不错`';
    }
    const res = await relay.replyToLastSender(userId, rawArg);
    return res.replyToReplier;
  }

  if (['/dnd', '/免打扰'].includes(cmd)) {
    const flag = (args[0] || '').toLowerCase();
    if (!flag) {
      return `当前传话免打扰状态：${relay.isDndEnabled(userId) ? '已开启 🔕' : '未开启 🔔'}（发送 \`/dnd on\` 或 \`/dnd off\` 切换）`;
    }
    return relay.setDnd(userId, ['on', '1', 'true', '开启', '开'].includes(flag));
  }

  if (['/profile', '/taste', '/画像', '我的画像', '观影画像', '我的口味'].includes(cmd)) {
    const profileSvc = UserProfileService.getInstance();
    if (['reset', 'clear', '清空', '重置'].includes((args[0] || '').toLowerCase())) {
      profileSvc.clearProfile(userId);
      return '✅ 已清空你的个人观影口味画像，之后会根据你的新喜好和转存重新学习啦！';
    }
    return profileSvc.renderProfileCard(userId);
  }

  return null;
}
