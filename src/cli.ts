import * as dotenv from 'dotenv';
dotenv.config();

import * as readline from 'readline';
import { DeepSeekAgent } from './agent/DeepSeekAgent';

async function main() {
  const agent = new DeepSeekAgent();

  console.log('================================================================');
  console.log('  TVdazi (电视搭子) - 微信端 AI 云盘资源助手 (自然语言 + 原版指令双模支持)');
  console.log('================================================================');
  console.log('💡 支持原版指令：/help, /hot, /config, /status, /channels, /search');
  console.log('💡 支持自然语言：直接输入“我想看周星驰的功夫4K”、“帮我找庆余年第二季”');
  console.log('输入 exit 退出。\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question('👤 用户: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }
      if (trimmed.toLowerCase() === 'exit') {
        rl.close();
        return;
      }

      console.log('🤖 TVdazi 电视搭子 处理中...');
      try {
        const reply = await agent.chat(trimmed);
        console.log(`\n${reply}\n----------------------------------------------------------------\n`);
      } catch (err: any) {
        console.error('发生错误:', err.message);
      }
      prompt();
    });
  };

  prompt();
}

main();
