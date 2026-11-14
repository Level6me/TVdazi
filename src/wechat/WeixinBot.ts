import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import { exec } from 'child_process';
import { DeepSeekAgent } from '../agent/DeepSeekAgent';

import { downloadAndDecryptWechatImage } from './CdnDecrypt';
import { uploadImageToWechatCdn } from './CdnUpload';
import { SchedulerService } from '../services/SchedulerService';
import { atomicWriteFileSync } from '../utils/FileUtils';

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const DATA_DIR = path.resolve(__dirname, '../../data');
const AUTH_FILE = path.resolve(DATA_DIR, 'weixin_auth.json');
const SYNC_FILE = path.resolve(DATA_DIR, 'weixin_sync.dat');
const USER_ROUTES_FILE = path.resolve(DATA_DIR, 'user_routes.json');
const QR_IMG_PATH = path.resolve(__dirname, '../../wechat_login_qr.png');

interface AuthData {
  botToken: string;
  botId: string;
  baseUrl: string;
  userId?: string;
}

interface UserRouteInfo {
  botId: string;
  contextToken?: string;
  updatedAt: number;
}

const ACCOUNTS_DIR = path.resolve(DATA_DIR, 'accounts');

export class WeixinBot {
  private static instance: WeixinBot;
  private agent: DeepSeekAgent;
  private activeBots: Map<string, { auth: AuthData; isRunning: boolean; syncBuf: string }> = new Map();
  private userRoutes: Record<string, UserRouteInfo> = {};
  private authData: AuthData | null = null;
  private isRunning: boolean = false;
  private syncBuf: string = '';
  private processedMsgIds: Map<string, number> = new Map();
  private userTaskQueues: Map<string, Promise<void>> = new Map();

  constructor() {
    this.agent = new DeepSeekAgent();
    this.ensureDataDir();
    this.loadAuth();
    this.loadSyncBuf();
    this.loadUserRoutes();
    WeixinBot.instance = this;
  }

  public static getInstance(): WeixinBot {
    if (!WeixinBot.instance) {
      WeixinBot.instance = new WeixinBot();
    }
    return WeixinBot.instance;
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(ACCOUNTS_DIR)) {
      fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    }
  }

  public getAllBotTokens(): string[] {
    const tokens: string[] = [];
    if (this.authData?.botToken) tokens.push(this.authData.botToken);
    try {
      if (fs.existsSync(ACCOUNTS_DIR)) {
        const files = fs.readdirSync(ACCOUNTS_DIR);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const data = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file), 'utf-8'));
            if (data.botToken && !tokens.includes(data.botToken)) {
              tokens.push(data.botToken);
            }
          }
        }
      }
    } catch {}
    return tokens;
  }

  private loadAuth() {
    try {
      if (fs.existsSync(AUTH_FILE)) {
        this.authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
        if (this.authData?.baseUrl) {
          this.authData.baseUrl = this.authData.baseUrl.replace(/^https?:\/\/https?:\/\//, 'https://');
        }
      }
    } catch {
      this.authData = null;
    }
  }

  public saveAuth(data: AuthData) {
    data.baseUrl = data.baseUrl.replace(/^https?:\/\/https?:\/\//, 'https://');
    this.authData = data;
    atomicWriteFileSync(AUTH_FILE, JSON.stringify(data, null, 2));

    // 同时以 botId 保存到多账号凭证池
    if (data.botId && data.botId !== 'undefined') {
      const accountPath = path.join(ACCOUNTS_DIR, `${data.botId}.json`);
      atomicWriteFileSync(accountPath, JSON.stringify(data, null, 2));
    }
  }

  public saveAccountAuth(data: AuthData) {
    data.baseUrl = data.baseUrl.replace(/^https?:\/\/https?:\/\//, 'https://');
    if (data.botId && data.botId !== 'undefined') {
      const accountPath = path.join(ACCOUNTS_DIR, `${data.botId}.json`);
      atomicWriteFileSync(accountPath, JSON.stringify(data, null, 2));
    }
    // 如果主 auth 不存在，顺便设为主账号
    if (!this.authData) {
      this.saveAuth(data);
    }
  }

  private loadSyncBuf() {
    try {
      if (fs.existsSync(SYNC_FILE)) {
        this.syncBuf = fs.readFileSync(SYNC_FILE, 'utf-8').trim();
      }
    } catch {
      this.syncBuf = '';
    }
  }

  private saveSyncBuf(buf: string) {
    this.syncBuf = buf;
    try {
      atomicWriteFileSync(SYNC_FILE, buf);
    } catch {}
  }

  private getCommonHeaders(token?: string) {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    const wechatUin = Buffer.from(String(uint32), 'utf-8').toString('base64');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': wechatUin,
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132106',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    }
    return headers;
  }

  /**
   * 获取微信登录二维码并生成本地图片与终端二维码
   */
  async requestLoginQr(): Promise<{ qrcode: string; qrcodeUrl: string; imagePath: string }> {
    console.log('[WeixinBot] 正在向腾讯微信服务器申请登录二维码...');

    const res = await axios.post(
      `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      { local_token_list: [] },
      { headers: this.getCommonHeaders(), timeout: 10000 }
    );

    const qrcode = res.data.qrcode;
    const qrcodeUrl = res.data.qrcode_img_content;

    if (!qrcode || !qrcodeUrl) {
      throw new Error(`获取二维码失败: ${JSON.stringify(res.data)}`);
    }

    // 生成高清 PNG 图片
    await QRCode.toFile(QR_IMG_PATH, qrcodeUrl, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    // 终端字符二维码
    const terminalQR = await QRCode.toString(qrcodeUrl, { type: 'terminal', small: true });
    console.log('\n' + terminalQR + '\n');
    console.log(`[WeixinBot] 二维码图片已生成: ${QR_IMG_PATH}`);
    console.log(`[WeixinBot] 二维码跳转链接: ${qrcodeUrl}`);

    this.pushToFeishu(QR_IMG_PATH);

    return { qrcode, qrcodeUrl, imagePath: QR_IMG_PATH };
  }

  private pushToFeishu(filePath: string) {
    const pusher = (process.env.FEISHU_PUSH_SCRIPT || '').trim();
    if (pusher && fs.existsSync(pusher)) {
      exec(`python3 "${pusher}" "${filePath}"`, () => {});
    }
  }

  private maskSensitiveLog(text: string): string {
    if (/^\/(?:set-quark|set-key|set-deepseek)\b/i.test(text.trim())) {
      const cmd = text.trim().split(/\s+/)[0];
      return `${cmd} [REDACTED]`;
    }
    return text.length > 120 ? `${text.slice(0, 120)}...` : text;
  }

  /**
   * 轮询扫码确认结果
   */
  async waitForLogin(qrcode: string, timeoutMs: number = 300000): Promise<AuthData> {
    console.log('[WeixinBot] 开始等待用户扫码确认 (有效时间 5 分钟)...');
    const deadline = Date.now() + timeoutMs;
    let baseUrl = FIXED_BASE_URL;

    while (Date.now() < deadline) {
      try {
        const res = await axios.get(
          `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
          { headers: this.getCommonHeaders(), timeout: 35000 }
        );

        const status = res.data?.status;
        console.log(`[WeixinBot 登录状态] ${status}`);

        if (status === 'scaned') {
          console.log('📱 手机已扫描，请在微信端点击【允许】或确认授权...');
        } else if (status === 'scaned_but_redirect') {
          if (res.data.redirect_host) {
            baseUrl = `https://${res.data.redirect_host}`;
            console.log(`[WeixinBot] 切换服务器节点: ${baseUrl}`);
          }
        } else if (status === 'confirmed') {
          let resolvedBaseUrl = res.data.baseurl || baseUrl;
          if (!resolvedBaseUrl.startsWith('http://') && !resolvedBaseUrl.startsWith('https://')) {
            resolvedBaseUrl = `https://${resolvedBaseUrl}`;
          }
          resolvedBaseUrl = resolvedBaseUrl.replace(/^https?:\/\/https?:\/\//, 'https://');

          const authData: AuthData = {
            botToken: res.data.bot_token,
            botId: res.data.ilink_bot_id,
            baseUrl: resolvedBaseUrl,
            userId: res.data.ilink_user_id,
          };
          this.saveAccountAuth(authData);
          this.startAccountLoop(authData).catch((e) => console.error(`[新账号 ${authData.botId} 启动异常]`, e.message));
          console.log('🎉 微信个人号绑定授权成功！');
          return authData;
        } else if (status === 'expired') {
          throw new Error('二维码已过期，请重新发起登录！');
        }
      } catch (err: any) {
        if (err.message && err.message.includes('过期')) throw err;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('扫码登录超时');
  }

  /**
   * 检查消息是否已处理过（防止长轮询网络重传导致重复转存/重复回复）
   */
  private isDuplicateMessage(botId: string, msg: any): boolean {
    const rawId = msg.message_id || msg.msg_id || msg.client_id || msg.seq;
    if (!rawId) return false;
    const key = `${botId}:${rawId}`;
    const now = Date.now();
    if (this.processedMsgIds.has(key)) {
      return true;
    }
    this.processedMsgIds.set(key, now);
    if (this.processedMsgIds.size > 1500) {
      for (const [k, ts] of this.processedMsgIds) {
        if (now - ts > 10 * 60 * 1000 || this.processedMsgIds.size > 1000) {
          this.processedMsgIds.delete(k);
        } else {
          break;
        }
      }
    }
    return false;
  }

  /**
   * 按用户串行排队执行任务（不同用户完全并发，同一用户多条连发严格保序，防止会话状态竞态）
   */
  private enqueueUserTask(userKey: string, task: () => Promise<void>): void {
    const prev = this.userTaskQueues.get(userKey) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .catch((err: any) => {
        console.error(`[Weixin 用户队列异常] ${userKey}:`, err?.message || err);
      })
      .finally(() => {
        if (this.userTaskQueues.get(userKey) === next) {
          this.userTaskQueues.delete(userKey);
        }
      });
    this.userTaskQueues.set(userKey, next);
  }

  /**
   * 启动指定账号的消息长轮询循环
   */
  async startAccountLoop(auth: AuthData) {
    if (this.activeBots.has(auth.botId) && this.activeBots.get(auth.botId)?.isRunning) {
      console.log(`[WeixinBot] 账号 ${auth.botId} 已经在监听中`);
      return;
    }

    const botState = {
      auth,
      isRunning: true,
      syncBuf: this.loadAccountSyncBuf(auth.botId),
    };
    this.activeBots.set(auth.botId, botState);

    const baseUrl = (auth.baseUrl || FIXED_BASE_URL).replace(/^https?:\/\/https?:\/\//, 'https://');
    const token = auth.botToken;

    console.log(`[WeixinBot] 正在启动微信消息监听引擎 (Bot ID: ${auth.botId})...`);

    while (botState.isRunning) {
      try {
        const res = await axios.post(
          `${baseUrl}/ilink/bot/getupdates`,
          {
            get_updates_buf: botState.syncBuf,
            base_info: {
              channel_version: '2.4.10',
              bot_agent: 'OpenClaw',
            },
          },
          { headers: this.getCommonHeaders(token), timeout: 40000 }
        );

        if (res.data?.get_updates_buf) {
          botState.syncBuf = res.data.get_updates_buf;
          this.saveAccountSyncBuf(auth.botId, res.data.get_updates_buf);
        }

        const msgs = res.data?.msgs || [];
        if (msgs.length > 0) {
          console.log(`[WeixinBot-${auth.botId}] 收到 ${msgs.length} 条原始消息包`);
        }
        for (const msg of msgs) {
          console.log(`[WeixinBot-${auth.botId} 消息详情] msg_type=${msg.message_type}, from=${msg.from_user_id}, to=${msg.to_user_id}`);
          // 只处理用户发出的消息 (message_type === 1)
          if (msg.message_type === 1 && msg.from_user_id) {
            if (this.isDuplicateMessage(auth.botId, msg)) {
              continue;
            }
            const fromUser = msg.from_user_id;
            const contextToken = msg.context_token;
            this.recordUserRoute(fromUser, auth.botId, contextToken);
            const textItem = msg.item_list?.find((i: any) => i.type === 1);
            const imageItem = msg.item_list?.find((i: any) => i.type === 2);
            const userText = textItem?.text_item?.text?.trim();
            const userQueueKey = `${auth.botId}:${fromUser}`;

            if (userText) {
              console.log(`[Weixin 收到消息] [Bot:${auth.botId}] 来自 ${fromUser}: ${this.maskSensitiveLog(userText)}`);

              // 异步入队处理：不阻塞长轮询心跳，同时保证同一用户连发消息按顺序执行
              this.enqueueUserTask(userQueueKey, async () => {
                try {
                  let searchHintSent = false;
                  const sendSearchHintOnce = async (hintMsg: string) => {
                    if (searchHintSent) return;
                    searchHintSent = true;
                    await this.sendTextMessageWithAuth(auth, fromUser, hintMsg, contextToken);
                  };

                  if (this.agent.isPendingImageSearchConfirm(fromUser, userText)) {
                    await sendSearchHintOnce('🔍 收到！正在全网搜索并通过 AI 精筛匹配资源，请稍候...');
                  }
                  const reply = await this.agent.chat(userText, [], fromUser, sendSearchHintOnce);
                  await this.sendTextMessageWithAuth(auth, fromUser, reply, contextToken);
                } catch (chatErr: any) {
                  console.error(`[Weixin 消息处理异常] [Bot:${auth.botId}]`, chatErr.message);
                }
              });
            } else if (imageItem) {
              console.log(`[Weixin 收到图片] [Bot:${auth.botId}] 来自 ${fromUser}`);
              // 异步入队处理图片交互
              this.enqueueUserTask(userQueueKey, async () => {
                try {
                  await this.handleInboundImageWithAuth(auth, fromUser, imageItem, contextToken);
                } catch (imgErr: any) {
                  console.error(`[Weixin 图片处理异常] [Bot:${auth.botId}]`, imgErr.message);
                }
              });
            }
          }
        }
      } catch (err: any) {
        if (err.code !== 'ECONNABORTED' && !err.message?.includes('timeout')) {
          console.error(`[WeixinBot-${auth.botId} 消息轮询异常]`, err.message);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private loadAccountSyncBuf(botId: string): string {
    const filePath = path.resolve(DATA_DIR, `weixin_sync_${botId}.dat`);
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8').trim();
      }
      // 回退兼容主 syncBuf
      if (this.authData?.botId === botId && fs.existsSync(SYNC_FILE)) {
        return fs.readFileSync(SYNC_FILE, 'utf-8').trim();
      }
    } catch {}
    return '';
  }

  private saveAccountSyncBuf(botId: string, buf: string) {
    if (!botId || botId === 'undefined') return;
    const filePath = path.resolve(DATA_DIR, `weixin_sync_${botId}.dat`);
    try {
      atomicWriteFileSync(filePath, buf);
      if (this.authData?.botId === botId) {
        this.saveSyncBuf(buf);
      }
    } catch {}
  }

  /**
   * 启动所有已知账号的微信消息监听循环
   */
  async startMessageLoop() {
    this.loadAuth();
    const accounts = this.getAllAccounts();

    if (!this.authData && accounts.length === 0) {
      throw new Error('未检测到有效的微信授权凭证，请先扫码登录！');
    }

    if (this.authData) {
      this.startAccountLoop(this.authData).catch((err) => {
        console.error(`[WeixinBot 主账号异常]`, err.message);
      });
    }

    for (const acc of accounts) {
      if (acc.botId !== this.authData?.botId) {
        this.startAccountLoop(acc).catch((err) => {
          console.error(`[WeixinBot 附属账号 ${acc.botId} 异常]`, err.message);
        });
      }
    }

    // 启动全局智能定时与资源监控引擎
    SchedulerService.getInstance().start(async (userId, text) => {
      return await this.pushMessageToUser(userId, text);
    });
  }

  private loadUserRoutes() {
    try {
      if (fs.existsSync(USER_ROUTES_FILE)) {
        this.userRoutes = JSON.parse(fs.readFileSync(USER_ROUTES_FILE, 'utf-8'));
      }
    } catch {
      this.userRoutes = {};
    }
  }

  private recordUserRoute(userId: string, botId: string, contextToken?: string) {
    this.userRoutes[userId] = {
      botId,
      contextToken: contextToken || this.userRoutes[userId]?.contextToken,
      updatedAt: Date.now(),
    };
    try {
      atomicWriteFileSync(USER_ROUTES_FILE, JSON.stringify(this.userRoutes, null, 2));
    } catch {}
  }

  private resolveAuthForUser(toUserId: string): { auth?: AuthData; contextToken?: string } {
    const accounts = this.getAllAccounts();
    const route = this.userRoutes[toUserId];
    let targetAuth: AuthData | undefined;

    if (route?.botId) {
      targetAuth = accounts.find((a) => a.botId === route.botId);
    }
    if (!targetAuth) {
      targetAuth = accounts.find((a) => a.userId === toUserId) || this.authData || accounts[0];
    }
    return { auth: targetAuth, contextToken: route?.contextToken };
  }

  /**
   * 主动向指定微信用户推送文本消息（供定时荐片、追更入库、全网蹲守等后台任务调用）
   */
  public async pushMessageToUser(toUserId: string, text: string): Promise<boolean> {
    const { auth: targetAuth, contextToken } = this.resolveAuthForUser(toUserId);
    if (!targetAuth) {
      console.error(`[WeixinBot 主动推送失败] 未找到可用的 Bot 账号凭证 (目标用户: ${toUserId})`);
      return false;
    }

    await this.sendTextMessageWithAuth(targetAuth, toUserId, text, contextToken);
    return true;
  }

  public getAllAccounts(): AuthData[] {
    const list: AuthData[] = [];
    if (this.authData) list.push(this.authData);
    try {
      if (fs.existsSync(ACCOUNTS_DIR)) {
        const files = fs.readdirSync(ACCOUNTS_DIR);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const acc = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file), 'utf-8'));
            if (acc.botToken && !list.some((a) => a.botId === acc.botId)) {
              list.push(acc);
            }
          }
        }
      }
    } catch {}
    return list;
  }

  /**
   * 向微信用户下发原生图片消息（自动匹配多账号路由凭证）
   */
  async sendImageMessage(toUserId: string, imagePath: string, contextToken?: string): Promise<boolean> {
    const resolved = this.resolveAuthForUser(toUserId);
    const auth = resolved.auth;
    if (!auth) {
      console.error(`[Weixin 图片发送失败] 未找到可用的 Bot 账号凭证 (目标用户: ${toUserId})`);
      return false;
    }

    const effectiveContextToken = contextToken || resolved.contextToken;
    const baseUrl = (auth.baseUrl || FIXED_BASE_URL).replace(/^https?:\/\/https?:\/\//, 'https://');
    const token = auth.botToken;

    try {
      const uploadRes = await uploadImageToWechatCdn(imagePath, toUserId, auth, (t) => this.getCommonHeaders(t));
      if (!uploadRes) return false;

      const res = await axios.post(
        `${baseUrl}/ilink/bot/sendmessage`,
        {
          msg: {
            to_user_id: toUserId,
            client_id: `wesaver-img-${Date.now()}`,
            message_type: 2,
            message_state: 2,
            item_list: [
              {
                type: 2, // IMAGE
                image_item: {
                  media: {
                    encrypt_query_param: uploadRes.downloadEncryptedQueryParam,
                    aes_key: Buffer.from(uploadRes.aeskey).toString('base64'),
                    encrypt_type: 1,
                  },
                  mid_size: uploadRes.ciphertextSize,
                },
              },
            ],
            context_token: effectiveContextToken,
          },
          base_info: {
            channel_version: '2.4.10',
            bot_agent: 'OpenClaw',
          },
        },
        { headers: this.getCommonHeaders(token), timeout: 15000 }
      );

      console.log(`[Weixin 图片发送成功] [Bot:${auth.botId}] 目标: ${toUserId}, msg_id: ${res.data?.message_id}`);
      return true;
    } catch (err: any) {
      console.error(`[Weixin 图片发送失败] [Bot:${auth.botId}]`, err.response?.data || err.message);
      return false;
    }
  }

  /**
   * 处理指定账号收到的图片消息
   */
  private async handleInboundImageWithAuth(auth: AuthData, fromUser: string, imageItem: any, contextToken?: string) {
    try {
      const media = imageItem.image_item?.media;
      const aeskeyHex = imageItem.image_item?.aeskey;

      if (!media) {
        await this.sendTextMessageWithAuth(auth, fromUser, '📸 收到图片啦，不过图片数据似乎有点损坏，再发一次试试看？', contextToken);
        return;
      }

      // 立即给用户发送接收回执，避免识图期间长时间无反馈
      await this.sendTextMessageWithAuth(
        auth,
        fromUser,
        '📸 收到图片啦，正在识别图中影视作品，请稍候...',
        contextToken
      );

      const baseUrl = (auth.baseUrl || FIXED_BASE_URL).replace(/^https?:\/\/https?:\/\//, 'https://');
      const decryptedBuf = await downloadAndDecryptWechatImage(media, aeskeyHex, baseUrl);

      if (!decryptedBuf || decryptedBuf.length === 0) {
        await this.sendTextMessageWithAuth(
          auth,
          fromUser,
          '📸 收到图片啦！微信图片解密连接超时，建议直接把剧名发给我，我立马为你全网搜存！',
          contextToken
        );
        return;
      }

      // 调用多模态大模型识别并全网搜片
      const reply = await this.agent.handleImageMessage(decryptedBuf, fromUser);
      await this.sendTextMessageWithAuth(auth, fromUser, reply, contextToken);
    } catch (err: any) {
      console.error(`[handleInboundImage-${auth.botId} 异常]`, err.message);
      await this.sendTextMessageWithAuth(auth, fromUser, '📸 看图识片开小差了，直接发剧名或电影名给我，我来帮你搜！', contextToken);
    }
  }

  private splitMessageChunks(text: string, maxLen = 1800): string[] {
    if (!text) return [''];
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx < Math.floor(maxLen * 0.4)) {
        splitIdx = maxLen;
      }
      chunks.push(remaining.slice(0, splitIdx).trimEnd());
      remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
    }
    if (remaining) {
      chunks.push(remaining);
    }
    return chunks.length > 0 ? chunks : [''];
  }

  public async sendTextMessageWithAuth(auth: AuthData, toUserId: string, text: string, contextToken?: string) {
    const baseUrl = (auth.baseUrl || FIXED_BASE_URL).replace(/^https?:\/\/https?:\/\//, 'https://');
    const token = auth.botToken;
    const chunks = this.splitMessageChunks(text, 1800);

    try {
      for (let i = 0; i < chunks.length; i++) {
        const res = await axios.post(
          `${baseUrl}/ilink/bot/sendmessage`,
          {
            msg: {
              to_user_id: toUserId,
              client_id: `wesaver-${Date.now()}-${i}`,
              message_type: 2, // BOT
              message_state: 2, // FINISH
              item_list: [
                {
                  type: 1, // TEXT
                  text_item: { text: chunks[i] },
                },
              ],
              context_token: contextToken,
            },
            base_info: {
              channel_version: '2.4.10',
              bot_agent: 'OpenClaw',
            },
          },
          { headers: this.getCommonHeaders(token), timeout: 15000 }
        );
        console.log(
          `[Weixin 回复成功] [Bot:${auth.botId}] 目标: ${toUserId} (${i + 1}/${chunks.length}), msg_id: ${res.data?.message_id}`
        );
      }
    } catch (err: any) {
      console.error(`[Weixin 回复失败] [Bot:${auth.botId}]`, err.response?.data || err.message);
    }
  }
}
