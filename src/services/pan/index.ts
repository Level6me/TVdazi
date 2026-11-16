import { PanProviderRegistry } from './CloudDriveProvider';
import { QuarkPanProvider } from './QuarkPanProvider';
import { AliyunPanProvider } from './AliyunPanProvider';
import { Pan115Provider } from './Pan115Provider';

export * from './CloudDriveProvider';
export * from './QuarkPanProvider';
export * from './AliyunPanProvider';
export * from './Pan115Provider';

let initialized = false;

export function getPanRegistry(): PanProviderRegistry {
  const registry = PanProviderRegistry.getInstance();
  if (!initialized) {
    registry.register(new QuarkPanProvider());
    registry.register(new AliyunPanProvider());
    registry.register(new Pan115Provider());
    initialized = true;
  }
  return registry;
}
