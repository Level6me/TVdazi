import axios from 'axios';
import { ResourceCategory } from '../../types';
import { CloudDriveProvider, PanSaveOptions, PanSaveResult, PanUserQuota } from './CloudDriveProvider';

/**
 * 阿里云盘适配器（支持 Refresh Token 兑换 Access Token 及分享转存）
 */
export class AliyunPanProvider implements CloudDriveProvider {
  readonly panType = 'aliyun' as const;
  readonly displayName = '阿里云盘';
  private defaultRefreshToken: string;

  constructor(refreshToken?: string) {
    this.defaultRefreshToken = (refreshToken || process.env.ALIYUN_REFRESH_TOKEN || '').trim();
  }

  isConfigured(credential?: string): boolean {
    const token = (credential || this.defaultRefreshToken || '').trim();
    return token.length > 10;
  }

  private async exchangeAccessToken(refreshToken: string): Promise<{ accessToken: string; driveId: string; nickname: string } | null> {
    try {
      const resp = await axios.post(
        'https://auth.aliyundrive.com/v2/account/token',
        { refresh_token: refreshToken, grant_type: 'refresh_token' },
        { timeout: 7000, headers: { 'Content-Type': 'application/json' } }
      );
      if (resp.data?.access_token) {
        return {
          accessToken: resp.data.access_token,
          driveId: resp.data.default_drive_id || '',
          nickname: resp.data.nick_name || resp.data.user_name || '阿里云盘用户',
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async getUserQuota(credential?: string): Promise<PanUserQuota | null> {
    const token = (credential || this.defaultRefreshToken || '').trim();
    if (!token) return null;
    const auth = await this.exchangeAccessToken(token);
    if (!auth) return null;

    try {
      const resp = await axios.post(
        'https://api.aliyundrive.com/adrive/v1/user/getSpaceInfo',
        {},
        {
          timeout: 7000,
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      const info = resp.data?.personal_space_info;
      const total = Number(info?.total_size || 0);
      const used = Number(info?.used_size || 0);
      const free = Math.max(0, total - used);
      const fmtGb = (b: number) => `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
      return {
        panType: 'aliyun',
        nickname: auth.nickname,
        totalCapacity: total > 0 ? fmtGb(total) : '未知',
        usedCapacity: total > 0 ? fmtGb(used) : undefined,
        freeCapacity: total > 0 ? fmtGb(free) : '未知',
        usagePercent: total > 0 ? `${((used / total) * 100).toFixed(1)}%` : undefined,
        freeBytes: total > 0 ? free : undefined,
      };
    } catch {
      return null;
    }
  }

  async verifyShareLink(shareId: string): Promise<boolean> {
    try {
      const resp = await axios.post(
        `https://api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous?share_id=${encodeURIComponent(shareId)}`,
        { share_id: shareId },
        { timeout: 5000 }
      );
      return Boolean(resp.data?.share_name);
    } catch {
      return false;
    }
  }

  async saveShare(
    shareId: string,
    passcode: string,
    category: ResourceCategory,
    options?: PanSaveOptions
  ): Promise<PanSaveResult> {
    const token = (options?.credential || this.defaultRefreshToken || '').trim();
    const targetPath = `${options?.rootDir || '/我的资源'}/${category}`.replace(/\/+/g, '/');

    if (!this.isConfigured(token)) {
      return {
        success: false,
        panType: 'aliyun',
        targetPath,
        message: '尚未绑定阿里云盘 Refresh Token，请发送「/set-aliyun <refresh_token>」后即可一键转存阿里云盘分享！',
      };
    }

    const auth = await this.exchangeAccessToken(token);
    if (!auth) {
      return {
        success: false,
        panType: 'aliyun',
        targetPath,
        message: '阿里云盘 Refresh Token 已失效，请发送「/set-aliyun <新token>」更新凭证。',
      };
    }

    try {
      const tokenRes = await axios.post(
        'https://api.aliyundrive.com/v2/share_link/get_share_token',
        { share_id: shareId, share_pwd: passcode || '' },
        { timeout: 7000 }
      );
      const shareToken = tokenRes.data?.share_token;
      if (!shareToken) {
        return {
          success: false,
          panType: 'aliyun',
          targetPath,
          message: '获取阿里云盘分享凭证失败（链接可能已失效或提取码有误）',
        };
      }

      const listRes = await axios.post(
        'https://api.aliyundrive.com/adrive/v2/file/list_by_share',
        { share_id: shareId, parent_file_id: 'root', limit: 100 },
        { timeout: 7000, headers: { 'x-share-token': shareToken } }
      );
      const items: Array<{ file_id: string; name: string }> = listRes.data?.items || [];
      if (items.length === 0) {
        return {
          success: false,
          panType: 'aliyun',
          targetPath,
          message: '阿里云盘分享链接内无可转存文件',
        };
      }

      const requests = items.map((item) => ({
        body: {
          file_id: item.file_id,
          share_id: shareId,
          auto_rename: true,
          to_parent_file_id: 'root',
          to_drive_id: auth.driveId,
        },
        headers: { 'Content-Type': 'application/json' },
        id: item.file_id,
        method: 'POST',
        url: '/file/copy',
      }));

      await axios.post(
        'https://api.aliyundrive.com/adrive/v4/batch',
        { requests, resource: 'file' },
        {
          timeout: 10000,
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'x-share-token': shareToken,
          },
        }
      );

      return {
        success: true,
        panType: 'aliyun',
        targetPath: '/根目录',
        message: `✅ 已成功转存 ${items.length} 项到您的阿里云盘根目录！`,
      };
    } catch (err: any) {
      return {
        success: false,
        panType: 'aliyun',
        targetPath,
        message: `阿里云盘转存失败：${err.response?.data?.message || err.message}`,
      };
    }
  }
}
