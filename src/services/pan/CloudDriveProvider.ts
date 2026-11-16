import { PanType, ResourceCategory } from '../../types';

export interface PanUserQuota {
  panType: PanType;
  nickname: string;
  totalCapacity: string;
  usedCapacity?: string;
  freeCapacity: string;
  usagePercent?: string;
  freeBytes?: number;
}

export interface PanSaveOptions {
  credential?: string; // Cookie 或 Refresh Token
  rootDir?: string;
  standardTitle?: string;
  userId?: string;
  autoCleanCensor?: boolean;
}

export interface PanSaveResult {
  success: boolean;
  panType: PanType;
  message: string;
  targetPath: string;
  renamedItems?: Array<{ original: string; restored: string; reason?: string }>;
}

export interface CloudDriveProvider {
  readonly panType: PanType;
  readonly displayName: string;
  isConfigured(credential?: string): boolean;
  getUserQuota(credential?: string): Promise<PanUserQuota | null>;
  verifyShareLink(shareId: string): Promise<boolean>;
  saveShare(
    shareId: string,
    passcode: string,
    category: ResourceCategory,
    options?: PanSaveOptions
  ): Promise<PanSaveResult>;
}

/**
 * 多网盘提供商统一注册中心
 */
export class PanProviderRegistry {
  private static instance: PanProviderRegistry;
  private providers = new Map<PanType, CloudDriveProvider>();

  private constructor() {}

  static getInstance(): PanProviderRegistry {
    if (!PanProviderRegistry.instance) {
      PanProviderRegistry.instance = new PanProviderRegistry();
    }
    return PanProviderRegistry.instance;
  }

  register(provider: CloudDriveProvider): void {
    this.providers.set(provider.panType, provider);
  }

  get(panType: PanType): CloudDriveProvider | undefined {
    return this.providers.get(panType);
  }

  listAll(): CloudDriveProvider[] {
    return Array.from(this.providers.values());
  }
}
