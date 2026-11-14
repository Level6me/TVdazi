import * as dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import * as url from 'url';
import { DeepSeekAgent } from './agent/DeepSeekAgent';
import { CommandHandler } from './commands/CommandHandler';
import { ResourceSearcher } from './services/Searcher';
import { QuarkService } from './services/QuarkService';
import { DoubanService } from './services/DoubanService';
import { ChannelManager } from './services/ChannelManager';
import { SessionManager } from './services/SessionManager';
import { CategoryClassifier } from './services/CategoryClassifier';

export {
  DeepSeekAgent,
  CommandHandler,
  ResourceSearcher,
  QuarkService,
  DoubanService,
  ChannelManager,
  SessionManager,
  CategoryClassifier,
};

export async function bootstrap() {
  const agent = new DeepSeekAgent();
  const commandHandler = new CommandHandler();
  const port = parseInt(process.env.PORT || '3001', 10);

  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname || '';

    // 跨域处理
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. 健康检测
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', service: 'WeSaver', timestamp: new Date().toISOString() }));
      return;
    }

    // 2. 微信公众号 / 开放平台服务器配置握手校验 (GET 方式返回 echostr)
    if (req.method === 'GET' && (pathname === '/webhook/wechat' || pathname === '/api/wechat')) {
      const echostr = parsedUrl.query.echostr as string;
      if (echostr) {
        console.log(`[WeSaver 微信握手] 收到官方服务器认证请求，返回 echostr`);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(echostr);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('WeSaver 微信网关已就绪');
      return;
    }

    // 3. 消息接收网关 (支持 JSON 与 微信官方原生 XML)
    if (req.method === 'POST' && (pathname === '/api/chat' || pathname === '/webhook/wechat' || pathname === '/api/wechat')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const raw = (body || '').trim();

          // 场景 A: 微信公众号原生 XML 格式推送
          if (raw.startsWith('<xml') || raw.includes('<FromUserName>')) {
            const fromUserMatch = raw.match(/<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>/) || raw.match(/<FromUserName>(.*?)<\/FromUserName>/);
            const toUserMatch = raw.match(/<ToUserName><!\[CDATA\[(.*?)\]\]><\/ToUserName>/) || raw.match(/<ToUserName>(.*?)<\/ToUserName>/);
            const contentMatch = raw.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/) || raw.match(/<Content>(.*?)<\/Content>/);
            const msgTypeMatch = raw.match(/<MsgType><!\[CDATA\[(.*?)\]\]><\/MsgType>/) || raw.match(/<MsgType>(.*?)<\/MsgType>/);

            const fromUser = fromUserMatch ? fromUserMatch[1] : 'wechat_user';
            const toUser = toUserMatch ? toUserMatch[1] : 'wechat_bot';
            const msgType = msgTypeMatch ? msgTypeMatch[1] : 'text';
            const userText = contentMatch ? contentMatch[1].trim() : '';

            // 非文本消息快速响应
            if (msgType !== 'text' || !userText) {
              const xmlReply = `
<xml>
  <ToUserName><![CDATA[${fromUser}]]></ToUserName>
  <FromUserName><![CDATA[${toUser}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[你好！请直接发送想找的电影或电视剧名（如“功夫”、“庆余年”），或者发送 /help 查看所有功能。]]></Content>
</xml>`.trim();
              res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
              res.end(xmlReply);
              return;
            }

            console.log(`[WeSaver 微信XML消息] 来自 ${fromUser}: ${userText}`);
            const reply = await agent.chat(userText, [], fromUser);

            const xmlReply = `
<xml>
  <ToUserName><![CDATA[${fromUser}]]></ToUserName>
  <FromUserName><![CDATA[${toUser}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${reply}]]></Content>
</xml>`.trim();
            res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
            res.end(xmlReply);
            return;
          }

          // 场景 B: JSON 格式 (适用于 OpenClaw、Wechaty、Gewechat、自建反向代理)
          const data = JSON.parse(raw || '{}');
          const text = data.message || data.content || data.text || '';
          const userId = data.userId || data.fromUser || data.sender || data.openid || 'default_user';

          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Missing message/text in request body' }));
            return;
          }

          console.log(`[WeSaver JSON消息] 用户 ${userId}: ${text}`);
          const reply = await agent.chat(text, [], userId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            reply,
            content: reply,
            status: 'success'
          }));
        } catch (err: any) {
          console.error('[WeSaver 网关异常]', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message || 'Internal Error' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(port, () => {
    console.log(`[WeSaver] 服务已启动，监听端口: http://127.0.0.1:${port}`);
    console.log(`[WeSaver] 微信公众号/XML 接入端点: http://127.0.0.1:${port}/webhook/wechat`);
    console.log(`[WeSaver] OpenClaw/JSON 接入端点: http://127.0.0.1:${port}/api/chat`);
  });

  return {
    server,
    agent,
    commandHandler,
    handleTextMessage: async (userText: string, userId: string = 'default_user') => {
      return await agent.chat(userText, [], userId);
    }
  };
}

if (require.main === module) {
  bootstrap();
}
