'use strict';

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

async function ensureOffscreen() {
  if (creating) return creating;
  creating = (async () => {
    try {
      if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
        });
        if (contexts && contexts.length) return;
      }
    } catch (_) { /* 老版本 Chrome 没有 getContexts */ }
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['DOM_PARSER'],
        justification: '在本地解码验证码图片并运行 OCR 模型',
      });
    } catch (e) {
      // 已经存在时 createDocument 会报错，忽略即可
      if (!/single offscreen|already exists/i.test(String(e))) throw e;
    }
  })();
  try {
    await creating;
  } finally {
    creating = null;
  }
}

async function ocr(dataUrl) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', dataUrl });
  if (!r) throw new Error('OCR 页面没有响应');
  if (!r.ok) throw new Error(r.error || 'OCR 失败');
  return r.text;
}

async function warmup() {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage({ target: 'offscreen', type: 'warmup' });
  } catch (e) {
    // 模型加载失败：把错误带给日志，下次调用会重试
    return { ok: false, error: String(e) };
  }
}

function notify(title, message) {
  try {
    chrome.notifications.create('seu-grab-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title || 'SEU 抢票助手',
      message: message || '',
      priority: 2,
    });
  } catch (_) { /* 通知不可用时忽略 */ }
}

async function tabAlive(tabId) {
  if (tabId === undefined || tabId === null) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!(tab && tab.id !== undefined);
  } catch (_) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'ocr':
          sendResponse({ ok: true, text: await ocr(msg.dataUrl) });
          break;

        case 'warmup':
          sendResponse(await warmup());
          break;

        case 'arm': {
          const tabId = sender.tab && sender.tab.id;
          if (tabId === undefined) {
            sendResponse({ ok: false, error: '只能在讲座详情页锁定' });
            break;
          }
          const target = msg.lecture || {};
          if (!target.wid || !target.openTs) {
            sendResponse({ ok: false, error: '锁定信息不完整' });
            break;
          }
          const armed = {
            ...target,
            tabId,
            armedAt: Date.now(),
          };
          await chrome.storage.local.set({ armed });
          await chrome.storage.local.remove('grabLock');

          // 开抢前 1 分钟提醒 + 预热 OCR 模型
          const alarmAt = target.openTs - 60 * 1000;
          if (alarmAt > Date.now()) {
            chrome.alarms.create('seu-preopen', { when: alarmAt });
          } else {
            chrome.alarms.clear('seu-preopen');
          }
          sendResponse({ ok: true, armed });
          break;
        }

        case 'disarm':
          await chrome.storage.local.remove(['armed', 'grabLock']);
          await chrome.alarms.clear('seu-preopen');
          sendResponse({ ok: true });
          break;

        case 'getState': {
          const { armed } = await chrome.storage.local.get('armed');
          const tabId = sender.tab && sender.tab.id;
          sendResponse({
            ok: true,
            armed: armed || null,
            isOwner: !!(armed && tabId !== undefined && armed.tabId === tabId),
          });
          break;
        }

        case 'claimGrab': {
          let { armed } = await chrome.storage.local.get('armed');
          const tabId = sender.tab && sender.tab.id;
          if (!armed || tabId === undefined) {
            sendResponse({ ok: false, error: '没有锁定任务' });
            break;
          }
          if (armed.tabId !== tabId) {
            // 原来是“只认锁定时的标签页”；标签页关了/刷新到别的页面后就永远没人抢。
            // 原标签页已关闭，或已到开抢后 2 秒还没接管，就转交给当前详情页。
            const alive = await tabAlive(armed.tabId);
            const late = Date.now() > (armed.openTs || 0) + 2000;
            if (alive && !late) {
              sendResponse({ ok: false, error: '不是锁定所在标签页' });
              break;
            }
            armed = { ...armed, tabId };
            await chrome.storage.local.set({ armed });
          }
          const { grabLock } = await chrome.storage.local.get('grabLock');
          if (grabLock && Date.now() - grabLock.ts < 10 * 60 * 1000) {
            sendResponse({ ok: false, error: '已经在抢了' });
            break;
          }
          const lock = { tabId, ts: Date.now() };
          await chrome.storage.local.set({ grabLock: lock });
          // 再读一次，尽量只让一个标签页拿到锁
          const check = await chrome.storage.local.get('grabLock');
          if (!check.grabLock || check.grabLock.tabId !== tabId) {
            sendResponse({ ok: false, error: '另一个标签页已接管' });
            break;
          }
          sendResponse({ ok: true });
          break;
        }

        case 'notify':
          notify(msg.title, msg.message);
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // 异步 sendResponse
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'seu-preopen') return;
  const { armed } = await chrome.storage.local.get('armed');
  if (!armed) return;
  notify('⏰ 1 分钟后开抢', armed.title || '已锁定的讲座');
  warmup().catch(() => {});
  if (await tabAlive(armed.tabId)) {
    chrome.tabs.sendMessage(armed.tabId, { type: 'preopen' }).catch(() => {});
  } else {
    // 标签页没了，页面里的定时器也没了，靠后台没法提交预约，只能提醒人回来
    notify('⚠ 抢票标签页已关闭', '请在开抢前重新打开该讲座详情页并重新锁定。');
    await chrome.storage.local.remove(['armed', 'grabLock']);
  }
});
