import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as crypto from 'crypto';
import { uploadImageToWechatCdn } from './CdnUpload';

const DATA_DIR = path.resolve(__dirname, '../../data');
const AUTH_FILE = path.resolve(DATA_DIR, 'weixin_auth.json');
const QR_IMG_PATH = path.resolve(__dirname, '../../wechat_login_qr.png');

function getCommonHeaders(token?: string) {
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

async function run() {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error('未找到 auth 文件');
    process.exit(1);
  }

  const authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  const targetUser = (process.env.TEST_WECHAT_USER || authData.userId || '').trim();
  if (!targetUser) {
    console.error('缺少目标微信用户 ID，请通过环境变量 TEST_WECHAT_USER 指定或确保 authData.userId 存在');
    process.exit(1);
  }
  const baseUrl = (authData.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/^https?:\/\/https?:\/\//, 'https://');

  console.log(`准备向微信用户 [${targetUser}] 发送测试图片...`);

  // 使用项目中已有的高清二维码图或者图片测试
  const imagePath = QR_IMG_PATH;
  if (!fs.existsSync(imagePath)) {
    console.error(`测试图片不存在: ${imagePath}`);
    process.exit(1);
  }

  console.log(`正在上传图片到微信 CDN: ${imagePath}`);
  const uploadResult = await uploadImageToWechatCdn(imagePath, targetUser, authData, getCommonHeaders);
  if (!uploadResult) {
    console.error('上传图片至 CDN 失败！');
    process.exit(1);
  }

  console.log('CDN 上传成功！filekey:', uploadResult.filekey);
  console.log('正在向微信发送图片消息包...');

  const token = authData.botToken;
  const res = await axios.post(
    `${baseUrl}/ilink/bot/sendmessage`,
    {
      msg: {
        to_user_id: targetUser,
        client_id: `wesaver-img-${Date.now()}`,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [
          {
            type: 1, // TEXT 附带说明
            text_item: { text: '📸 叮咚！我是 WeSaver，这是一张测试图片已成功送达你的微信聊天框！' },
          },
          {
            type: 2, // IMAGE
            image_item: {
              media: {
                encrypt_query_param: uploadResult.downloadEncryptedQueryParam,
                aes_key: uploadResult.aeskey.toString('base64'),
                encrypt_type: 1,
              },
              mid_size: uploadResult.ciphertextSize,
            },
          },
        ],
      },
      base_info: {
        channel_version: '2.4.10',
        bot_agent: 'OpenClaw',
      },
    },
    { headers: getCommonHeaders(token), timeout: 15000 }
  );

  console.log('✅ 发送成功！返回结果:', JSON.stringify(res.data));
  process.exit(0);
}

run().catch((e) => {
  console.error('发送测试图片异常:', e.response?.data || e.message);
  process.exit(1);
});
