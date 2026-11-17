import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as crypto from 'crypto';
import axios from 'axios';
import QRCode from 'qrcode';

import { encodeWechatMediaAesKey } from '../wechat/CdnUpload';
import { WeixinBot } from '../wechat/WeixinBot';
import { isAllowedPosterUrl, detectImageMimeAndExt, sendCoverToWechatUser } from '../utils/PosterHelper';
import { MetadataResolver } from '../services/MetadataResolver';

import { maskSensitive } from '../utils/Logger';
import { LruCache } from '../utils/LruCache';
import { SerializedJsonStore } from '../utils/StorageQueue';
import { QualityTagger } from '../services/QualityTagger';
import { ChannelHealthService } from '../services/ChannelHealthService';
import { QuarkOrganizer } from '../services/QuarkOrganizer';
import { WatchlistService } from '../services/WatchlistService';
import { ScheduleTimeParser } from '../services/scheduler/ScheduleTimeParser';
import { DashboardServer } from '../web/DashboardServer';
import { getPanRegistry } from '../services/pan';
import { CommandHandler } from '../commands/CommandHandler';
import { PushGateway } from '../services/PushGateway';
import { RelayService } from '../services/RelayService';
import { SessionManager } from '../services/SessionManager';
import { DeepSeekAgent } from '../agent/DeepSeekAgent';
import { UserProfileService } from '../services/UserProfileService';
import { UserManager } from '../services/UserManager';

test('Logger.maskSensitive hides API keys, cookies and slash commands', () => {
  assert.equal(maskSensitive('/set-quark __pus=abc123; __kp=xyz'), '/set-quark [REDACTED]');
  assert.equal(maskSensitive('/set-key sk-1234567890abcdef'), '/set-key [REDACTED]');
  assert.ok(!maskSensitive('Authorization: Bearer my_secret_token_123456').includes('my_secret_token_123456'));
  assert.ok(!maskSensitive('key is sk-abcdef12345678').includes('sk-abcdef12345678'));
});

test('LruCache supports TTL expiration and capacity eviction', async () => {
  const cache = new LruCache<string, number>(2, 50);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1); // 刷新 a
  cache.set('c', 3); // 淘汰最久未用的 b
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);

  await new Promise((r) => setTimeout(r, 70));
  assert.equal(cache.get('a'), undefined);
});

test('SerializedJsonStore handles concurrent enqueueWrite safely without corruption', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvdazi-store-'));
  const filePath = path.join(tmpDir, 'state.json');
  try {
    await Promise.all([
      SerializedJsonStore.enqueueWrite(filePath, { step: 1 }),
      SerializedJsonStore.enqueueWrite(filePath, { step: 2 }),
      SerializedJsonStore.enqueueWrite(filePath, { step: 3 }),
    ]);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(data.step, 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('QualityTagger extracts structured tags and scores natural language preference', () => {
  const tags4k = QualityTagger.extractTags('沙丘2.2024.2160p.Dolby.Vision.REMUX.特效中字.18.5GB');
  assert.equal(tags4k.resolution, '4K');
  assert.equal(tags4k.hdr, '杜比视界');
  assert.equal(tags4k.codec, '原盘/REMUX');
  assert.equal(tags4k.subtitle, '特效中字');
  assert.equal(tags4k.sizeHint, '18.5GB');

  const tagsSmall = QualityTagger.extractTags('沙丘2.1080p.HEVC.2.1GB');
  assert.ok(
    QualityTagger.scoreByPreference(tags4k, '4K杜比') >
      QualityTagger.scoreByPreference(tagsSmall, '4K杜比')
  );
  assert.ok(
    QualityTagger.scoreByPreference(tagsSmall, '只要体积小的1080P') >
      QualityTagger.scoreByPreference(tags4k, '只要体积小的1080P')
  );
});

test('ChannelHealthService trips circuit after consecutive failures and prioritizes healthy channels', () => {
  const health = ChannelHealthService.getInstance();
  const bad = '__test_bad_channel__';
  const good = '__test_good_channel__';
  health.resetChannel(bad);
  health.resetChannel(good);

  health.recordSuccess(good, 300, 3);
  health.recordFailure(bad, 5500);
  health.recordFailure(bad, 5500);
  health.recordFailure(bad, 5500);

  assert.equal(health.isCircuitOpen(bad), true);
  assert.equal(health.isCircuitOpen(good), false);

  const ordered = health.prioritizeChannels([bad, good]);
  assert.equal(ordered[0], good);
  assert.ok(!ordered.includes(bad));

  health.resetChannel(bad);
  health.resetChannel(good);
});

test('QuarkOrganizer formats Emby/Infuse media names and detects duplicate groups', () => {
  assert.equal(
    QuarkOrganizer.formatEmbyMediaName('Joy.of.Life.S02E05.2160p.WEB-DL.mkv', '庆余年', '2024'),
    '庆余年 (2024) - S02E05.mkv'
  );
  assert.equal(
    QuarkOrganizer.formatEmbyMediaName('流浪地球2.第12集.1080p.mp4', '流浪地球2'),
    '流浪地球2 - S01E12.mp4'
  );

  const dups = QuarkOrganizer.findDuplicateGroups([
    { fid: '1', file_name: '沙丘2.1080p.mkv', dir: false, size: 2 * 1024 * 1024 * 1024 },
    { fid: '2', file_name: '沙丘2.4K.2160p.Dolby.Vision.mkv', dir: false, size: 15 * 1024 * 1024 * 1024 },
    { fid: '3', file_name: '奥本海默.4K.mkv', dir: false, size: 10 * 1024 * 1024 * 1024 },
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].keep.fid, '2');
  assert.equal(dups[0].duplicates[0].fid, '1');
});

test('WatchlistService extracts movie titles from Xiaohongshu-style text and multiline lists', () => {
  const fromBooks = WatchlistService.extractTitlesFromText('周末必看片单推荐：《沙丘2》和《奥本海默》，还有《三体》别错过！');
  assert.deepEqual(fromBooks, ['沙丘2', '奥本海默', '三体']);

  const fromLines = WatchlistService.extractTitlesFromText('1. 功夫\n2. 霸王别姬\n3. 无间道');
  assert.deepEqual(fromLines, ['功夫', '霸王别姬', '无间道']);

  const fromMixed = WatchlistService.extractTitlesFromText('《沙丘2》\n2. 功夫\n3. 无间道');
  assert.deepEqual(fromMixed, ['沙丘2', '功夫', '无间道']);
});

test('ScheduleTimeParser parses relative delays, clocks and movie titles accurately', () => {
  const fixedNow = new Date('2026-11-16T02:00:00Z').getTime(); // 北京时间 10:00
  const rel = ScheduleTimeParser.parseTimeFromText('半小时后提醒我看片', fixedNow);
  assert.equal(rel.isRelative, true);
  assert.equal(rel.timeStr, '10:30');

  const clock = ScheduleTimeParser.parseTimeFromText('每天晚上8点半推一部科幻电影', fixedNow);
  assert.equal(clock.timeStr, '20:30');

  assert.equal(ScheduleTimeParser.extractCleanMovieTitle('帮我蹲守《流浪地球3》有资源了通知我'), '流浪地球3');
  assert.equal(ScheduleTimeParser.extractCleanMovieTitle('半小时后转存到网盘'), '');
});

test('DashboardServer issues and verifies HMAC user tokens and serves authenticated panel API including domain settings', async () => {
  const testUser = '__panel_http_test_user__';
  const tmpEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvdazi-panel-env-'));
  const tmpEnvFile = path.join(tmpEnvDir, '.env');
  const prevPublicBase = process.env.PUBLIC_BASE_URL;
  DashboardServer.setEnvFilePath(tmpEnvFile);

  assert.deepEqual(DashboardServer.normalizePublicBaseUrl('panel.example.com/'), {
    valid: true,
    normalized: 'https://panel.example.com',
  });
  assert.deepEqual(DashboardServer.normalizePublicBaseUrl('1.2.3.4:3002'), {
    valid: true,
    normalized: 'http://1.2.3.4:3002',
  });
  assert.equal(DashboardServer.normalizePublicBaseUrl('ftp://bad.example.com').valid, false);

  const token = DashboardServer.issueUserToken(testUser, 60000);
  assert.equal(DashboardServer.verifyToken(token), testUser);
  assert.equal(DashboardServer.verifyToken(`${token}tampered`), null);

  const server = http.createServer((req, res) => {
    DashboardServer.handleHttpRequest(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. 未授权拦截
    const unauth = await fetch(`${baseUrl}/api/panel/state`);
    assert.equal(unauth.status, 401);

    // 2. HTML 页面渲染包含 AUI 规范骨架、Dock 与域名输入框
    const htmlRes = await fetch(`${baseUrl}/panel?token=${encodeURIComponent(token)}`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('电视搭子 (TVdazi) 影视网盘控制台'));
    assert.ok(html.includes('data-theme="auto"'));
    assert.ok(html.includes('class="dock"'));
    assert.ok(html.includes('id="p-profile"'));
    assert.ok(html.includes('publicBaseUrl'));

    // 3. 拉取状态 & 更新偏好与访问域名
    const saveRes = await fetch(`${baseUrl}/api/panel/settings?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicBaseUrl: 'tvdazi.test.local/',
        saveRootDir: '/TestMedia',
        preferredQuality: '4K杜比',
      }),
    });
    assert.equal(saveRes.status, 200);
    const saveJson: any = await saveRes.json();
    assert.equal(saveJson.publicBaseUrl, 'https://tvdazi.test.local');
    assert.ok(saveJson.newPanelUrl.startsWith('https://tvdazi.test.local/panel?token='));

    // 4. 在线增删个人观影画像标签
    const addProfRes = await fetch(`${baseUrl}/api/panel/profile?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', category: 'likeGenres', value: '悬疑, 科幻' }),
    });
    assert.equal(addProfRes.status, 200);
    const addProfJson: any = await addProfRes.json();
    assert.deepEqual(addProfJson.tasteProfile.explicitLikes.genres, ['悬疑', '科幻']);

    const remProfRes = await fetch(`${baseUrl}/api/panel/profile?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', category: 'likeGenres', value: '悬疑' }),
    });
    assert.equal(remProfRes.status, 200);
    const remProfJson: any = await remProfRes.json();
    assert.deepEqual(remProfJson.tasteProfile.explicitLikes.genres, ['科幻']);

    const stateRes = await fetch(`${baseUrl}/api/panel/state?token=${encodeURIComponent(token)}`);
    assert.equal(stateRes.status, 200);
    const stateJson: any = await stateRes.json();
    assert.equal(stateJson.settings.publicBaseUrl, 'https://tvdazi.test.local');
    assert.equal(stateJson.settings.saveRootDir, '/TestMedia');
    assert.equal(stateJson.settings.preferredQuality, '4K杜比');
    assert.deepEqual(stateJson.tasteProfile.explicitLikes.genres, ['科幻']);

    // 验证临时 .env 已持久写入 PUBLIC_BASE_URL
    const envText = fs.readFileSync(tmpEnvFile, 'utf-8');
    assert.ok(envText.includes('PUBLIC_BASE_URL=https://tvdazi.test.local'));
  } finally {
    DashboardServer.setEnvFilePath(null);
    if (prevPublicBase !== undefined) {
      process.env.PUBLIC_BASE_URL = prevPublicBase;
    } else {
      delete process.env.PUBLIC_BASE_URL;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpEnvDir, { recursive: true, force: true });
    const userHexFile = path.resolve(process.cwd(), 'data/users', `${Buffer.from(testUser).toString('hex')}.json`);
    setTimeout(() => {
      try {
        if (fs.existsSync(userHexFile)) fs.unlinkSync(userHexFile);
      } catch {}
    }, 50);
  }
});

test('PanProviderRegistry registers Quark, Aliyun and 115 providers', () => {
  const registry = getPanRegistry();
  assert.equal(registry.get('quark')?.displayName, '夸克网盘');
  assert.equal(registry.get('aliyun')?.displayName, '阿里云盘');
  assert.equal(registry.get('115')?.displayName, '115网盘');
});

test('CommandHandler routes new extended commands cleanly', async () => {
  const handler = new CommandHandler();
  const testUser = '__unit_test_user__';

  assert.equal(handler.isCommand('/web', testUser), true);
  assert.equal(handler.isCommand('/organize preview', testUser), true);
  assert.equal(handler.isCommand('/dedup', testUser), true);
  assert.equal(handler.isCommand('/import-list 《测试片名》', testUser), true);
  assert.equal(handler.isCommand('/channels-health', testUser), true);
  assert.equal(handler.isCommand('/subtitle 沙丘2', testUser), true);

  const helpText = await handler.handle('/help', testUser);
  assert.ok(helpText.includes('/web'));
  assert.ok(helpText.includes('/organize'));
  assert.ok(helpText.includes('/dedup'));

  const importReply = await handler.handle('/import-list 《测试电影A》《测试电影B》', testUser);
  assert.ok(importReply.includes('新增收录 2 部'));

  const healthReply = await handler.handle('/channels-health', testUser);
  assert.ok(healthReply.includes('健康度面板'));

  // 清理测试用户持久化文件
  const userHexFile = path.resolve(process.cwd(), 'data/users', `${Buffer.from(testUser).toString('hex')}.json`);
  setTimeout(() => {
    try {
      if (fs.existsSync(userHexFile)) fs.unlinkSync(userHexFile);
    } catch {}
  }, 50);
});

test('RelayService supports user directory, nicknames, A->B relay and B->A reply loop', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvdazi-relay-'));
  const statePath = path.join(tmpDir, 'relay_state.json');
  const routesPath = path.join(tmpDir, 'user_routes.json');
  const userA = '__relay_test_user_a__';
  const userB = '__relay_test_user_b__';

  const sentPackets: Array<{ to: string; text: string }> = [];
  PushGateway.getInstance().registerSender(async (to, text) => {
    sentPackets.push({ to, text });
    return true;
  });

  try {
    fs.writeFileSync(
      routesPath,
      JSON.stringify({
        [userA]: { botId: 'bot1', updatedAt: Date.now() },
        [userB]: { botId: 'bot1', updatedAt: Date.now() },
      })
    );

    const relay = RelayService.createIsolatedForTest(statePath, routesPath);
    assert.equal(relay.getDirectory(userA).length, 2);

    // 验证真人感话术：不含机械系统术语，连续调用不死板重复
    const n1 = relay.setMyNickname(userA, '小二').message;
    const n2 = relay.setMyNickname(userA, '小二').message;
    assert.equal(n1.includes('全局唯一'), false);
    assert.notEqual(n1, n2);

    relay.setMyNickname(userA, '小明');
    relay.setMyNickname(userB, '小红');
    assert.equal(relay.getDisplayName(userA), '小明');
    assert.equal(relay.getDisplayName(userB), '小红');

    // 验证唯一全局昵称：通过 setContactRemark (/alias) 改名后，自己、对方和第三方看到的都是同一个名字
    relay.setContactRemark(userA, '2', '桃子');
    assert.equal(relay.getDisplayName(userB, userA), '桃子');
    assert.equal(relay.getDisplayName(userB, userB), '桃子');
    assert.equal(relay.getDisplayName(userB, '__third_viewer__'), '桃子');
    // 改回 '小红' 以继续后续测试
    relay.setContactRemark(userA, '2', '小红');
    assert.equal(relay.getDisplayName(userB, userB), '小红');

    // A -> B 传话
    const sendRes = await relay.sendRelayMessage(userA, '小红', '最近有什么好看的电影');
    assert.equal(sendRes.success, true);
    assert.equal(sentPackets.length, 1);
    assert.equal(sentPackets[0].to, userB);
    assert.ok(sentPackets[0].text.includes('小明'));
    assert.ok(sentPackets[0].text.includes('最近有什么好看的电影'));
    assert.equal(sentPackets[0].text.includes('----'), false);

    // B 收到后记住上下文，直接回复给 A
    const pendingB = relay.getPendingReply(userB);
    assert.ok(pendingB);
    assert.equal(pendingB?.fromUserId, userA);

    const replyRes = await relay.replyToLastSender(userB, '最近有个叫《周处除三害》的电影还不错');
    assert.equal(replyRes.success, true);
    assert.equal(sentPackets.length, 2);
    assert.equal(sentPackets[1].to, userA);
    assert.ok(sentPackets[1].text.includes('小红'));
    assert.ok(sentPackets[1].text.includes('周处除三害'));

    // 测试免打扰拦截
    relay.setDnd(userB, true);
    const blockedRes = await relay.sendRelayMessage(userA, '小红', '晚上还聊吗');
    assert.equal(blockedRes.success, false);
    assert.ok(blockedRes.replyToSender.includes('免打扰'));

    // 恢复免打扰，测试把刚推荐/看中的电影安利分享给好友 B
    relay.setDnd(userB, false);
    const sm = SessionManager.getInstance();
    sm.setHot(userA, 'movie', [
      {
        id: '1292052',
        title: '沙丘2',
        rate: '8.3',
        year: '2024',
        types: ['科幻', '冒险'],
        shortComment: '史诗级视听震撼',
        cover: '',
        url: '',
      },
    ]);
    sm.setSearch(userA, '沙丘2', [
      {
        title: '沙丘2 4K 杜比视界',
        shareUrl: 'https://pan.quark.cn/s/dune2test',
        shareId: 'dune2test',
        panType: 'quark',
      },
    ]);

    const shareRes = await relay.shareMovieToUser(userA, '小红', {
      recommendReason: '这部电影很不错，推荐给你',
      skipNetworkLookup: true,
    });
    assert.equal(shareRes.success, true);
    assert.equal(sentPackets.length, 3);
    assert.equal(sentPackets[2].to, userB);
    assert.ok(sentPackets[2].text.includes('《沙丘2》'));
    assert.ok(sentPackets[2].text.includes('8.3'));
    assert.ok(sentPackets[2].text.includes('https://pan.quark.cn/s/dune2test'));

    // 验证 B 收到推荐卡片后可直接说“存一下”或“搜一下”触发一键搜存，且“把这部电影推荐给朋友”不会被误判为机器人邀请二维码
    const agent = new DeepSeekAgent('dummy');
    assert.equal(agent.isPendingImageSearchConfirm(userB, '存一下'), true);
    assert.equal(agent.isPendingImageSearchConfirm(userB, '搜一下'), true);
    assert.equal(new CommandHandler().isCommand('这部电影不错把这部电影推荐给朋友吧', userA), false);

    sm.clearSession(userA);
    sm.clearPendingImageSearch(userB);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const u of [userA, userB]) {
      const f = path.resolve(process.cwd(), 'data/users', `${Buffer.from(u).toString('hex')}.json`);
      setTimeout(() => {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {}
      }, 60);
    }
  }
});

test('UserProfileService builds explicit & time-decayed implicit taste profile and reranks with MMR', async () => {
  const testUser = '__taste_profile_test_user__';
  const svc = UserProfileService.getInstance();
  svc.clearProfile(testUser);

  try {
    // 1. 显式偏好 + 排雷
    svc.recordExplicitPreference(testUser, {
      likeGenres: ['科幻', '悬疑'],
      likeDirectors: ['克里斯托弗·诺兰'],
      dislikeGenres: ['恐怖'],
      enrichSeedsAsync: false,
    });

    // 2. 隐式转存行为
    await svc.recordImplicitBehavior(testUser, '星际穿越', 'save', {
      genres: ['科幻', '冒险'],
      region: '美国',
      directors: ['克里斯托弗·诺兰'],
      year: '2014',
      skipLookup: true,
    });

    const vecNow = svc.computeTagVector(testUser, Date.now());
    assert.ok(vecNow.genres['科幻'] >= 7.9); // 5.0(explicit) + 3.0(save)
    assert.ok(vecNow.directors['克里斯托弗·诺兰'] > 7);

    // 验证 30 天时间衰减（只剩一半左右隐式权重）
    const thirtyDaysLater = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const vecDecayed = svc.computeTagVector(testUser, thirtyDaysLater);
    assert.ok(vecDecayed.genres['科幻'] < vecNow.genres['科幻']);
    assert.ok(vecDecayed.genres['科幻'] >= 6.4); // 5.0 + 3.0 * 0.5

    // 3. 候选过滤（恐怖片直接排雷）与 MMR 重排
    const candidates = [
      {
        subject: {
          id: '1',
          title: '招魂',
          rate: '8.5',
          types: ['恐怖', '悬疑'],
          cover: '',
          url: '',
        },
        score: 90,
      },
      {
        subject: {
          id: '2',
          title: '盗梦空间',
          rate: '9.4',
          types: ['科幻', '悬疑'],
          directors: '克里斯托弗·诺兰',
          region: '美国',
          cover: '',
          url: '',
        },
        score: 85,
      },
      {
        subject: {
          id: '3',
          title: '看不见的客人',
          rate: '8.8',
          types: ['悬疑', '犯罪'],
          region: '西班牙',
          cover: '',
          url: '',
        },
        score: 82,
      },
    ];

    const ranked = svc.rerankWithMMR(testUser, candidates, 3);
    assert.equal(ranked.length, 2); // 恐怖片《招魂》被排雷过滤
    assert.equal(ranked[0].title, '盗梦空间');

    const card = svc.renderProfileCard(testUser);
    assert.ok(card.includes('科幻'));
    assert.ok(card.includes('恐怖'));

    // 4. 验证 /profile 指令
    const handler = new CommandHandler();
    assert.equal(handler.isCommand('/profile', testUser), true);
    const reply = await handler.handle('/profile', testUser);
    assert.ok(reply.includes('专属观影口味画像'));
  } finally {
    svc.clearProfile(testUser);
    const f = path.resolve(process.cwd(), 'data/users', `${Buffer.from(testUser).toString('hex')}.json`);
    setTimeout(() => {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }, 60);
  }
});

test('DashboardServer supports panel watch creation, safe task deletion, live channel probing, and safe JS', async () => {
  const testUser = '__panel_watch_probe_test__';
  const token = DashboardServer.issueUserToken(testUser);

  const server = http.createServer((req, res) => {
    DashboardServer.handleHttpRequest(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const healthFile = path.resolve(process.cwd(), 'data/channel_health.json');
  const hadHealthFile = fs.existsSync(healthFile);
  const origAxiosGet = axios.get;
  (axios as any).get = async () => ({
    status: 200,
    data: '<div class="tgme_widget_message_wrap"><a href="https://pan.quark.cn/s/abc123">quark</a></div>',
  });

  try {
    // 1. 确认 H5 控制台内联 JS 语法正确、无可选链、且未将字符串传给 showToast 的 duration 参数
    const htmlRes = await fetch(`${baseUrl}/panel?token=${encodeURIComponent(token)}`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 2);
    scripts.forEach((scriptBody, idx) => {
      assert.doesNotThrow(() => new vm.Script(scriptBody, { filename: `panel_script_${idx}.js` }));
    });
    const pageScript = scripts[1];
    assert.ok(html.includes('id="quickMediaChips"'));
    assert.ok(html.includes('id="personaSummaryPill"'));
    assert.ok(html.includes('id="vizRadar"'));
    assert.ok(html.includes('id="vizMediaDonut"'));
    assert.ok(html.includes('id="vizGauges"'));
    assert.ok(html.includes('id="vizTrend"'));
    assert.ok(html.includes('id="vizDecades"'));
    assert.ok(html.includes('id="vizPeople"'));
    assert.ok(html.includes('QUICK_GENRE_GROUPS'));
    assert.ok(html.includes('赛博朋克'));
    assert.ok(html.includes('谍战'));
    assert.ok(html.includes('律政'));
    assert.ok(pageScript.includes('function renderVizRadar'));
    assert.ok(pageScript.includes('function renderVizTrend'));
    assert.ok(pageScript.includes('function refreshPanel'));
    assert.ok(pageScript.includes('function createWatch'));
    assert.ok(pageScript.includes('function probeChannelsNow'));
    assert.equal(/\?\./.test(pageScript), false);
    assert.equal(/showToast\([^)]*["'](?:success|error|warning|info)["']\)/.test(pageScript), false);
    // 2. 创建电影/影视追更任务
    const createRes = await fetch(`${baseUrl}/api/panel/tasks?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_watch',
        title: '测试电影追更作品',
        mode: 'resource_watch',
        intervalMinutes: 15,
        autoSave: false,
        runInitialCheck: false,
      }),
    });
    assert.equal(createRes.status, 200);
    const createJson: any = await createRes.json();
    assert.equal(createJson.ok, true);
    assert.ok(createJson.task?.id);
    assert.equal(createJson.task.keyword, '测试电影追更作品');
    assert.ok(createJson.watchlist.some((w: any) => w.title === '测试电影追更作品'));

    const taskId = createJson.task.id;

    // 3. 切换暂停 & 正常删除 & 重复/空 taskId 安全返回
    const togRes = await fetch(`${baseUrl}/api/panel/tasks?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', taskId }),
    });
    assert.equal(togRes.status, 200);
    const togJson: any = await togRes.json();
    assert.equal(togJson.ok, true);
    assert.equal(togJson.task.enabled, false);

    const delRes = await fetch(`${baseUrl}/api/panel/tasks?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', taskId }),
    });
    assert.equal(delRes.status, 200);
    const delJson: any = await delRes.json();
    assert.equal(delJson.ok, true);

    const dupDelRes = await fetch(`${baseUrl}/api/panel/tasks?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', taskId }),
    });
    assert.equal(dupDelRes.status, 200);
    const dupDelJson: any = await dupDelRes.json();
    assert.equal(dupDelJson.ok, false);

    const emptyDelRes = await fetch(`${baseUrl}/api/panel/tasks?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', taskId: '' }),
    });
    assert.equal(emptyDelRes.status, 400);

    // 4. 频道健康度实时测速刷新接口
    const probeRes = await fetch(`${baseUrl}/api/panel/channels/probe?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(probeRes.status, 200);
    const probeJson: any = await probeRes.json();
    assert.equal(probeJson.ok, true);
    assert.ok(Array.isArray(probeJson.channels.topChannels));
    assert.ok(probeJson.channels.topChannels.length > 0);
    assert.ok(probeJson.channels.topChannels[0].avgLatencyMs > 0);
    assert.ok(probeJson.channels.topChannels[0].score > 75);

    // 5. Web 画像 API 支持全影视形态（电影/美剧/韩剧/动画/综艺等）增删与排雷
    const mtAddRes = await fetch(`${baseUrl}/api/panel/profile?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', category: 'likeMediaTypes', value: '美剧, 韩剧, 动画, 综艺' }),
    });
    assert.equal(mtAddRes.status, 200);
    const mtAddJson: any = await mtAddRes.json();
    assert.deepEqual(mtAddJson.tasteProfile.explicitLikes.mediaTypes, ['美剧', '韩剧', '动画', '综艺']);

    const mtDisRes = await fetch(`${baseUrl}/api/panel/profile?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', category: 'dislikeMediaTypes', value: '短剧' }),
    });
    assert.equal(mtDisRes.status, 200);
    const mtDisJson: any = await mtDisRes.json();
    assert.deepEqual(mtDisJson.tasteProfile.explicitDislikes.mediaTypes, ['短剧']);
  } finally {
    (axios as any).get = origAxiosGet;
    if (!hadHealthFile && fs.existsSync(healthFile)) {
      try {
        fs.unlinkSync(healthFile);
      } catch {}
    }
    const f = path.resolve(process.cwd(), 'data/users', `${Buffer.from(testUser).toString('hex')}.json`);
    setTimeout(() => {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }, 60);
    server.close();
  }
});

test('UserProfileService & DeepSeekAgent parse natural language preferences for movie/tv/variety and compute algorithmic profile', async () => {
  const testUser = '__nl_profile_analysis_test__';
  const svc = UserProfileService.getInstance();
  svc.clearProfile(testUser);

  try {
    const input = '我平时喜欢看韩国悬疑电影、美剧、韩剧、动画和搞笑综艺，最近也爱追《漫长的季节》这种国产剧，但是不喜欢恐怖片和短剧';
    assert.equal(UserProfileService.isNaturalPreferenceStatement(input), true);
    assert.equal(UserProfileService.isNaturalPreferenceStatement('帮我搜一下流浪地球'), false);

    const { parsed, analysis } = svc.applyNaturalLanguagePreference(testUser, input);
    assert.ok(parsed.likeMediaTypes.includes('电影'));
    assert.ok(parsed.likeMediaTypes.includes('美剧'));
    assert.ok(parsed.likeMediaTypes.includes('韩剧'));
    assert.ok(parsed.likeMediaTypes.includes('动画'));
    assert.ok(parsed.likeMediaTypes.includes('综艺'));
    assert.ok(parsed.likeMediaTypes.includes('国产剧'));
    assert.ok(parsed.dislikeMediaTypes.includes('短剧'));
    assert.ok(parsed.likeGenres.includes('悬疑'));
    assert.ok(parsed.likeGenres.includes('喜剧'));
    const richParsed = svc.parseNaturalLanguagePreference('我平时喜欢看赛博朋克、谍战、律政、医疗、美食和治愈系电影，不喜欢惊悚');
    assert.ok(richParsed.likeGenres.includes('赛博朋克'));
    assert.ok(richParsed.likeGenres.includes('谍战'));
    assert.ok(richParsed.likeGenres.includes('律政'));
    assert.ok(richParsed.likeGenres.includes('医疗'));
    assert.ok(richParsed.likeGenres.includes('美食'));
    assert.ok(richParsed.likeGenres.includes('治愈'));
    assert.ok(richParsed.dislikeGenres.includes('惊悚'));
    assert.ok(parsed.likeRegions.includes('韩国'));
    assert.ok(parsed.favoriteSeeds.includes('漫长的季节'));
    assert.ok(parsed.dislikeGenres.includes('恐怖'));

    assert.ok(analysis.confidence > 0);
    assert.ok(analysis.mediaTypeDistribution.length >= 4);
    assert.ok(analysis.personaLabel.length > 2);
    assert.ok(analysis.recommendationStrategy.includes('MMR'));

    // 验证算法打分支持全影视形态（美剧加分、动画加分、被屏蔽形态短剧返回 -Infinity）
    const usDramaScore = svc.scoreCandidate(testUser, {
      id: 'm1',
      title: '绝命毒师',
      rate: '9.7',
      region: '美国',
      episodesCount: '13',
      types: ['剧情', '犯罪'],
      cover: '',
      url: '',
    });
    const animeScore = svc.scoreCandidate(testUser, {
      id: 'a1',
      title: '葬送的芙莉莲',
      rate: '9.5',
      region: '日本',
      episodesCount: '28',
      types: ['动画', '奇幻'],
      cover: '',
      url: '',
    });
    const shortDramaScore = svc.scoreCandidate(testUser, {
      id: 's1',
      title: '霸总短剧',
      rate: '6.0',
      types: ['短剧'],
      cover: '',
      url: '',
    });
    assert.ok(usDramaScore > 0);
    assert.ok(animeScore > 0);
    assert.equal(shortDramaScore, -Infinity);

    // 验证隐式行为也可按全影视形态累计权重
    await svc.recordImplicitBehavior(testUser, '请回答1988', 'save', {
      mediaType: '韩剧',
      genres: ['剧情', '喜剧'],
      region: '韩国',
      year: '2015',
      skipLookup: true,
    });
    const webDetail = svc.getDetailedProfileForWeb(testUser);
    assert.ok(webDetail.topMediaTypes.some((m) => m.name === '韩剧' && m.score > 5));
    assert.ok(Array.isArray(webDetail.genreRadar) && webDetail.genreRadar.length >= 2);
    assert.equal(webDetail.weeklyActivity.length, 8);
    assert.ok(webDetail.signalMix.explicit > 0);
    assert.ok(webDetail.topDecades.some((d) => d.name === '2010s'));

    const card = svc.renderProfileCard(testUser);
    assert.ok(card.includes('专属观影口味画像'));
    assert.ok(card.includes('常看影视形态'));
    assert.ok(card.includes('美剧'));
    assert.ok(card.includes('动画'));
    assert.ok(card.includes('综艺'));
    assert.ok(card.includes('恐怖'));

    // 验证无 Key 离线兜底时 DeepSeekAgent 也能直接识别自然语言偏好并输出自然口吻画像
    const prevKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const agent = new DeepSeekAgent();
      const reply = await agent.chat('我比较爱看美剧、日剧、纪录片和脱口秀，不看古装剧', '__nl_agent_offline_test__');
      assert.ok(reply.includes('专属观影口味画像'));
      assert.ok(reply.includes('美剧'));
      assert.ok(reply.includes('日剧'));
      assert.ok(reply.includes('纪录片'));
      assert.ok(reply.includes('古装'));
      assert.equal(reply.includes('算法画像分析'), false);
    } finally {
      if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
    }
  } finally {
    svc.clearProfile(testUser);
    svc.clearProfile('__nl_agent_offline_test__');
    for (const u of [testUser, '__nl_agent_offline_test__']) {
      const f = path.resolve(process.cwd(), 'data/users', `${Buffer.from(u).toString('hex')}.json`);
      setTimeout(() => {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {}
      }, 60);
    }
  }
});

test('Watchlist full lifecycle: episode tracking, cloud save sync, profile-weighted pick, markdown export & Web API', async () => {
  const testUser = '__watchlist_full_test__';
  const um = UserManager.getInstance();
  const profileSvc = UserProfileService.getInstance();
  const token = DashboardServer.issueUserToken(testUser);

  const server = http.createServer((req, res) => {
    DashboardServer.handleHttpRequest(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. 验证 HTML 包含新版片单管理控件和弹窗
    const htmlRes = await fetch(`${baseUrl}/panel?token=${encodeURIComponent(token)}`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('id="wlStatusTabs"'));
    assert.ok(html.includes('id="wlQuickTitle"'));
    assert.ok(html.includes('id="mediaActionModal"'));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(/\?\./.test(scripts[1]), false);
    assert.doesNotThrow(() => new vm.Script(scripts[1], { filename: 'panel_watchlist_check.js' }));

    // 2. 添加剧集 + 更新集数至满集自动完成 + 备注
    const addRes = await fetch(`${baseUrl}/api/panel/watchlist?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', title: '漫长的季节', category: '国产剧', enrich: false }),
    });
    assert.equal(addRes.status, 200);
    um.updateWatchlistItem(testUser, '漫长的季节', { rating: '9.4', totalEpisodes: 2, genres: ['悬疑', '犯罪'] });

    const ep1Res = await fetch(`${baseUrl}/api/panel/watchlist?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'episode', title: '漫长的季节', delta: 1 }),
    });
    const ep1Json: any = await ep1Res.json();
    assert.equal(ep1Json.item.currentEpisode, 1);
    assert.equal(ep1Json.item.status, 'saving');

    const ep2Res = await fetch(`${baseUrl}/api/panel/watchlist?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'episode', title: '漫长的季节', delta: 1 }),
    });
    const ep2Json: any = await ep2Res.json();
    assert.equal(ep2Json.item.currentEpisode, 2);
    assert.equal(ep2Json.item.status, 'completed');

    // 3. 验证画像抽签（推荐待看的高匹配高分片）
    um.addToWatchlist(testUser, '信号', '韩剧');
    um.updateWatchlistItem(testUser, '信号', { rating: '9.2', genres: ['悬疑', '犯罪'], region: '韩国' });
    um.addToWatchlist(testUser, '普通电影', '电影');
    um.updateWatchlistItem(testUser, '普通电影', { rating: '5.5', genres: ['爱情'] });
    profileSvc.recordExplicitPreference(testUser, { likeMediaTypes: ['韩剧'], likeGenres: ['悬疑'] });

    const pickRes = await fetch(`${baseUrl}/api/panel/watchlist?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pick', count: 2 }),
    });
    const pickJson: any = await pickRes.json();
    assert.equal(pickJson.ok, true);
    assert.equal(pickJson.picks[0].item.title, '信号');

    // 4. recordSave 自动将片单中作品标为已看且网盘已有
    um.recordSave(testUser, '信号', 'https://pan.quark.cn/s/signal123', '韩剧', '/我的资源/韩剧/信号');
    const savedSignal = um.getUserPlan(testUser).watchlist.find((w) => w.title === '信号');
    assert.equal(savedSignal?.status, 'completed');
    assert.equal(savedSignal?.inCloudDisk, true);
    assert.equal(savedSignal?.cloudPath, '/我的资源/韩剧/信号');

    // 5. Markdown 导出 & 命令联动（/片单抽签, /追剧 导出）
    const expRes = await fetch(`${baseUrl}/api/panel/watchlist?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'export' }),
    });
    const expJson: any = await expRes.json();
    assert.ok(expJson.markdown.includes('漫长的季节'));
    assert.ok(expJson.markdown.includes('网盘已有'));

    const handler = new CommandHandler();
    const cmdList = await handler.handle('/追剧', testUser);
    assert.ok(cmdList.includes('漫长的季节'));
    assert.ok(cmdList.includes('网盘已有'));
  } finally {
    profileSvc.clearProfile(testUser);
    const f = path.resolve(process.cwd(), 'data/users', `${Buffer.from(testUser).toString('hex')}.json`);
    setTimeout(() => {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }, 60);
    server.close();
  }
});

test('微信图片 AES 密钥编码与 QRCode PNG 加解密闭环', async () => {
  const aeskey = crypto.randomBytes(16);
  const pngBuf = await QRCode.toBuffer('https://weixin.qq.com/x/test-invite', { width: 360, margin: 2 });
  assert.equal(pngBuf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const cipher = crypto.createCipheriv('aes-128-ecb', aeskey, null);
  const ciphertext = Buffer.concat([cipher.update(pngBuf), cipher.final()]);

  // 微信客户端解码链路: base64_decode -> 32位 ASCII hex -> fromhex() -> 16字节密钥
  const encodedAesKey = encodeWechatMediaAesKey(aeskey);
  assert.equal(encodedAesKey.length, 44);
  const asciiHex = Buffer.from(encodedAesKey, 'base64').toString('ascii');
  assert.match(asciiHex, /^[0-9a-f]{32}$/);
  assert.equal(asciiHex, aeskey.toString('hex'));

  const decodedKey = Buffer.from(asciiHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-128-ecb', decodedKey, null);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(decrypted.equals(pngBuf), true);
});

test('好友邀请提示与二维码生成文案具备自然真人感', async () => {
  const testUser = `__test_invite_${Date.now()}__`;
  const handler = new CommandHandler();
  const origAxiosPost = axios.post;
  const origGetInstance = WeixinBot.getInstance;
  let capturedImagePath = '';

  try {
    const askReply = await handler.handle('我想把你推荐给别人', testUser);
    assert.ok(askReply.includes('共享'));
    assert.ok(askReply.includes('独立'));
    assert.equal(askReply.includes('----'), false);
    assert.equal(askReply.includes('API Key'), false);

    (axios as any).post = async () => ({
      data: {
        qrcode: 'qr_mock_token_123',
        qrcode_img_content: 'https://weixin.qq.com/x/mock-qr-123',
      },
    });
    (WeixinBot as any).getInstance = () => ({
      getAllBotTokens: () => [],
      waitForLogin: async () => null,
      sendImageMessage: async (_to: string, imgPath: string) => {
        capturedImagePath = imgPath;
        return fs.existsSync(imgPath) && fs.readFileSync(imgPath).subarray(0, 4).toString('hex') === '89504e47';
      },
    });

    const qrReply = await handler.handle('共享', testUser);
    assert.ok(capturedImagePath.endsWith('.png'));
    assert.ok(qrReply.includes('5 分钟内'));
    assert.ok(qrReply.includes('https://weixin.qq.com/x/mock-qr-123'));
    assert.equal(qrReply.includes('----'), false);
    assert.equal(qrReply.includes('📌'), false);
  } finally {
    (axios as any).post = origAxiosPost;
    (WeixinBot as any).getInstance = origGetInstance;
    const f = path.resolve(process.cwd(), 'data/users', `${Buffer.from(testUser).toString('hex')}.json`);
    setTimeout(() => {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }, 60);
  }
});

test('影视封面安全校验、魔数识别、H5海报代理防SSRF及微信封面下发链路', async () => {
  assert.equal(isAllowedPosterUrl('https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2905327559.jpg'), true);
  assert.equal(isAllowedPosterUrl('https://image.tmdb.org/t/p/w500/abc.jpg'), true);
  assert.equal(isAllowedPosterUrl('http://127.0.0.1:8080/secret'), false);
  assert.equal(isAllowedPosterUrl('file:///etc/passwd'), false);

  assert.deepEqual(detectImageMimeAndExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7])), {
    mime: 'image/jpeg',
    ext: 'jpg',
  });
  assert.deepEqual(detectImageMimeAndExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 1])), {
    mime: 'image/png',
    ext: 'png',
  });
  assert.equal(detectImageMimeAndExt(Buffer.from('<html>403 Forbidden</html>')), null);

  // 验证 H5 /api/panel/poster 会拦截非法域名，并对合法豆瓣封面代理返回图片且前端 JS 无可选链
  const token = DashboardServer.issueUserToken('__poster_test_user__', 60000);
  const pngBytes = await QRCode.toBuffer('https://movie.douban.com/subject/123/', { width: 120 });
  const origAxiosGet = axios.get;
  let capturedImagePath = '';
  const server = http.createServer((req, res) => {
    DashboardServer.handleHttpRequest(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const blocked = await fetch(`${baseUrl}/api/panel/poster?token=${encodeURIComponent(token)}&url=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`);
    assert.equal(blocked.status, 400);

    (axios as any).get = async () => ({ data: pngBytes });
    const okPoster = await fetch(`${baseUrl}/api/panel/poster?token=${encodeURIComponent(token)}&url=${encodeURIComponent('https://img9.doubanio.com/view/photo/s_ratio_poster/public/p12345.jpg')}`);
    assert.equal(okPoster.status, 200);
    assert.equal(okPoster.headers.get('content-type'), 'image/png');
    const fetchedBuf = Buffer.from(await okPoster.arrayBuffer());
    assert.equal(fetchedBuf.equals(pngBytes), true);

    // 验证微信端封面下发通道闭环与临时文件自动清理
    PushGateway.getInstance().registerImageSender(async (_to, imgPath) => {
      capturedImagePath = imgPath;
      return fs.existsSync(imgPath) && fs.readFileSync(imgPath).equals(pngBytes);
    });
    const sent = await sendCoverToWechatUser('__poster_test_user__', {
      title: '测试影片',
      knownCover: 'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p12345.jpg',
    });
    assert.equal(sent, true);
    assert.ok(capturedImagePath.endsWith('.png'));
    assert.equal(fs.existsSync(capturedImagePath), false);
  } finally {
    PushGateway.getInstance().registerImageSender(null);
    (axios as any).get = origAxiosGet;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('MetadataResolver.extractMediaQuery 能准确剥离网盘画质与标签噪点提取片名和年份', () => {
  assert.deepEqual(MetadataResolver.extractMediaQuery('【原盘】星际穿越 (2014) 4K REMUX 外挂中字字幕'), {
    title: '星际穿越',
    year: '2014',
  });
  assert.deepEqual(MetadataResolver.extractMediaQuery('功夫 (2004) 4K 高码 60帧 国粤多音轨'), {
    title: '功夫',
    year: '2004',
  });
  assert.deepEqual(MetadataResolver.extractMediaQuery('《好东西》'), {
    title: '好东西',
    year: undefined,
  });
});

test('CommandHandler.renderHot 单部推荐自动配发影视海报封面，多部榜单不刷屏', async () => {
  const { AiRecommender } = require('../services/AiRecommender');
  const recommender = AiRecommender.getInstance();
  const origGenerate = recommender.generateXiaohongshuNote;
  const origAxiosGet = axios.get;
  const pngBytes = await QRCode.toBuffer('https://movie.douban.com/subject/3541415/', { width: 120 });
  const sentImages: Array<{ to: string; existsAtSend: boolean }> = [];

  try {
    (axios as any).get = async () => ({ data: pngBytes });
    PushGateway.getInstance().registerImageSender(async (to, imgPath) => {
      sentImages.push({ to, existsAtSend: fs.existsSync(imgPath) });
      return true;
    });

    const handler = new CommandHandler();
    recommender.generateXiaohongshuNote = async () => ({
      title: '欢迎来龙餐馆',
      items: [],
      formattedNote: '给你推荐《欢迎来龙餐馆》~',
      subjects: [
        {
          id: '35633851',
          title: '欢迎来龙餐馆',
          rate: '8.7',
          year: '2026',
          cover: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2935109312.jpg',
          url: '',
        },
      ],
      slots: { mediaType: 'movie', doubanTag: '热门', count: 1 },
    });

    const reply1 = await handler.renderHot('movie', '热门', '__rec_cover_user__', 1, undefined, '给我推荐一部电影');
    assert.ok(reply1.includes('欢迎来龙餐馆'));
    assert.equal(sentImages.length, 1);
    assert.equal(sentImages[0].to, '__rec_cover_user__');
    assert.equal(sentImages[0].existsAtSend, true);

    // 多部榜单不应连发多张图片刷屏
    recommender.generateXiaohongshuNote = async () => ({
      title: '热门榜单',
      items: [],
      formattedNote: '热门片单如下...',
      subjects: [
        { id: '1', title: 'A', rate: '8.5', cover: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg', url: '' },
        { id: '2', title: 'B', rate: '8.6', cover: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2.jpg', url: '' },
      ],
      slots: { mediaType: 'movie', doubanTag: '热门', count: 2 },
    });
    await handler.renderHot('movie', '热门', '__rec_cover_user__', 1);
    assert.equal(sentImages.length, 1);
  } finally {
    recommender.generateXiaohongshuNote = origGenerate;
    (axios as any).get = origAxiosGet;
    PushGateway.getInstance().registerImageSender(null);
  }
});
