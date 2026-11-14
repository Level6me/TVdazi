import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { WeixinBot } from './wechat/WeixinBot';

async function main() {
  const bot = new WeixinBot();

  console.log('====================================================');
  console.log('   WeSaver - 微信端 AI 云盘资源转存助手 (个人微信通道)');
  console.log('====================================================');

  const authFile = path.resolve(__dirname, '../data/weixin_auth.json');
  const hasAuth = fs.existsSync(authFile);

  if (hasAuth && process.argv[2] !== '--new') {
    console.log('✅ 检测到本地已存在授权凭证，直接启动微信消息监听引擎...');
    await bot.startMessageLoop();
    return;
  }

  try {
    const { qrcode, qrcodeUrl, imagePath } = await bot.requestLoginQr();
    console.log(`\n🎉 登录二维码获取成功！`);
    console.log(`📷 二维码本地图片：${imagePath}`);
    console.log(`🌐 网页授权直达链接：${qrcodeUrl}`);
    console.log(`\n👉 请使用手机微信扫一扫上方二维码或打开图片进行授权登录。\n`);

    const auth = await bot.waitForLogin(qrcode);
    console.log(`\n✅ 登录完成！Bot ID: ${auth.botId}`);
    await bot.startMessageLoop();
  } catch (err: any) {
    console.error('\n❌ 登录或运行异常:', err.message);
    process.exit(1);
  }
}

main();
