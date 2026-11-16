import * as crypto from 'crypto';
import * as fs from 'fs';
import axios from 'axios';

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export interface UploadResult {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: Buffer;
  rawSize: number;
  ciphertextSize: number;
}

/**
 * 上传本地图片到微信 CDN（AES-128-ECB 密文）
 */
export async function uploadImageToWechatCdn(
  imagePath: string,
  toUserId: string,
  authData: { baseUrl: string; botToken: string },
  getCommonHeaders: (token?: string) => Record<string, string>
): Promise<UploadResult | null> {
  try {
    if (!fs.existsSync(imagePath)) {
      console.error(`[CdnUpload] 图片文件不存在: ${imagePath}`);
      return null;
    }

    const plaintext = fs.readFileSync(imagePath);
    const rawSize = plaintext.length;
    const rawFileMd5 = crypto.createHash('md5').update(plaintext).digest('hex');
    const ciphertextSize = aesEcbPaddedSize(rawSize);
    const filekey = crypto.randomBytes(16).toString('hex');
    const aeskey = crypto.randomBytes(16);

    const baseUrl = authData.baseUrl.replace(/^https?:\/\/https?:\/\//, 'https://');
    const headers = getCommonHeaders(authData.botToken);

    // 1. 向微信服务器申请上传 URL
    const uploadUrlResp = await axios.post(
      `${baseUrl}/ilink/bot/getuploadurl`,
      {
        filekey,
        media_type: 1, // IMAGE
        to_user_id: toUserId,
        rawsize: rawSize,
        rawfilemd5: rawFileMd5,
        filesize: ciphertextSize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
        base_info: {
          channel_version: '2.4.10',
          bot_agent: 'OpenClaw',
        },
      },
      { headers, timeout: 10000 }
    );

    const data = uploadUrlResp.data;
    const uploadFullUrl = data?.upload_full_url?.trim();
    const uploadParam = data?.upload_param;

    let cdnUrl = uploadFullUrl;
    if (!cdnUrl && uploadParam) {
      cdnUrl = `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    }

    if (!cdnUrl) {
      console.error('[CdnUpload] 未能获取到 CDN 上传 URL:', JSON.stringify(data));
      return null;
    }

    // 2. 将图片加密并上传至 CDN
    const ciphertext = encryptAesEcb(plaintext, aeskey);
    const uploadRes = await axios.post(cdnUrl, ciphertext, {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      timeout: 15000,
    });

    const downloadParam = uploadRes.headers['x-encrypted-param'] || uploadRes.headers['x-encrypted-query-param'];
    if (!downloadParam) {
      console.error('[CdnUpload] CDN 上传成功但未返回 x-encrypted-param 响应头');
      return null;
    }

    return {
      filekey,
      downloadEncryptedQueryParam: downloadParam,
      aeskey,
      rawSize,
      ciphertextSize,
    };
  } catch (err: any) {
    console.error('[CdnUpload] 上传图片到微信 CDN 失败:', err.response?.data || err.message);
    return null;
  }
}

/**
 * 将 16 字节原始 AES 密钥编码为微信 iLink 协议要求的 aes_key 字段：
 * 先转为 32 位小写十六进制 ASCII 字符串，再做 Base64（共 44 字符）。
 */
export function encodeWechatMediaAesKey(aeskey: Buffer): string {
  return Buffer.from(aeskey.toString('hex'), 'ascii').toString('base64');
}
