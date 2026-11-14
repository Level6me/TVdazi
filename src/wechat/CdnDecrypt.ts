import { createDecipheriv } from 'crypto';
import axios from 'axios';

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  return decoded.slice(0, 16);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 从微信 CDN 拉取并解密图片二进制流
 */
export async function downloadAndDecryptWechatImage(
  media: { encrypt_query_param?: string; aes_key?: string; full_url?: string },
  aeskeyHex?: string,
  cdnBaseUrl: string = 'https://ilinkai.weixin.qq.com'
): Promise<Buffer | null> {
  try {
    const rawAesKey = aeskeyHex ? Buffer.from(aeskeyHex, 'hex').toString('base64') : media.aes_key;
    if (!rawAesKey) {
      console.warn('[CdnDecrypt] 缺少 aes_key，无法解密图片');
      return null;
    }

    const key = parseAesKey(rawAesKey);
    let url = media.full_url;
    if (!url && media.encrypt_query_param) {
      url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    }

    if (!url) {
      console.warn('[CdnDecrypt] 缺少图片下载地址 full_url 或 encrypt_query_param');
      return null;
    }

    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const encryptedBuf = Buffer.from(resp.data);
    const decryptedBuf = decryptAesEcb(encryptedBuf, key);
    return decryptedBuf;
  } catch (err: any) {
    console.error('[CdnDecrypt] 下载解密微信图片失败:', err.message);
    return null;
  }
}
