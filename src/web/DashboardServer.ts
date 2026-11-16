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
   * 为指定微信用户签发带时效性的 HMAC 访问 Token（默认 15 分钟有效）
   */
  static issueUserToken(userId: string, ttlMs: number = 15 * 60 * 1000): string {
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
          tasteProfile: UserProfileService.getInstance().getTopTags(userId),
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
      const action = String(body.action || '');
      const taskId = String(body.taskId || '');
      if (action === 'toggle' && taskId) {
        const task = scheduler.toggleUserTaskById(userId, taskId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: Boolean(task), task }));
        return true;
      }
      if (action === 'delete' && taskId) {
        const ok = scheduler.deleteUserTaskById(userId, taskId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
        return true;
      }
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
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>电视搭子 (TVdazi) 个人控制面板</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px;}
  .wrap{max-width:760px;margin:0 auto;display:grid;gap:16px;}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;}
  h1{margin:0 0 4px;font-size:20px;color:#38bdf8;}
  h2{margin:0 0 12px;font-size:16px;color:#f8fafc;}
  label{display:block;font-size:12px;color:#94a3b8;margin:8px 0 4px;}
  input,textarea,select{width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #475569;color:#f8fafc;border-radius:8px;padding:8px 10px;font-size:14px;}
  button{background:#0284c7;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;margin-top:10px;}
  button.sec{background:#475569;}
  button.del{background:#dc2626;}
  .row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #334155;gap:8px;}
  .badge{font-size:11px;padding:2px 8px;border-radius:99px;background:#334155;color:#cbd5e1;}
  .ok{background:#065f46;color:#6ee7b7;}
  .warn{background:#7f1d1d;color:#fca5a5;}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>电视搭子 (TVdazi) 影视网盘控制台</h1>
    <div id="userMeta" style="font-size:12px;color:#94a3b8;">加载中...</div>
  </div>
  <div class="card">
    <h2>网盘凭证、域名与偏好设置</h2>
    <label>我的对外昵称（用于好友通过机器人传话称呼你）</label><input id="aliasName" placeholder="例如：小明" />
    <label>Web 面板访问域名（如 https://pan.example.com，留空则自动使用服务器公网 IP）</label>
    <input id="publicBaseUrl" placeholder="留空自动探测，或输入 https://your-domain.com" />
    <div id="effectiveDomainTip" style="font-size:11px;color:#94a3b8;margin-top:4px;"></div>
    <label>默认保存目录</label><input id="saveRootDir" placeholder="/我的资源" />
    <label>画质偏好（支持 4K / 1080P / 原盘 / 4K杜比 / 体积小1080P）</label><input id="preferredQuality" />
    <label>Alist / Emby 扫库 Webhook</label><input id="webhookUrl" placeholder="https://..." />
    <label>夸克 Cookie（留空则保持不变）</label><input id="quarkCookie" type="password" placeholder="粘贴新 Cookie 更新" />
    <label>阿里云盘 Refresh Token（留空不变）</label><input id="aliyunToken" type="password" placeholder="粘贴 Refresh Token" />
    <label>115 网盘 Cookie（留空不变）</label><input id="pan115Cookie" type="password" placeholder="需包含 UID/CID/SEID" />
    <button onclick="saveSettings()">保存配置</button>
    <span id="saveMsg" style="margin-left:10px;font-size:12px;color:#6ee7b7;"></span>
  </div>
  <div class="card">
    <h2>追剧片单管理 & 批量导入</h2>
    <textarea id="batchImport" rows="3" placeholder="支持粘贴豆瓣豆列链接、含《片名》的推荐文案或多行片名"></textarea>
    <button onclick="importList()">批量导入片单</button>
    <div id="watchlistBox" style="margin-top:10px;"></div>
  </div>
  <div class="card">
    <h2>定时与蹲守任务</h2>
    <div id="tasksBox"></div>
  </div>
  <div class="card">
    <h2>我的观影口味画像</h2>
    <div id="profileBox" style="font-size:13px;line-height:1.7;"></div>
    <button class="del" onclick="resetProfile()">清空重建画像</button>
  </div>
  <div class="card">
    <h2>微信通讯录成员（传话可用联系人）</h2>
    <div id="contactsBox"></div>
  </div>
  <div class="card">
    <h2>资源频道健康度 Top 20</h2>
    <div id="channelsBox"></div>
  </div>
</div>
<script>
const TOKEN = "${safeToken}";
function esc(s){ return String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
async function api(path, body){
  const res = await fetch(path + "?token=" + encodeURIComponent(TOKEN), {
    method: body ? "POST" : "GET",
    headers: body ? {"Content-Type":"application/json"} : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}
async function load(){
  const d = await api("/api/panel/state");
  document.getElementById("userMeta").textContent = "账号: " + d.userId + " | 找片 " + d.stats.totalSearches + " 次 | 转存 " + d.stats.totalSaves + " 部 | 夸克:" + (d.settings.hasQuarkCookie?"已绑":"未绑") + " 阿里:" + (d.settings.hasAliyunToken?"已绑":"未绑") + " 115:" + (d.settings.has115Cookie?"已绑":"未绑");
  document.getElementById("aliasName").value = d.settings.alias || "";
  document.getElementById("publicBaseUrl").value = d.settings.publicBaseUrl || "";
  document.getElementById("effectiveDomainTip").textContent = "当前微信 /web 生效前缀: " + (d.settings.effectiveBaseUrl || "");
  document.getElementById("saveRootDir").value = d.settings.saveRootDir || "";
  document.getElementById("preferredQuality").value = d.settings.preferredQuality || "any";
  document.getElementById("webhookUrl").value = d.settings.webhookUrl || "";
  const tp = d.tasteProfile || {};
  const tpParts = [];
  if ((tp.topGenres||[]).length) tpParts.push("偏好题材：" + tp.topGenres.map(g => esc(g.name)+"("+g.score+")").join(" · "));
  if ((tp.topRegions||[]).length) tpParts.push("常看地区：" + tp.topRegions.map(r => esc(r.name)+"("+r.score+")").join(" · "));
  if ((tp.topDirectors||[]).length) tpParts.push("喜欢导演：" + tp.topDirectors.map(x => esc(x.name)).join("、"));
  if ((tp.favoriteSeeds||[]).length) tpParts.push("心头好片：" + tp.favoriteSeeds.map(t => "《"+esc(t)+"》").join("、"));
  if ((tp.dislikedGenres||[]).length) tpParts.push("排雷屏蔽：" + tp.dislikedGenres.map(g => esc(g)).join("、"));
  document.getElementById("profileBox").innerHTML = tpParts.length ? tpParts.join("<br>") + "<br><span style='color:#94a3b8;'>累计行为事件：" + (tp.eventCount||0) + " 条</span>" : "<span style='color:#64748b;'>暂未沉淀偏好，可以在微信说“我喜欢科幻/悬疑”或转存几部电影自动生成。</span>";
  document.getElementById("contactsBox").innerHTML = (d.contacts || []).map(c => '<div class="row"><span>'+c.index+'. '+esc(c.displayName)+(c.isSelf?' <span class="badge ok">我</span>':'')+'</span><span class="badge">'+esc(c.maskedId)+'</span></div>').join("") || "<div style='color:#64748b;font-size:13px;'>暂无联系人</div>";
  const wb = document.getElementById("watchlistBox");
  wb.innerHTML = d.watchlist.map(w => '<div class="row"><span>《'+esc(w.title)+'》 <span class="badge">'+esc(w.status)+'</span></span><div><button class="sec js-watch-done" data-title="'+esc(w.title)+'">标为已看</button> <button class="del js-watch-del" data-title="'+esc(w.title)+'">删</button></div></div>').join("") || "<div style='color:#64748b;font-size:13px;'>暂无片单</div>";
  wb.querySelectorAll(".js-watch-done").forEach(b => b.onclick = () => setStatus(b.dataset.title, "completed"));
  wb.querySelectorAll(".js-watch-del").forEach(b => b.onclick = () => delWatch(b.dataset.title));
  const tb = document.getElementById("tasksBox");
  tb.innerHTML = d.tasks.map(t => '<div class="row"><span>'+esc(t.title)+' <span class="badge '+(t.enabled?'ok':'')+'">'+(t.enabled?'运行中':'已暂停')+'</span></span><div><button class="sec js-task-tog" data-id="'+esc(t.id)+'">'+(t.enabled?'暂停':'恢复')+'</button> <button class="del js-task-del" data-id="'+esc(t.id)+'">删</button></div></div>').join("") || "<div style='color:#64748b;font-size:13px;'>暂无定时任务</div>";
  tb.querySelectorAll(".js-task-tog").forEach(b => b.onclick = () => toggleTask(b.dataset.id));
  tb.querySelectorAll(".js-task-del").forEach(b => b.onclick = () => delTask(b.dataset.id));
  document.getElementById("channelsBox").innerHTML = d.channels.topChannels.map(c => '<div class="row"><span>@'+esc(c.channelId)+'</span><span class="badge '+(c.circuitOpen?'warn':'ok')+'">健康分 '+c.score+' · '+c.avgLatencyMs+'ms</span></div>').join("");
}
async function saveSettings(){
  const msgEl = document.getElementById("saveMsg");
  msgEl.textContent = "保存中...";
  msgEl.style.color = "#94a3b8";
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
  if(r && r.ok === false){
    msgEl.style.color = "#fca5a5";
    msgEl.textContent = r.error || "保存失败";
    return;
  }
  msgEl.style.color = "#6ee7b7";
  msgEl.textContent = "已保存并实时生效";
  load();
}
async function importList(){
  const rawText = document.getElementById("batchImport").value;
  if(!rawText.trim()) return;
  await api("/api/panel/watchlist", { action: "import", rawText });
  document.getElementById("batchImport").value = "";
  load();
}
async function setStatus(title, status){ await api("/api/panel/watchlist", { action:"status", title, status }); load(); }
async function delWatch(title){ await api("/api/panel/watchlist", { action:"remove", title }); load(); }
async function toggleTask(taskId){ await api("/api/panel/tasks", { action:"toggle", taskId }); load(); }
async function delTask(taskId){ await api("/api/panel/tasks", { action:"delete", taskId }); load(); }
async function resetProfile(){ await api("/api/panel/profile/reset", {}); load(); }
load();
</script>
</body>
</html>`;
  }
}
