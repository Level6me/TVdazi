import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import http from 'http';
import * as os from 'os';
import * as path from 'path';

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

    relay.setMyNickname(userA, '小明');
    relay.setMyNickname(userB, '小红');
    assert.equal(relay.getDisplayName(userA), '小明');
    assert.equal(relay.getDisplayName(userB), '小红');

    // A -> B 传话
    const sendRes = await relay.sendRelayMessage(userA, '小红', '最近有什么好看的电影');
    assert.equal(sendRes.success, true);
    assert.equal(sentPackets.length, 1);
    assert.equal(sentPackets[0].to, userB);
    assert.ok(sentPackets[0].text.includes('小明'));
    assert.ok(sentPackets[0].text.includes('最近有什么好看的电影'));

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
