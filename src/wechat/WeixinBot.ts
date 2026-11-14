import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import { exec } from 'child_process';
import { DeepSeekAgent } from '../agent/DeepSeekAgent';

import { downloadAndDecryptWechatImage } from './CdnDecrypt';
import { uploadImageToWechatCdn } from './CdnUpload';

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const DATA_DIR = path.resolve(__dirname, '../../data');
const AUTH_FILE = path.resolve(DATA_DIR, 'weixin_auth.json');
const SYNC_FILE = path.resolve(DATA_DIR, 'weixin_sync.dat');
const QR_IMG_PATH = path.resolve(__dirname, '../../wechat_login_qr.png');

interface AuthData {
  botToken: string;
  botId: string;
  baseUrl: string;
  userId?: string;
}

const ACCOUNTS_DIR = path.resolve(DATA_DIR, 'accounts');

export class WeixinBot {
  private static instance: WeixinBot;
  private agent: DeepSeekAgent;
  private activeBots: Map<string, { auth: AuthData; isRunning: boolean; syncBuf: string }> = new Map();
  private authData: AuthData | null = null;
  private isRunning: boolean = false;
  private syncBuf: string = '';

  constructor() {
    this.agent = new DeepSeekAgent();
    this.ensureDataDir();
    this.loadAuth();
    this.loadSyncBuf();
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
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), 'utf-8');

    // 同时以 botId 保存到多账号凭证池
    if (data.botId) {
      const accountPath = path.join(ACCOUNTS_DIR, `${data.botId}.json`);
      fs.writeFileSync(accountPath, JSON.stringify(data, null, 2), 'utf-8');
    }
  }

  public saveAccountAuth(data: AuthData) {
    data.baseUrl = data.baseUrl.replace(/^https?:\/\/https?:\/\//, 'https://');
    const accountPath = path.join(ACCOUNTS_DIR, `${data.botId}.json`);
    fs.writeFileSync(accountPath, JSON.stringify(data, null, 2), 'utf-8');
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
      fs.writeFileSync(SYNC_FILE, buf, 'utf-8');
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
    const pusher = '/home/ubuntu/codex-feishu-bot/send_to_feishu.py';
    if (fs.existsSync(pusher)) {
      exec(`python3 ${pusher} "${filePath}"`, () => {});
    }
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
            const fromUser = msg.from_user_id;
            const contextToken = msg.context_token;
            const textItem = msg.item_list?.find((i: any) => i.type === 1);
            const imageItem = msg.item_list?.find((i: any) => i.type === 2);
            const userText = textItem?.text_item?.text?.trim();

            if (userText) {
              console.log(`[Weixin 收到消息] [Bot:${auth.botId}] 来自 ${fromUser}: ${userText}`);

              // 调用 WeSaver 智能 Agent（支持搜片、指令、热门排行与智能归类转存）
              const reply = await this.agent.chat(userText, [], fromUser);

              // 自动回复给微信用户
              await this.sendTextMessageWithAuth(auth, fromUser, reply, contextToken);
            } else if (imageItem) {
              console.log(`[Weixin 收到图片] [Bot:${auth.botId}] 来自 ${fromUser}`);
              // 用户发送图片交互处理
              await this.handleInboundImageWithAuth(auth, fromUser, imageItem, contextToken);
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
    const filePath = path.resolve(DATA_DIR, `weixin_sync_${botId}.dat`);
    try {
      fs.writeFileSync(filePath, buf, 'utf-8');
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
   * 处理用户发送的图片消息：自动 CDN 解密 -> DeepSeek 多模态识别影视片名 -> 自动全网检索活链
   */
  private async handleInboundImage(fromUser: string, imageItem: any, contextToken?: string) {
    try {
      const media = imageItem.image_item?.media;
      const aeskeyHex = imageItem.image_item?.aeskey;

      if (!media) {
        await this.sendTextMessage(fromUser, '📸 收到图片啦，不过图片数据似乎有点损坏，再发一次试试看？', contextToken);
        return;
      }

      const baseUrl = (this.authData?.baseUrl || FIXED_BASE_URL).replace(/^https?:\/\/https?:\/\//, 'https://');
      const decryptedBuf = await downloadAndDecryptWechatImage(media, aeskeyHex, baseUrl);

      if (!decryptedBuf || decryptedBuf.length === 0) {
        await this.sendTextMessage(
          fromUser,
          '📸 收到图片啦！微信图片解密连接超时，建议直接把剧名发给我，我立马为你全网搜存！',
          contextToken
        );
        return;
      }

      // 调用多模态大模型识别并全网搜片
      const reply = await this.agent.handleImageMessage(decryptedBuf, fromUser);
      await this.sendTextMessage(fromUser, reply, contextToken);
    } catch (err: any) {
      console.error('[handleInboundImage 异常]', err.message);
      await this.sendTextMessage(fromUser, '📸 看图识片开小差了，直接发剧名或电影名给我，我来帮你搜！', contextToken);
    }
  }

  /**
   * 向微信用户下发原生图片消息
   */
  async sendImageMessage(toUserId: string, imagePath: string, contextToken?: string): Promise<boolean> {
    if (!this.authData) return false;
    const baseUrl = (this.authData.baseUrl || FIXED_BASE_URL).replace(/^https?:\/\/https?:\/\//, 'https://');
    const token = this.authData.botToken;

    try {
      const uploadRes = await uploadImageToWechatCdn(imagePath, toUserId, this.authData, (t) => this.getCommonHeaders(t));
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
            context_token: contextToken,
          },
          base_info: {
            channel_version: '2.4.10',
            bot_agent: 'OpenClaw',
          },
        },
        { headers: this.getCommonHeaders(token), timeout: 15000 }
      );

      console.log(`[Weixin 图片发送成功] 目标: ${toUserId}, msg_id: ${res.data?.message_id}`);
      return true;
    } catch (err: any) {
      console.error(`[Weixin 图片发送失败]`, err.response?.data || err.message);
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

  public async sendTextMessageWithAuth(auth: AuthData, toUserId: string, text: string, contextToken?: string) {
    const baseUrl = (auth.baseUrl || FIXED_BASE_URL).replace(/^https?:\/\/https?:\/\//, 'https://');
    const token = auth.botToken;

    try {
      const res = await axios.post(
        `${baseUrl}/ilink/bot/sendmessage`,
        {
          msg: {
            to_user_id: toUserId,
            client_id: `wesaver-${Date.now()}`,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            item_list: [
              {
                type: 1, // TEXT
                text_item: { text },
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
      console.log(`[Weixin 回复成功] [Bot:${auth.botId}] 目标: ${toUserId}, msg_id: ${res.data?.message_id}`);
    } catch (err: any) {
      console.error(`[Weixin 回复失败] [Bot:${auth.botId}]`, err.response?.data || err.message);
    }
  }

  private async sendTextMessage(toUserId: string, text: string, contextToken?: string) {
    if (!this.authData) return;
    await this.sendTextMessageWithAuth(this.authData, toUserId, text, contextToken);
  }
}
