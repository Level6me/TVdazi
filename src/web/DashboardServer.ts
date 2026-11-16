import http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';
import axios from 'axios';
import { UserManager } from '../services/UserManager';
import { SchedulerService } from '../services/SchedulerService';
import { ChannelHealthService } from '../services/ChannelHealthService';
import { ChannelManager } from '../services/ChannelManager';
import { WatchlistService } from '../services/WatchlistService';
import { RelayService } from '../services/RelayService';
import { UserProfileService } from '../services/UserProfileService';
import { maskSensitive } from '../utils/Logger';
import { upsertEnvVar } from '../utils/FileUtils';
import { AUI_BUNDLE_CSS, AUI_BUNDLE_JS } from './auiBundle';

/**
 * 轻量 H5 自助控制台 & REST API（可嵌入 src/index.ts HTTP 网关，也可在微信端按需拉起独立端口）
 */
export class DashboardServer {
  private static server: http.Server | null = null;
  private static activePort: number = 0;
  private static cachedSecret: string | null = null;
  private static detectedPublicHost: string | null = null;
  private static customEnvPath: string | null = null;

  static setEnvFilePath(envPath: string | null): void {
    this.customEnvPath = envPath;
  }

  private static getEnvFilePath(): string {
    return this.customEnvPath || path.resolve(process.cwd(), '.env');
  }

  /**
   * 规范化用户输入的 Web 面板访问域名或基础 URL：
   * - 留空 / reset / clear / auto => 清空自定义域名，恢复自动公网 IP 探测
   * - 纯域名（如 tvdazi.example.com）=> 自动补全 https://
   * - IP 或 localhost（如 1.2.3.4:3002）=> 自动补全 http://
   */
  static normalizePublicBaseUrl(raw: string): { valid: boolean; normalized: string; error?: string } {
    const trimmed = (raw || '').trim();
    if (!trimmed || ['reset', 'clear', 'auto', '默认', '清除', '自动'].includes(trimmed.toLowerCase())) {
      return { valid: true, normalized: '' };
    }

    let candidate = trimmed.replace(/\/+$/, '');
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate) && !/^https?:\/\//i.test(candidate)) {
      return { valid: false, normalized: '', error: '仅支持 http:// 或 https:// 协议' };
    }
    if (!/^https?:\/\//i.test(candidate)) {
      const looksLikeIpOrLocal = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/.*)?$/i.test(candidate);
      candidate = `${looksLikeIpOrLocal ? 'http' : 'https'}://${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { valid: false, normalized: '', error: '仅支持 http:// 或 https:// 协议' };
      }
      if (!parsed.hostname) {
        return { valid: false, normalized: '', error: '域名不能为空' };
      }
      const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
      return { valid: true, normalized: `${parsed.origin}${cleanPath}` };
    } catch {
      return { valid: false, normalized: '', error: '域名格式无效，请输入如 https://panel.example.com 或 http://ip:3002' };
    }
  }

  static getEffectiveBaseUrl(port?: number): string {
    const publicBase = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (publicBase) return publicBase;
    const usePort = port || this.activePort || parseInt(process.env.WEB_DASHBOARD_PORT || process.env.PORT || '3002', 10);
    const host = this.detectedPublicHost || '127.0.0.1';
    return `http://${host}:${usePort}`;
  }

  static setPublicBaseUrl(rawUrl: string): { valid: boolean; normalized: string; error?: string } {
    const res = this.normalizePublicBaseUrl(rawUrl);
    if (!res.valid) return res;
    if (res.normalized) {
      process.env.PUBLIC_BASE_URL = res.normalized;
    } else {
      delete process.env.PUBLIC_BASE_URL;
    }
    upsertEnvVar(this.getEnvFilePath(), 'PUBLIC_BASE_URL', res.normalized);
    return res;
  }

  private static getRuntimeSecret(): string {
    const envSecret = (process.env.DASHBOARD_SECRET || process.env.API_AUTH_TOKEN || '').trim();
    if (envSecret) return envSecret;
    if (this.cachedSecret) return this.cachedSecret;

    const secretFile = path.resolve(process.cwd(), 'data/.dashboard_secret');
    try {
      if (fs.existsSync(secretFile)) {
        const existing = fs.readFileSync(secretFile, 'utf-8').trim();
        if (existing.length >= 16) {
          this.cachedSecret = existing;
          return existing;
        }
      }
      const dir = path.dirname(secretFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const generated = crypto.randomBytes(24).toString('hex');
      fs.writeFileSync(secretFile, generated, { mode: 0o600 });
      this.cachedSecret = generated;
      return generated;
    } catch {
      this.cachedSecret = crypto.randomBytes(24).toString('hex');
      return this.cachedSecret;
    }
  }

  /**
   * 为指定微信用户签发带时效性的 HMAC 访问 Token（默认 24 小时有效）
   */
  static issueUserToken(userId: string, ttlMs: number = 24 * 60 * 60 * 1000): string {
    const exp = Date.now() + ttlMs;
    const payload = Buffer.from(JSON.stringify({ userId, exp }), 'utf-8').toString('base64url');
    const sig = crypto
      .createHmac('sha256', this.getRuntimeSecret())
      .update(payload)
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  static verifyToken(token: string): string | null {
    if (!token || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expectedSig = crypto
      .createHmac('sha256', this.getRuntimeSecret())
      .update(payload)
      .digest('base64url');
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return null;
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
      if (!parsed?.userId || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
        return null;
      }
      return String(parsed.userId);
    } catch {
      return null;
    }
  }

  /**
   * 探测可用于手机微信点击的公网或局域网访问主机地址
   */
  private static async detectHostIfNeeded(): Promise<string> {
    if (this.detectedPublicHost) return this.detectedPublicHost;
    try {
      const resp = await axios.get('https://api.ipify.org', { timeout: 2000 });
      const ip = String(resp.data || '').trim();
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
        this.detectedPublicHost = ip;
        return ip;
      }
    } catch {}

    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const info of list || []) {
        if (info.family === 'IPv4' && !info.internal) {
          this.detectedPublicHost = info.address;
          return info.address;
        }
      }
    }
    return '127.0.0.1';
  }

  /**
   * 独立启动轻量 H5 管理端口（供 WeixinBot 单进程模式下使用）
   */
  static async ensureStandaloneStarted(): Promise<number> {
    if (this.server && this.activePort > 0) {
      await this.detectHostIfNeeded().catch(() => {});
      return this.activePort;
    }
    const desiredPort = parseInt(process.env.WEB_DASHBOARD_PORT || '3002', 10);
    await this.detectHostIfNeeded().catch(() => {});
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: maskSensitive(err?.message || 'Internal Error') }));
        });
      });
      srv.on('error', () => {
        // 端口已被占用时（如 index.ts 已启动），回退为主端口
        this.activePort = parseInt(process.env.PORT || '3001', 10);
        resolve(this.activePort);
      });
      srv.listen(desiredPort, '0.0.0.0', () => {
        this.server = srv;
        this.activePort = desiredPort;
        resolve(desiredPort);
      });
    });
  }

  static buildPanelUrl(userId: string, port?: number): string {
    const token = this.issueUserToken(userId);
    const base = this.getEffectiveBaseUrl(port);
    return `${base}/panel?token=${encodeURIComponent(token)}`;
  }

  /**
   * 处理 /panel 与 /api/panel/* 请求；返回 true 表示已拦截处理
   */
  static async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname || '';

    if (pathname !== '/panel' && !pathname.startsWith('/api/panel/')) {
      return false;
    }

    if (req.method === 'GET' && pathname === '/panel') {
      const token = String(parsedUrl.query.token || '');
      const userId = this.verifyToken(token);
      if (!userId) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h3>访问令牌已失效或缺失，请在微信发送 /web 获取最新控制台链接。</h3>');
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.renderHtmlPage(token));
      return true;
    }

    const authHeader = String(req.headers['x-panel-token'] || parsedUrl.query.token || '');
    const userId = this.verifyToken(authHeader);
    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized or expired panel token' }));
      return true;
    }

    const userManager = UserManager.getInstance();
    const scheduler = SchedulerService.getInstance();
    const health = ChannelHealthService.getInstance();
    const channelIds = new ChannelManager().loadChannels().map((c) => c.id);

    if (req.method === 'GET' && pathname === '/api/panel/state') {
      if (parsedUrl.query.probe === '1') {
        await health.probeChannels(channelIds);
      }
      const plan = userManager.getUserPlan(userId);
      const tasks = scheduler.getUserTasks(userId);
      const channels = health.getAllStats(channelIds);
      const relay = RelayService.getInstance();
      const directory = relay.getDirectory(userId);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          userId: plan.userId.length > 16 ? `${plan.userId.slice(0, 8)}...${plan.userId.slice(-6)}` : plan.userId,
          settings: {
            alias: plan.alias || '',
            saveRootDir: plan.saveRootDir || '/我的资源',
            preferredQuality: plan.preferences?.preferredQuality || 'any',
            webhookUrl: plan.webhookUrl || '',
            publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').trim(),
            effectiveBaseUrl: this.getEffectiveBaseUrl(),
            hasQuarkCookie: Boolean(plan.quarkCookie),
            hasAliyunToken: Boolean(plan.aliyunToken),
            has115Cookie: Boolean(plan.pan115Cookie),
            hasDeepSeekKey: Boolean(plan.deepseekApiKey),
          },
          contacts: directory.map((d) => ({
            index: d.index,
            displayName: d.displayName,
            maskedId: d.maskedId,
            isSelf: d.isSelf,
            hasCustomAlias: d.hasCustomAlias,
          })),
          tasteProfile: UserProfileService.getInstance().getDetailedProfileForWeb(userId),
          stats: plan.stats,
          watchlist: plan.watchlist,
          tasks,
          channels: {
            total: channels.length,
            circuitOpenCount: channels.filter((c) => c.circuitOpen).length,
            topChannels: channels.slice(0, 20),
          },
        })
      );
      return true;
    }

    const body = await this.readJsonBody(req);

    if (req.method === 'POST' && pathname === '/api/panel/settings') {
      if (typeof body.publicBaseUrl === 'string') {
        const domainRes = this.setPublicBaseUrl(body.publicBaseUrl);
        if (!domainRes.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: domainRes.error || '域名格式无效' }));
          return true;
        }
      }
      if (typeof body.alias === 'string' && body.alias.trim()) {
        RelayService.getInstance().setMyNickname(userId, body.alias.trim());
      }
      if (typeof body.saveRootDir === 'string' && body.saveRootDir.trim()) {
        const dir = body.saveRootDir.trim().startsWith('/') ? body.saveRootDir.trim() : `/${body.saveRootDir.trim()}`;
        userManager.setUserRootDir(userId, dir);
      }
      if (typeof body.preferredQuality === 'string') {
        userManager.setUserPreferredQuality(userId, body.preferredQuality);
      }
      if (typeof body.webhookUrl === 'string') {
        userManager.setUserWebhookUrl(userId, body.webhookUrl);
      }
      if (typeof body.quarkCookie === 'string' && body.quarkCookie.trim()) {
        userManager.setUserQuarkCookie(userId, body.quarkCookie.trim());
      }
      if (typeof body.aliyunToken === 'string' && body.aliyunToken.trim()) {
        userManager.setUserAliyunToken(userId, body.aliyunToken.trim());
      }
      if (typeof body.pan115Cookie === 'string' && body.pan115Cookie.trim()) {
        userManager.setUser115Cookie(userId, body.pan115Cookie.trim());
      }
      if (typeof body.deepseekApiKey === 'string' && body.deepseekApiKey.trim()) {
        userManager.setUserDeepSeekKey(userId, body.deepseekApiKey.trim());
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').trim(),
          effectiveBaseUrl: this.getEffectiveBaseUrl(),
          newPanelUrl: this.buildPanelUrl(userId),
        })
      );
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/panel/watchlist') {
      const action = String(body.action || '');
      if (action === 'add' && body.title) {
        const result = userManager.addToWatchlist(userId, String(body.title));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return true;
      }
      if (action === 'import' && body.rawText) {
        const titles = await WatchlistService.parseBatchInput(String(body.rawText));
        const imported = userManager.importToWatchlist(userId, titles);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...imported }));
        return true;
      }
      if (action === 'status' && body.title && body.status) {
        const ok = userManager.updateWatchlistStatus(userId, String(body.title), body.status);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
        return true;
      }
      if (action === 'remove' && body.title) {
        const ok = userManager.removeFromWatchlist(userId, String(body.title));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
        return true;
      }
    }

    if (req.method === 'POST' && pathname === '/api/panel/tasks') {
      const action = String(body.action || '').trim();
      const taskId = String(body.taskId || '').trim();
      if (action === 'create_watch') {
        const title = String(body.title || '').replace(/[《》]/g, '').trim();
        if (!title) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '请输入要追更的电影或剧集名称' }));
          return true;
        }
        const rawMode = String(body.mode || 'resource_watch');
        const mode: 'episode_chase' | 'resource_watch' | 'quality_upgrade' =
          rawMode === 'episode_chase' || rawMode === 'quality_upgrade' ? rawMode : 'resource_watch';
        const intervalMinutes = Number(body.intervalMinutes || 30);
        const autoSave = Boolean(body.autoSave);
        const task = scheduler.createPanelWatchTask({
          userId,
          title,
          mode,
          intervalMinutes,
          autoSave,
          runInitialCheck: body.runInitialCheck !== false,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            task,
            watchlist: userManager.getUserPlan(userId).watchlist,
            tasks: scheduler.getUserTasks(userId),
          })
        );
        return true;
      }
      if (action === 'toggle') {
        if (!taskId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '缺少任务 ID' }));
          return true;
        }
        const task = scheduler.toggleUserTaskById(userId, taskId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: Boolean(task), task, error: task ? undefined : '任务不存在或已被删除' }));
        return true;
      }
      if (action === 'delete') {
        if (!taskId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '缺少任务 ID' }));
          return true;
        }
        const ok = scheduler.deleteUserTaskById(userId, taskId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok, error: ok ? undefined : '任务不存在或已被删除' }));
        return true;
      }
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '不支持的任务操作' }));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/panel/channels/probe') {
      const channels = await health.probeChannels(channelIds);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          channels: {
            total: channels.length,
            circuitOpenCount: channels.filter((c) => c.circuitOpen).length,
            topChannels: channels.slice(0, 20),
          },
        })
      );
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/panel/channels/reset') {
      if (typeof body.channelId === 'string' && body.channelId) {
        health.resetChannel(body.channelId);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/panel/profile/reset') {
      UserProfileService.getInstance().clearProfile(userId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/panel/profile') {
      const profileSvc = UserProfileService.getInstance();
      const action = String(body.action || '');
      const category = String(body.category || '') as
        | 'likeMediaTypes'
        | 'likeGenres'
        | 'likeRegions'
        | 'likeDirectors'
        | 'likeActors'
        | 'favoriteSeeds'
        | 'dislikeGenres';
      const rawValue = String(body.value || '').trim();

      if (action === 'reset') {
        profileSvc.clearProfile(userId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, tasteProfile: profileSvc.getDetailedProfileForWeb(userId) }));
        return true;
      }

      const validCats = ['likeMediaTypes', 'likeGenres', 'likeRegions', 'likeDirectors', 'likeActors', 'favoriteSeeds', 'dislikeGenres'];
      if (!validCats.includes(category) || !rawValue) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '无效的画像分类或空值' }));
        return true;
      }

      if (action === 'add') {
        const values = rawValue
          .split(/[,，、;；]+/)
          .map((s) => s.replace(/[《》]/g, '').trim())
          .filter(Boolean);
        profileSvc.recordExplicitPreference(userId, {
          [category]: values,
          enrichSeedsAsync: category === 'favoriteSeeds',
        });
      } else if (action === 'remove') {
        profileSvc.removeExplicitItem(userId, category, rawValue);
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, tasteProfile: profileSvc.getDetailedProfileForWeb(userId) }));
      return true;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Unknown panel endpoint' }));
    return true;
  }

  private static readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
    return new Promise((resolve) => {
      let raw = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 512 * 1024) raw += chunk;
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve({});
        }
      });
    });
  }

  private static renderHtmlPage(token: string): string {
    const safeToken = token.replace(/[^A-Za-z0-9._-]/g, '');
    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<title>电视搭子 (TVdazi) 影视网盘控制台</title>
<meta name="theme-color" content="#007aff" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#1c1c1e" media="(prefers-color-scheme: dark)" />
<style>
${AUI_BUNDLE_CSS}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--success);display:inline-block;box-shadow:0 0 8px var(--success);}
.chip-wrap{display:flex;flex-wrap:wrap;gap:8px;}
.chip-del{margin-left:4px;opacity:.7;cursor:pointer;font-weight:800;}
.chip-del:hover{opacity:1;color:var(--danger);}
.inline-add{display:flex;gap:8px;align-items:center;margin-top:10px;}
.inline-add .form-control{flex:1;min-width:0;}
.list-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-subtle);}
.list-row:last-child{border-bottom:none;}
.list-main{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13px;}
.list-actions{display:flex;align-items:center;gap:6px;flex-shrink:0;}
.mono-sub{font-family:var(--font-mono);font-size:11px;color:var(--text-sec);margin-top:4px;word-break:break-all;}
</style>
</head>
<body>
<div class="toast-container" id="toast-container"></div>

<div class="container">
  <header class="header">
    <div class="header-left">
      <div class="date-badge"><span class="status-dot"></span><span id="headerBadge">TVDAZI · SYNCING</span></div>
      <h1 class="title" id="page-title">观影总览</h1>
    </div>
    <div class="header-actions">
      <button class="pill-btn" id="btnRefreshPanel" onclick="refreshPanel(this)"><span>↻</span><span class="pill-text" id="refreshLabel">刷新</span></button>
      <button class="pill-btn" onclick="cycleTheme()"><span id="theme-icon">🌓</span><span id="theme-label" class="pill-text">自动</span></button>
    </div>
  </header>

  <!-- Tab 1: 总览 -->
  <main id="p-overview" class="page active">
    <div class="grid-4">
      <div class="card interactive" onclick="navTab('p-profile','观影画像',1)">
        <div class="val-big" id="kpiSearches" style="color:var(--accent)">0</div>
        <div class="val-sub">累计搜片</div>
      </div>
      <div class="card interactive" onclick="navTab('p-media','片单与任务',2)">
        <div class="val-big" id="kpiSaves" style="color:var(--success)">0</div>
        <div class="val-sub">累计转存</div>
      </div>
      <div class="card interactive" onclick="navTab('p-media','片单与任务',2)">
        <div class="val-big" id="kpiWatchlist" style="color:var(--purple)">0</div>
        <div class="val-sub">追剧片单</div>
      </div>
      <div class="card interactive" onclick="navTab('p-media','片单与任务',2)">
        <div class="val-big" id="kpiTasks" style="color:var(--warning)">0</div>
        <div class="val-sub">活跃任务</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">观影画像权重</div>
          <button class="pill-btn" onclick="navTab('p-profile','观影画像',1)">调优</button>
        </div>
        <div id="overviewProfileBars"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">网盘与通道状态</div>
          <button class="pill-btn" onclick="navTab('p-settings','配置与网络',3)">设置</button>
        </div>
        <div id="overviewStatusRows"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">快速喜好标签</div>
        <span class="badge purple" id="overviewEventBadge">0 条行为</span>
      </div>
      <div class="chip-wrap" id="overviewProfileChips"></div>
    </div>
    <div class="bottom-spacer"></div>
  </main>

  <!-- Tab 2: 观影画像 -->
  <main id="p-profile" class="page">
    <div class="card">
      <div class="card-header">
        <div class="card-title">快捷题材点选</div>
        <button class="pill-btn danger" onclick="resetProfile()">清空重建</button>
      </div>
      <div class="chip-wrap" id="quickGenreChips"></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">偏好题材与地区</div>
          <span class="badge accent">永久 +5.0</span>
        </div>
        <div class="form-label">题材标签</div>
        <div class="chip-wrap" id="chipsLikeGenres"></div>
        <div class="inline-add">
          <input class="form-control" id="inLikeGenres" placeholder="如：悬疑, 科幻" />
          <button class="btn" onclick="addProfileTag('likeGenres','inLikeGenres')">添加</button>
        </div>
        <div class="form-label" style="margin-top:14px;">国家 / 地区</div>
        <div class="chip-wrap" id="chipsLikeRegions"></div>
        <div class="inline-add">
          <input class="form-control" id="inLikeRegions" placeholder="如：韩国, 美国" />
          <button class="btn" onclick="addProfileTag('likeRegions','inLikeRegions')">添加</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">主创与代表作种子</div>
          <span class="badge purple">自动扩维</span>
        </div>
        <div class="form-label">钟爱导演</div>
        <div class="chip-wrap" id="chipsLikeDirectors"></div>
        <div class="inline-add">
          <input class="form-control" id="inLikeDirectors" placeholder="如：克里斯托弗·诺兰" />
          <button class="btn" onclick="addProfileTag('likeDirectors','inLikeDirectors')">添加</button>
        </div>
        <div class="form-label" style="margin-top:14px;">心头好电影</div>
        <div class="chip-wrap" id="chipsFavoriteSeeds"></div>
        <div class="inline-add">
          <input class="form-control" id="inFavoriteSeeds" placeholder="如：星际穿越, 杀人回忆" />
          <button class="btn" onclick="addProfileTag('favoriteSeeds','inFavoriteSeeds')">添加</button>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">排雷屏蔽题材</div>
          <span class="badge danger">硬过滤</span>
        </div>
        <div class="chip-wrap" id="chipsDislikeGenres"></div>
        <div class="inline-add">
          <input class="form-control" id="inDislikeGenres" placeholder="如：恐怖, 古装" />
          <button class="btn danger" onclick="addProfileTag('dislikeGenres','inDislikeGenres')">屏蔽</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">近期学习轨迹</div>
          <span class="badge neutral">30天半衰期</span>
        </div>
        <div id="recentEventsBox"></div>
      </div>
    </div>
    <div class="bottom-spacer"></div>
  </main>

  <!-- Tab 3: 片单与任务 -->
  <main id="p-media" class="page">
    <div class="card">
      <div class="card-header">
        <div class="card-title">添加追更 / 新片蹲守</div>
        <span class="badge success">有更新微信通知</span>
      </div>
      <div class="form-group">
        <input class="form-control" id="watchTitle" placeholder="输入电影或剧集片名，如：流浪地球3、难哄">
      </div>
      <div class="grid-2" style="margin-bottom:10px;">
        <select class="form-control" id="watchMode">
          <option value="resource_watch">电影 / 新片全网蹲守</option>
          <option value="episode_chase">连载剧集自动追更</option>
          <option value="quality_upgrade">4K / 杜比高画质洗版</option>
        </select>
        <select class="form-control" id="watchInterval">
          <option value="15">每 15 分钟巡检</option>
          <option value="30" selected>每 30 分钟巡检</option>
          <option value="60">每 60 分钟巡检</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-sec);cursor:pointer;">
          <input type="checkbox" id="watchAutoSave">
          <span>命中资源时自动转存夸克网盘</span>
        </label>
        <button class="btn" id="btnCreateWatch" onclick="createWatch(this)">开启追更通知</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">追剧片单与批量导入</div>
        <span class="badge purple" id="watchlistCountBadge">0 部</span>
      </div>
      <textarea class="form-control" id="batchImport" rows="2" placeholder="粘贴豆瓣豆列链接、含《片名》文案或多行片名"></textarea>
      <div style="margin-top:10px;display:flex;gap:8px;">
        <button class="btn" onclick="importList()">批量导入</button>
      </div>
      <div id="watchlistBox" style="margin-top:12px;"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">定时与追更监控</div>
        <span class="badge accent" id="tasksCountBadge">0 个</span>
      </div>
      <div id="tasksBox"></div>
    </div>
    <div class="bottom-spacer"></div>
  </main>

  <!-- Tab 4: 设置与网络 -->
  <main id="p-settings" class="page">
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">身份、域名与偏好</div>
          <button class="btn" onclick="saveSettings()">保存</button>
        </div>
        <div class="form-group">
          <label class="form-label">对外昵称</label>
          <input class="form-control" id="aliasName" placeholder="例如：小明" />
        </div>
        <div class="form-group">
          <label class="form-label">Web 面板访问域名</label>
          <input class="form-control" id="publicBaseUrl" placeholder="留空自动探测，或输入 https://your-domain.com" />
          <div class="mono-sub" id="effectiveDomainTip"></div>
        </div>
        <div class="form-group">
          <label class="form-label">默认保存目录</label>
          <input class="form-control" id="saveRootDir" placeholder="/我的资源" />
        </div>
        <div class="form-group">
          <label class="form-label">画质偏好</label>
          <input class="form-control" id="preferredQuality" placeholder="4K / 1080P / 原盘 / 4K杜比" />
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Alist / Emby 扫库 Webhook</label>
          <input class="form-control" id="webhookUrl" placeholder="https://..." />
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">多网盘凭证绑定</div>
          <span class="badge neutral">留空不变</span>
        </div>
        <div class="form-group">
          <label class="form-label">夸克 Cookie</label>
          <input class="form-control" id="quarkCookie" type="password" placeholder="粘贴新 Cookie 更新" />
        </div>
        <div class="form-group">
          <label class="form-label">阿里云盘 Refresh Token</label>
          <input class="form-control" id="aliyunToken" type="password" placeholder="粘贴 Refresh Token" />
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">115 网盘 Cookie</label>
          <input class="form-control" id="pan115Cookie" type="password" placeholder="需包含 UID/CID/SEID" />
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">微信通讯录</div>
          <span class="badge accent" id="contactsCountBadge">0 人</span>
        </div>
        <div id="contactsBox"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">资源频道健康度 Top 20</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="pill-btn" id="btnProbeChannels" onclick="probeChannelsNow(true, this)">测速刷新</button>
            <span class="badge success" id="channelsHealthBadge">0 / 0</span>
          </div>
        </div>
        <div id="channelsBox"></div>
      </div>
    </div>
    <div class="bottom-spacer"></div>
  </main>
</div>

<nav class="dock">
  <button class="dock-btn active" onclick="switchPage('p-overview','观影总览',this)">
    <svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
    <span>总览</span>
  </button>
  <button class="dock-btn" onclick="switchPage('p-profile','观影画像',this)">
    <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
    <span>画像</span>
  </button>
  <button class="dock-btn" onclick="switchPage('p-media','片单与任务',this)">
    <svg viewBox="0 0 24 24"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z"/></svg>
    <span>片单</span>
  </button>
  <button class="dock-btn" onclick="switchPage('p-settings','配置与网络',this)">
    <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
    <span>设置</span>
  </button>
</nav>

<script>
${AUI_BUNDLE_JS}
</script>
<script>
const TOKEN = "${safeToken}";
const QUICK_GENRES = ["悬疑","科幻","犯罪","动作","喜剧","爱情","剧情","战争","动画","纪录片","奇幻","恐怖"];
const ACTION_LABELS = { save:"转存", share:"安利", search:"搜片", skip:"跳过" };
const ACTION_BADGES = { save:"success", share:"purple", search:"accent", skip:"warning" };

function esc(s){
  return String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

let autoProbedOnce = false;
const TASK_TYPE_LABELS = {
  resource_watch: "全网蹲守",
  episode_chase: "剧集追更",
  quality_upgrade: "4K洗版",
  daily_recommend: "定时推荐",
  friday_weekly: "周末周报",
  disk_guard: "网盘巡检",
  watchlist_remind: "片单提醒",
  custom_reminder: "自定义"
};

function toast(msg, ms){
  showToast(String(msg || ""), typeof ms === "number" ? ms : 2600);
}

function navTab(pageId, title, dockIndex){
  const btns = document.querySelectorAll('.dock .dock-btn');
  switchPage(pageId, title, btns[dockIndex]);
}

async function api(path, body){
  try {
    const sep = path.indexOf("?") === -1 ? "?" : "&";
    const res = await fetch(path + sep + "token=" + encodeURIComponent(TOKEN), {
      method: body ? "POST" : "GET",
      headers: body ? {"Content-Type":"application/json"} : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      data = { ok: false, error: "服务响应解析失败 (" + res.status + ")" };
    }
    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, status: 401, error: "访问令牌已过期，请在微信发送 /web 获取最新控制台链接" };
      }
      return {
        ok: false,
        status: res.status,
        error: (data && data.error) ? data.error : ("请求失败 (" + res.status + ")")
      };
    }
    return data || { ok: true };
  } catch (err) {
    return { ok: false, error: "网络连接异常，请稍后重试" };
  }
}

function renderRemovableChips(containerId, items, category, badgeClass){
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items || items.length === 0) {
    el.innerHTML = '<span class="badge neutral">暂无</span>';
    return;
  }
  el.innerHTML = items.map(val =>
    '<span class="badge ' + badgeClass + '">' + esc(val) +
    '<span class="chip-del" data-cat="' + esc(category) + '" data-val="' + esc(val) + '">×</span></span>'
  ).join("");
  el.querySelectorAll('.chip-del').forEach(btn => {
    btn.onclick = () => removeProfileTag(btn.getAttribute('data-cat'), btn.getAttribute('data-val'));
  });
}

function renderChannels(ch){
  const info = ch || {};
  const topCh = info.topChannels || [];
  const total = info.total || 0;
  const openCount = info.circuitOpenCount || 0;
  const healthBadge = document.getElementById("channelsHealthBadge");
  if (healthBadge) {
    healthBadge.textContent = Math.max(0, total - openCount) + " / " + total;
  }
  const cb = document.getElementById("channelsBox");
  if (!cb) return;
  cb.innerHTML = topCh.length
    ? topCh.map(c =>
        '<div class="list-row"><span class="list-main">@' + esc(c.channelId) + '</span>' +
        '<div class="list-actions"><span class="badge ' + (c.circuitOpen ? 'danger' : 'success') + '">' + (c.score || 0) + '分 · ' + (c.avgLatencyMs || 0) + 'ms</span>' +
        (c.circuitOpen ? '<button class="pill-btn warning js-ch-reset" data-id="' + esc(c.channelId) + '">重置</button>' : '') +
        '</div></div>'
      ).join("")
    : '<div style="color:var(--text-sec);font-size:13px;">暂无频道数据</div>';
  cb.querySelectorAll(".js-ch-reset").forEach(b => {
    b.onclick = function(){ resetChannel(this.getAttribute("data-id"), this); };
  });
  return topCh;
}

async function probeChannelsNow(manual, btnEl){
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "测速中...";
  }
  try {
    const r = await api("/api/panel/channels/probe", {});
    if (r && r.ok !== false && r.channels) {
      renderChannels(r.channels);
      if (manual) toast("频道健康度已更新");
      return true;
    }
    if (manual) toast((r && r.error) || "频道测速失败");
    return false;
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = "测速刷新";
    }
  }
}

async function refreshPanel(btnEl){
  const label = document.getElementById("refreshLabel");
  if (btnEl) btnEl.disabled = true;
  if (label) label.textContent = "刷新中...";
  try {
    const okState = await load(false);
    await probeChannelsNow(false);
    if (okState) {
      toast("已同步最新状态");
    }
  } finally {
    if (btnEl) btnEl.disabled = false;
    if (label) label.textContent = "刷新";
  }
}

async function load(manual){
  const d = await api("/api/panel/state");
  if (!d || d.ok === false || d.error) {
    toast((d && d.error) || "数据加载失败");
    return false;
  }

  try {
    const settings = d.settings || {};
    const stats = d.stats || {};
    document.getElementById("headerBadge").textContent = "TVDAZI · " + (settings.alias || d.userId || "");
    document.getElementById("kpiSearches").textContent = stats.totalSearches || 0;
    document.getElementById("kpiSaves").textContent = stats.totalSaves || 0;
    document.getElementById("kpiWatchlist").textContent = (d.watchlist || []).length;
    document.getElementById("kpiTasks").textContent = (d.tasks || []).filter(t => t && t.enabled).length;

  const tp = d.tasteProfile || {};
  const likes = tp.explicitLikes || { genres:[], regions:[], directors:[], actors:[], favoriteSeeds:[] };
  const dislikes = tp.explicitDislikes || { genres:[] };

  // Overview: 权重条
  const bars = [
    ...(tp.topGenres || []).map(g => ({ label: g.name, val: g.score, color: "var(--accent)", tag: "题材" })),
    ...(tp.topRegions || []).map(r => ({ label: r.name, val: r.score, color: "var(--purple)", tag: "地区" })),
    ...(tp.topDirectors || []).map(x => ({ label: x.name, val: x.score, color: "var(--success)", tag: "导演" })),
  ].slice(0, 8);
  const maxScore = Math.max(...bars.map(b => b.val), 5);
  document.getElementById("overviewProfileBars").innerHTML = bars.length
    ? bars.map(b =>
        '<div class="diag-row-item"><div class="diag-row-header"><span style="font-weight:700;font-size:13px;">' + esc(b.label) +
        ' <span class="badge neutral">' + b.tag + '</span></span><span class="mono-sub" style="margin:0;">' + b.val + '</span></div>' +
        '<div class="diag-bar-track"><div class="diag-bar-fill" style="width:' + Math.min(100, Math.round((b.val / maxScore) * 100)) + '%;background:' + b.color + ';"></div></div></div>'
      ).join("")
    : '<div style="color:var(--text-sec);font-size:13px;">点击右上「调优」或转存几部电影即可自动生成权重</div>';

  document.getElementById("overviewEventBadge").textContent = (tp.eventCount || 0) + " 条行为";
  const allQuickChips = [
    ...(likes.genres || []).map(g => '<span class="badge accent">❤️ ' + esc(g) + '</span>'),
    ...(likes.favoriteSeeds || []).map(s => '<span class="badge purple">🎬 《' + esc(s) + '》</span>'),
    ...(dislikes.genres || []).map(g => '<span class="badge danger">🚫 ' + esc(g) + '</span>'),
  ];
  document.getElementById("overviewProfileChips").innerHTML = allQuickChips.length
    ? allQuickChips.join("")
    : '<span class="badge neutral">冷启动模式 · 豆瓣高分推荐</span>';

  const statusItems = [
    { name: "夸克网盘", ok: d.settings.hasQuarkCookie },
    { name: "阿里云盘", ok: d.settings.hasAliyunToken },
    { name: "115网盘", ok: d.settings.has115Cookie },
    { name: "DeepSeek独立Key", ok: d.settings.hasDeepSeekKey },
    { name: "扫库Webhook", ok: Boolean(d.settings.webhookUrl) },
  ];
  document.getElementById("overviewStatusRows").innerHTML = statusItems.map(s =>
    '<div class="list-row"><span class="list-main">' + s.name + '</span><span class="badge ' + (s.ok ? 'success' : 'neutral') + '">' + (s.ok ? '已配置' : '默认/未绑') + '</span></div>'
  ).join("");

  // Profile Tab
  const likedGenreSet = new Set((likes.genres || []).map(g => g.toLowerCase()));
  const qgEl = document.getElementById("quickGenreChips");
  qgEl.innerHTML = QUICK_GENRES.map(g => {
    const active = likedGenreSet.has(g.toLowerCase());
    return '<button class="pill-btn ' + (active ? 'accent' : '') + '" data-genre="' + g + '" data-active="' + (active ? '1' : '0') + '">' + (active ? '✓ ' : '+ ') + g + '</button>';
  }).join("");
  qgEl.querySelectorAll('button').forEach(btn => {
    btn.onclick = async () => {
      if (btn.dataset.active === '1') await removeProfileTag('likeGenres', btn.dataset.genre);
      else await submitProfileAdd('likeGenres', btn.dataset.genre);
    };
  });

  renderRemovableChips("chipsLikeGenres", likes.genres, "likeGenres", "accent");
  renderRemovableChips("chipsLikeRegions", likes.regions, "likeRegions", "purple");
  renderRemovableChips("chipsLikeDirectors", likes.directors, "likeDirectors", "success");
  renderRemovableChips("chipsFavoriteSeeds", likes.favoriteSeeds, "favoriteSeeds", "purple");
  renderRemovableChips("chipsDislikeGenres", dislikes.genres, "dislikeGenres", "danger");

  const events = tp.recentEvents || [];
  document.getElementById("recentEventsBox").innerHTML = events.length
    ? events.map(ev =>
        '<div class="list-row"><span class="list-main">《' + esc(ev.title) + '》' +
        ((ev.genres && ev.genres.length) ? ' <span class="badge neutral">' + esc(ev.genres.slice(0,2).join('/')) + '</span>' : '') +
        '</span><span class="badge ' + (ACTION_BADGES[ev.action] || 'neutral') + '">' + (ACTION_LABELS[ev.action] || ev.action) + '</span></div>'
      ).join("")
    : '<div style="color:var(--text-sec);font-size:13px;">暂无行为记录</div>';

  // Media & Tasks Tab
  const wl = d.watchlist || [];
  document.getElementById("watchlistCountBadge").textContent = wl.length + " 部";
  const wb = document.getElementById("watchlistBox");
  wb.innerHTML = wl.length
    ? wl.map(w =>
        '<div class="list-row"><span class="list-main">《' + esc(w.title) + '》 <span class="badge ' + (w.status === 'completed' ? 'success' : 'accent') + '">' + esc(w.status) + '</span></span>' +
        '<div class="list-actions"><button class="pill-btn js-watch-done" data-title="' + esc(w.title) + '">已看</button><button class="pill-btn danger js-watch-del" data-title="' + esc(w.title) + '">删</button></div></div>'
      ).join("")
    : '<div style="color:var(--text-sec);font-size:13px;">暂无片单</div>';
  wb.querySelectorAll(".js-watch-done").forEach(b => {
    b.onclick = function(){ setStatus(this.getAttribute("data-title"), "completed", this); };
  });
  wb.querySelectorAll(".js-watch-del").forEach(b => {
    b.onclick = function(){ delWatch(this.getAttribute("data-title"), this); };
  });

  const tasks = (d.tasks || []).filter(t => t && t.id);
  document.getElementById("tasksCountBadge").textContent = tasks.length + " 个";
  const tb = document.getElementById("tasksBox");
  tb.innerHTML = tasks.length
    ? tasks.map(t => {
        const typeLabel = TASK_TYPE_LABELS[t.type] || "监控";
        const statusCls = t.enabled ? "success" : (t.status === "completed" ? "accent" : "neutral");
        const statusLabel = t.enabled ? "运行中" : (t.status === "completed" ? "已命中" : "已暂停");
        return '<div class="list-row"><span class="list-main">' + esc(t.title) +
          ' <span class="badge purple">' + esc(typeLabel) + '</span>' +
          ' <span class="badge ' + statusCls + '">' + statusLabel + '</span></span>' +
          '<div class="list-actions"><button class="pill-btn js-task-tog" data-id="' + esc(t.id) + '">' + (t.enabled ? '暂停' : '恢复') + '</button><button class="pill-btn danger js-task-del" data-id="' + esc(t.id) + '">删</button></div></div>';
      }).join("")
    : '<div style="color:var(--text-sec);font-size:13px;">暂无定时任务</div>';
  tb.querySelectorAll(".js-task-tog").forEach(b => {
    b.onclick = function(){ toggleTask(this.getAttribute("data-id"), this); };
  });
  tb.querySelectorAll(".js-task-del").forEach(b => {
    b.onclick = function(){ delTask(this.getAttribute("data-id"), this); };
  });

  // Settings Tab
  document.getElementById("aliasName").value = settings.alias || "";
  document.getElementById("publicBaseUrl").value = settings.publicBaseUrl || "";
  document.getElementById("effectiveDomainTip").textContent = "生效前缀: " + (settings.effectiveBaseUrl || "");
  document.getElementById("saveRootDir").value = settings.saveRootDir || "";
  document.getElementById("preferredQuality").value = settings.preferredQuality || "any";
  document.getElementById("webhookUrl").value = settings.webhookUrl || "";

  const contacts = d.contacts || [];
  document.getElementById("contactsCountBadge").textContent = contacts.length + " 人";
  document.getElementById("contactsBox").innerHTML = contacts.length
    ? contacts.map(c =>
        '<div class="list-row"><span class="list-main">' + c.index + '. ' + esc(c.displayName) + (c.isSelf ? ' <span class="badge success">我</span>' : '') + '</span><span class="badge neutral">' + esc(c.maskedId) + '</span></div>'
      ).join("")
    : '<div style="color:var(--text-sec);font-size:13px;">暂无联系人</div>';

  const topCh = renderChannels(d.channels) || [];
  const needInitProbe = topCh.length > 0 && topCh.every(c => !c.avgLatencyMs && !c.successCount && !c.failCount);
  if (!autoProbedOnce && needInitProbe) {
    autoProbedOnce = true;
    setTimeout(function(){ probeChannelsNow(false); }, 60);
  }

  if (manual) toast("已同步最新状态");
  return true;
  } catch (renderErr) {
    toast("页面渲染异常，请重试");
    return false;
  }
}

async function submitProfileAdd(category, value){
  const r = await api("/api/panel/profile", { action: "add", category, value });
  if (r && r.ok !== false) {
    toast("画像偏好已更新");
    await load(false);
  } else {
    toast((r && r.error) || "更新失败");
  }
}

async function addProfileTag(category, inputId){
  const input = document.getElementById(inputId);
  const val = (input.value || "").trim();
  if (!val) return;
  input.value = "";
  await submitProfileAdd(category, val);
}

async function removeProfileTag(category, value){
  const r = await api("/api/panel/profile", { action: "remove", category, value });
  if (r && r.ok !== false) {
    toast("已移除 " + value);
    await load(false);
  } else {
    toast((r && r.error) || "移除失败");
  }
}

async function resetProfile(){
  const r = await api("/api/panel/profile", { action: "reset" });
  if (r && r.ok === false) {
    toast(r.error || "重置失败");
    return;
  }
  toast("画像已清空重建");
  await load(false);
}

async function saveSettings(){
  const r = await api("/api/panel/settings", {
    alias: document.getElementById("aliasName").value,
    publicBaseUrl: document.getElementById("publicBaseUrl").value,
    saveRootDir: document.getElementById("saveRootDir").value,
    preferredQuality: document.getElementById("preferredQuality").value,
    webhookUrl: document.getElementById("webhookUrl").value,
    quarkCookie: document.getElementById("quarkCookie").value,
    aliyunToken: document.getElementById("aliyunToken").value,
    pan115Cookie: document.getElementById("pan115Cookie").value,
  });
  if (r && r.ok === false) {
    toast(r.error || "保存失败");
    return;
  }
  toast("配置已保存并生效");
  await load(false);
}

async function createWatch(btnEl){
  const input = document.getElementById("watchTitle");
  const title = (input && input.value ? input.value : "").trim();
  if (!title) {
    toast("请输入电影或剧集片名");
    return;
  }
  const modeEl = document.getElementById("watchMode");
  const intervalEl = document.getElementById("watchInterval");
  const autoSaveEl = document.getElementById("watchAutoSave");
  if (btnEl) btnEl.disabled = true;
  try {
    const r = await api("/api/panel/tasks", {
      action: "create_watch",
      title: title,
      mode: modeEl ? modeEl.value : "resource_watch",
      intervalMinutes: intervalEl ? Number(intervalEl.value) : 30,
      autoSave: autoSaveEl ? Boolean(autoSaveEl.checked) : false
    });
    if (r && r.ok !== false) {
      input.value = "";
      toast("已开启追更监控，有更新将微信通知");
      await load(false);
    } else {
      toast((r && r.error) || "添加追更失败");
    }
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function importList(){
  const rawText = document.getElementById("batchImport").value;
  if (!rawText.trim()) return;
  const r = await api("/api/panel/watchlist", { action: "import", rawText });
  if (r && r.ok === false) {
    toast(r.error || "导入失败");
    return;
  }
  document.getElementById("batchImport").value = "";
  const addedCount = (r && r.added && r.added.length) ? r.added.length : 0;
  toast("新增收录 " + addedCount + " 部");
  await load(false);
}

async function setStatus(title, status, btnEl){
  if (btnEl) btnEl.disabled = true;
  try {
    const r = await api("/api/panel/watchlist", { action:"status", title:title, status:status });
    if (r && r.ok === false) {
      toast(r.error || "更新片单失败");
      return;
    }
    toast("已标为已看");
    await load(false);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function delWatch(title, btnEl){
  if (btnEl) btnEl.disabled = true;
  try {
    const r = await api("/api/panel/watchlist", { action:"remove", title:title });
    if (r && r.ok === false) {
      toast(r.error || "移除片单失败");
      return;
    }
    toast("已移出片单");
    await load(false);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function toggleTask(taskId, btnEl){
  if (!taskId) return;
  if (btnEl) btnEl.disabled = true;
  try {
    const r = await api("/api/panel/tasks", { action:"toggle", taskId:taskId });
    if (r && r.ok === false) {
      toast(r.error || "切换任务失败");
      await load(false);
      return;
    }
    toast("任务状态已切换");
    await load(false);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function delTask(taskId, btnEl){
  if (!taskId) return;
  if (btnEl) btnEl.disabled = true;
  try {
    const r = await api("/api/panel/tasks", { action:"delete", taskId:taskId });
    if (r && r.ok === false) {
      toast(r.error || "删除任务失败");
      await load(false);
      return;
    }
    toast("已删除任务");
    await load(false);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function resetChannel(channelId, btnEl){
  if (!channelId) return;
  if (btnEl) btnEl.disabled = true;
  try {
    const r = await api("/api/panel/channels/reset", { channelId:channelId });
    if (r && r.ok === false) {
      toast(r.error || "重置失败");
      return;
    }
    toast("频道熔断已重置");
    await load(false);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

load();
</script>
</body>
</html>`;
  }
}
