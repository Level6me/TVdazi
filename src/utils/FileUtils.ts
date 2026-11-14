import * as fs from 'fs';
import * as path from 'path';

/**
 * 原子写入文件（先写临时文件再重命名覆盖），避免进程中断或并发写入导致 JSON 损坏
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * 安全更新 .env 文件中的指定键值（避免 String.prototype.replace 误解析值中的 $ 符号）
 */
export function upsertEnvVar(envPath: string, key: string, value: string): void {
  const sanitizedVal = value.replace(/[\r\n]/g, '').trim();
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedKey}=.*`, 'm');
  const newLine = `${key}=${sanitizedVal}`;

  if (regex.test(content)) {
    content = content.replace(regex, () => newLine);
  } else {
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    content += `${prefix}${newLine}\n`;
  }
  atomicWriteFileSync(envPath, content);
}
