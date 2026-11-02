'use strict';

(() => {
  if (window.__SEU_GRAB_LOADED__) return;
  window.__SEU_GRAB_LOADED__ = true;

  const API_BASE = '/gsapp/sys/yddjzxxtjappseu/modules/hdyy';
  const HOST_ID = 'seu-grab-host';
  const TICK_MS = 5000;
  const HOT_WINDOW_MS = 180 * 1000; // 开抢后密集尝试 3 分钟
  const MAX_START_DELAY_MS = 60000;

  const S = {
    wid: null,
    detail: null,
    offset: 0,
    armed: null,
    isOwner: false,
    running: false,
    phase: 'idle',
    status: '',
    statusKind: '',
    timer: null,
    host: null,
    root: null,
    collapsed: false,
    testBusy: false,
    audio: null,
    startDelayMs: 0,
    retryDelayMs: null,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 工具 ----------
  function getWid() {
    const m = (location.hash || '').match(/[#/]hdxq\?WID=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // 服务端时间格式 "2026-10-22 19:00:00"（北京时间），转成 UTC 毫秒
  function parseTs(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0));
  }

  function serverNow() {
    return Date.now() + S.offset;
  }

  function fmtTs(ts) {
    if (!ts) return '?';
    const d = new Date(ts + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  function fmtCountdown(ms) {
    if (ms <= 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(sec)}`;
  }

  function beep(freq, durMs, count) {
    try {
      if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = S.audio;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      for (let i = 0; i < (count || 1); i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.value = 0.06;
        osc.connect(gain);
        gain.connect(ctx.destination);
        const t = ctx.currentTime + i * (durMs + 120) / 1000;
        osc.start(t);
        osc.stop(t + durMs / 1000);
      }
    } catch (_) { /* 静音失败无所谓 */ }
  }

  // ---------- 接口 ----------
  async function post(path, params) {
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams(params).toString(),
        credentials: 'include',
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error('网络请求失败（可能登录已失效）');
    }
    if (res.redirected || /auth\.seu\.edu\.cn/.test(res.url)) {
      throw new Error('登录已失效，请在页面上重新登录');
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error('接口返回异常（可能登录已失效）');
    }
  }

  async function getDetail(wid) {
    const t0 = Date.now();
    const j = await post('/getActivityDetail.do', { wid });
    const t1 = Date.now();
    if (!j || j.code !== 0 || !j.datas || !j.datas.hdxq) {
      throw new Error((j && j.msg) || '读取讲座详情失败');
    }
    const h = j.datas.hdxq;
    const serverEpoch = parseTs(h.NOW || (j.datas && j.datas.xtdqsj));
    if (serverEpoch) {
      // 用往返中点估算本机与服务器的时钟差
      S.offset = serverEpoch - (t0 + t1) / 2;
    }
    return h;
  }

  async function getVcode() {
    let res;
    try {
      res = await fetch(`${API_BASE}/vcode.do?_=${Date.now()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error('获取验证码失败（网络）');
    }
    if (res.redirected || /auth\.seu\.edu\.cn/.test(res.url)) {
      throw new Error('登录已失效，请在页面上重新登录');
    }
    const j = await res.json();
    const d = j && j.datas;
    if (typeof d !== 'string' || !/^data:image\//.test(d)) {
      throw new Error((j && j.msg) || '获取验证码失败');
    }
    return d;
  }

  async function ocrImage(dataUrl) {
    const r = await chrome.runtime.sendMessage({ type: 'ocr', dataUrl });
    if (!r || !r.ok) throw new Error((r && r.error) || 'OCR 失败');
    return r.text;
  }

  async function addReservation(wid, vcode) {
    return await post('/addReservation.do', { wid, vcode });
  }

  async function fetchCode() {
    const img = await getVcode();
    const text = await ocrImage(img);
    return (text || '').trim();
  }

  async function getSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      return Object.assign({ monitorUntilClose: true }, settings || {});
    } catch (_) {
      return { monitorUntilClose: true };
    }
  }

  function normalizeStartDelay(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= MAX_START_DELAY_MS ? n : 0;
  }

  function grabStartTs(openTs) {
    return openTs + S.startDelayMs;
  }

  function normalizeRetryDelay(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= MAX_START_DELAY_MS ? n : null;
  }

  async function saveDelays() {
    if (S.running) return;
    const input = S.root.getElementById('startDelay');
    const retryInput = S.root.getElementById('retryDelay');
    if (input.value.trim() === '' || !input.reportValidity()) return;
    if (!retryInput.reportValidity()) return;
    const value = Math.round(Number(input.value) * 1000);
    const retryValue = retryInput.value.trim() === '' ? null : Math.round(Number(retryInput.value) * 1000);
    if (!Number.isInteger(value) || value < 0 || value > MAX_START_DELAY_MS) return;
    if (retryValue !== null && (!Number.isInteger(retryValue) || retryValue < 0 || retryValue > MAX_START_DELAY_MS)) return;
    try {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, startDelayMs: value, retryDelayMs: retryValue } });
      S.startDelayMs = value;
      S.retryDelayMs = retryValue;
      delete input.dataset.dirty;
      delete retryInput.dataset.dirty;
      setStatus(`已保存：开抢延迟 ${value / 1000} 秒，重试间隔${retryValue === null ? '自动' : ' ' + retryValue / 1000 + ' 秒'}`, 'ok');
      render();
      schedule();
    } catch (e) {
      setStatus('保存延迟失败：' + e.message, 'err');
    }
  }

  // ---------- 面板 ----------
  function ensurePanel() {
    if (S.host && document.documentElement.contains(S.host)) return S.root;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
    }
    host.style.cssText =
      'all: initial; position: fixed; top: 84px; right: 16px; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel { width: 300px; background: #fff; border: 1px solid #dbe4dc; border-radius: 12px;
          box-shadow: 0 10px 30px rgba(0,0,0,.18); overflow: hidden;
          font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          color: #1f2d24; }
        .hd { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
          background: linear-gradient(135deg, #16a05a, #0f7a45); color: #fff;
          cursor: grab; user-select: none; touch-action: none; }
        .hd:active { cursor: grabbing; }
        .hd b { font-size: 13px; font-weight: 600; letter-spacing: .2px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #c9f5da;
          box-shadow: 0 0 0 3px rgba(255,255,255,.25); }
        .hd .sp { flex: 1; }
        .hd button { all: unset; cursor: pointer; color: #fff; padding: 0 4px; font-size: 16px; opacity: .9; }
        .bd { padding: 10px 12px 12px; }
        .t { font-weight: 600; font-size: 13px; line-height: 1.4; margin-bottom: 4px; word-break: break-all; }
        .m { color: #5b6b60; font-size: 12px; word-break: break-all; }
        .cd { margin: 8px 0 4px; font-size: 22px; font-weight: 700; letter-spacing: .5px;
          color: #0f7a45; font-variant-numeric: tabular-nums; }
        .cd.warn { color: #b26a00; }
        .cd.err { color: #c62828; }
        .st { min-height: 18px; font-size: 12px; color: #5b6b60; word-break: break-all; }
        .st.ok { color: #0f7a45; } .st.err { color: #c62828; } .st.warn { color: #b26a00; }
        .row { display: flex; gap: 8px; margin-top: 10px; }
        .row button { flex: 1; border: 0; border-radius: 8px; padding: 8px 10px; font-size: 12px; cursor: pointer; }
        .primary { background: #16a05a; color: #fff; }
        .primary:disabled { opacity: .5; cursor: default; }
        .ghost { background: #eef5f0; color: #225c3e; }
        .ghost:disabled { opacity: .5; cursor: default; }
        .hint { margin-top: 8px; font-size: 11px; color: #8a998f; line-height: 1.45; }
        .delay { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; }
        .delay input { width: 85px; padding: 5px; border: 1px solid #dbe4dc; border-radius: 5px; font: inherit; }
        .delay button { border: 0; border-radius: 5px; padding: 6px 8px; cursor: pointer; }
        .bd.hide { display: none; }
      </style>
      <div class="panel">
        <div class="hd" title="拖动标题栏移动窗口">
          <span class="dot"></span><b>SEU 抢票助手</b><span class="sp"></span>
          <button data-act="collapse" title="收起/展开">–</button>
        </div>
        <div class="bd" id="bd">
          <div class="t" id="t">识别中…</div>
          <div class="m" id="m"></div>
          <div class="cd" id="cd">--</div>
          <div class="st" id="st"></div>
          <div id="otherLock" style="display:none">
            <div class="m" id="otherLockTitle"></div>
            <div class="row"><button class="ghost" data-act="disarm">取消当前锁定</button></div>
          </div>
          <div class="delay">
            <label for="startDelay">开抢延迟</label>
            <input id="startDelay" type="number" min="0" max="60" step="0.001" value="0" required aria-describedby="delayHint">
            <span>秒</span>
          </div>
          <div class="delay">
            <label for="retryDelay">重试间隔</label>
            <input id="retryDelay" type="number" min="0" max="60" step="0.001" placeholder="自动" aria-describedby="delayHint">
            <span>秒</span><button class="ghost" id="saveDelay" data-act="saveDelay">保存</button>
          </div>
          <div class="hint" id="delayHint">开抢延迟默认 0 秒；重试间隔为失败后的等待时间，留空自动。支持小数，范围 0～60 秒，开始抢票前可保存。</div>
          <div class="row">
            <button class="primary" id="arm" data-act="arm">锁定本场</button>
            <button class="ghost" id="test" data-act="test">测试 OCR</button>
          </div>
          <div class="hint">开抢前请保持本标签页在前台；首次识别模型加载约 1~3 秒。</div>
        </div>
      </div>`;
    const header = root.querySelector('.hd');
    root.getElementById('startDelay').addEventListener('input', (ev) => {
      ev.target.dataset.dirty = 'true';
    });
    root.getElementById('retryDelay').addEventListener('input', (ev) => {
      ev.target.dataset.dirty = 'true';
    });
    let drag = null;
    header.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !ev.isPrimary || ev.target.closest('button')) return;
      const rect = host.getBoundingClientRect();
      drag = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top };
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.right = 'auto';
      header.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    header.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const rect = host.getBoundingClientRect();
      const left = Math.max(0, Math.min(window.innerWidth - rect.width, drag.left + ev.clientX - drag.x));
      const top = Math.max(0, Math.min(window.innerHeight - rect.height, drag.top + ev.clientY - drag.y));
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
    });
    const endDrag = (ev) => {
      if (drag && ev.pointerId === drag.pointerId) drag = null;
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
    header.addEventListener('lostpointercapture', endDrag);
    root.addEventListener('click', (ev) => {
      // 别让点击冒泡到学校页面的全局处理器
      ev.stopPropagation();
      const btn = ev.target.closest && ev.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'collapse') {
        S.collapsed = !S.collapsed;
        const bd = root.getElementById('bd');
        if (bd) bd.classList.toggle('hide', S.collapsed);
        btn.textContent = S.collapsed ? '+' : '–';
      } else if (act === 'arm') {
        doArm().catch((e) => setStatus('操作失败：' + e.message, 'err'));
      } else if (act === 'disarm') {
        doDisarm().catch((e) => setStatus('取消失败：' + e.message, 'err'));
      } else if (act === 'test') {
        testOcr().catch((e) => setStatus('OCR 测试失败：' + e.message, 'err'));
      } else if (act === 'saveDelay') {
        saveDelays();
      }
    });
    S.host = host;
    S.root = root;
    return root;
  }

  function setStatus(text, kind) {
    S.status = text || '';
    S.statusKind = kind || '';
    const st = S.root && S.root.getElementById('st');
    if (st) {
      st.textContent = S.status;
      st.className = 'st ' + (kind || '');
    }
  }

  function render() {
    if (!S.detail) return;
    const root = ensurePanel();
    const t = root.getElementById('t');
    const m = root.getElementById('m');
    const arm = root.getElementById('arm');
    const test = root.getElementById('test');
    const cd = root.getElementById('cd');
    if (!t) return;
    if (test) test.disabled = S.running;
    const delayInput = root.getElementById('startDelay');
    if (root.activeElement !== delayInput && !delayInput.dataset.dirty) delayInput.value = S.startDelayMs / 1000;
    delayInput.disabled = S.running;
    const retryInput = root.getElementById('retryDelay');
    if (root.activeElement !== retryInput && !retryInput.dataset.dirty) retryInput.value = S.retryDelayMs === null ? '' : S.retryDelayMs / 1000;
    retryInput.disabled = S.running;
    root.getElementById('saveDelay').disabled = S.running;
    const otherArmed = S.armed && S.armed.wid !== S.wid;
    root.getElementById('otherLock').style.display = otherArmed ? '' : 'none';
    root.getElementById('otherLockTitle').textContent = otherArmed ? '当前锁定：' + (S.armed.title || '其他讲座') : '';

    const h = S.detail;
    t.textContent = h.JZMC || '未命名讲座';
    const parts = [];
    parts.push(`预约 ${fmtTs(parseTs(h.YYKSSJ))} ~ ${fmtTs(parseTs(h.YYJSSJ))}`);
    const total = Number(h.HDZRS || 0);
    const used = Number(h.YYRS || 0);
    parts.push(`名额 ${used} / ${total}`);
    if (h.JZDD) parts.push(h.JZDD);
    m.textContent = parts.join('　·　');

    const booked = !!h.YY_WID;
    const openTs = parseTs(h.YYKSSJ);
    const startTs = openTs && grabStartTs(openTs);
    const closeTs = parseTs(h.YYJSSJ);
    const isArmed = !!(S.armed && S.armed.wid === S.wid);

    if (booked) {
      arm.disabled = true;
      arm.textContent = '已预约';
      cd.textContent = '✓ 已预约';
      cd.className = 'cd';
    } else if (isArmed) {
      arm.disabled = false;
      arm.textContent = '取消锁定';
      const now = serverNow();
      if (startTs && now < startTs) {
        cd.textContent = (now >= openTs ? '延迟等待 ' : '') + fmtCountdown(startTs - now);
        cd.className = 'cd';
      } else if (closeTs && now < closeTs) {
        cd.textContent = '已开抢 · 盯回流';
        cd.className = 'cd warn';
      } else {
        cd.textContent = '预约已截止';
        cd.className = 'cd err';
      }
    } else {
      arm.disabled = false;
      arm.textContent = '锁定本场';
      const now = serverNow();
      if (openTs && now < openTs) {
        cd.textContent = '距开抢 ' + fmtCountdown(openTs - now);
        cd.className = 'cd';
      } else if (closeTs && now < closeTs) {
        cd.textContent = '预约已开放';
        cd.className = 'cd warn';
      } else {
        cd.textContent = '预约已截止';
        cd.className = 'cd err';
      }
    }
  }

  function tickCountdown() {
    if (!S.detail || !S.root) return;
    const cd = S.root.getElementById('cd');
    const h = S.detail;
    if (!cd || h.YY_WID) return;
    if (!(S.armed && S.armed.wid === S.wid)) return;
    const openTs = parseTs(h.YYKSSJ);
    const startTs = openTs && grabStartTs(openTs);
    const closeTs = parseTs(h.YYJSSJ);
    const now = serverNow();
    if (startTs && now < startTs) {
      cd.textContent = (now >= openTs ? '延迟等待 ' : '') + fmtCountdown(startTs - now);
      cd.className = 'cd';
    } else if (closeTs && now < closeTs) {
      cd.textContent = '已开抢 · 盯回流';
      cd.className = 'cd warn';
    }
  }

  // ---------- 锁定 / 取消 ----------
  async function doDisarm() {
    const r = await chrome.runtime.sendMessage({ type: 'disarm' });
    if (!r || !r.ok) throw new Error((r && r.error) || '后台未响应，请重试');
    clearTimeout(S.timer);
    S.timer = null;
    S.armed = null;
    S.isOwner = false;
    S.phase = 'idle';
    setStatus('已取消锁定，可以锁定新场次', 'ok');
    render();
  }

  async function doArm() {
    if (!S.detail || !S.wid) {
      setStatus('请先打开讲座详情页', 'warn');
      return;
    }
    if (S.detail.YY_WID) {
      setStatus('这场你已经预约过了', 'warn');
      return;
    }
    // 一次只锁一场，避免在另一场详情页误点把原来的锁定顶掉
    if (S.armed && S.armed.wid !== S.wid) {
      setStatus('已锁定另一场，请点击「取消当前锁定」后再锁定本场', 'warn');
      return;
    }
    const isArmed = !!(S.armed && S.armed.wid === S.wid);
    if (isArmed) {
      await doDisarm();
      return;
    }

    const openTs = parseTs(S.detail.YYKSSJ);
    const closeTs = parseTs(S.detail.YYJSSJ);
    if (!openTs) {
      setStatus('没解析到预约开放时间', 'err');
      return;
    }
    if (closeTs && serverNow() >= closeTs) {
      setStatus('预约窗口已截止', 'err');
      return;
    }

    const lecture = {
      wid: S.wid,
      title: S.detail.JZMC || '',
      openTs,
      closeTs,
      total: Number(S.detail.HDZRS || 0),
      used: Number(S.detail.YYRS || 0),
      place: S.detail.JZDD || '',
      category: S.detail.JZXL_DISPLAY || '',
      lectureTs: parseTs(S.detail.JZSJ),
    };
    const r = await chrome.runtime.sendMessage({ type: 'arm', lecture });
    if (!r || !r.ok) {
      setStatus('锁定失败：' + ((r && r.error) || '未知错误'), 'err');
      return;
    }
    S.armed = r.armed;
    S.isOwner = true;
    S.phase = 'armed';
    setStatus(grabStartTs(openTs) > serverNow() ? `已锁定，开抢后延迟 ${S.startDelayMs / 1000} 秒提交` : '已锁定，立即开始抢', 'ok');
    beep(880, 120, 1);
    // 提前把 OCR 模型加载好，避免开抢瞬间现加载
    chrome.runtime.sendMessage({ type: 'warmup' }).catch(() => {});
    render();
    schedule();
  }

  function schedule() {
    clearTimeout(S.timer);
    S.timer = null;
    if (S.running) return;
    if (!S.armed || !S.detail || S.armed.wid !== S.wid) return;

    const openTs = S.armed.openTs || parseTs(S.detail.YYKSSJ);
    const closeTs = S.armed.closeTs || parseTs(S.detail.YYJSSJ);
    if (!openTs) return;
    const now = serverNow();

    if (closeTs && now >= closeTs) {
      setStatus('预约已截止', 'warn');
      return;
    }

    const startTs = grabStartTs(openTs);
    if (now >= startTs - 1500) {
      startGrab().catch((e) => {
        S.running = false;
        setStatus('抢票异常：' + e.message, 'err');
      });
      return;
    }

    const delay = Math.max(0, startTs - 1500 - now);
    S.timer = setTimeout(() => {
      schedule();
    }, Math.min(delay, 2147483000));
  }

  // ---------- 抢票主循环 ----------
  async function startGrab() {
    if (S.running) return;
    S.running = true;
    S.phase = 'grabbing';
    render();

    try {
      const claim = await chrome.runtime.sendMessage({ type: 'claimGrab' });
      if (!claim || !claim.ok) {
        S.running = false;
        S.phase = 'armed';
        setStatus('另一个标签页正在抢，本页待命');
        return;
      }

      chrome.runtime.sendMessage({ type: 'warmup' }).catch(() => {});
      const armed = S.armed;
      const wid = armed.wid;
      const openTs = armed.openTs;
      const closeTs = armed.closeTs || openTs + 3600 * 1000;
      const settings = await getSettings();
      const startTs = openTs + normalizeStartDelay(settings.startDelayMs);
      const retryDelayMs = normalizeRetryDelay(settings.retryDelayMs);
      const monitor = settings.monitorUntilClose;
      const hardEnd = monitor ? closeTs : Math.min(closeTs, openTs + HOT_WINDOW_MS);
      const stillArmed = () => S.armed && S.armed.wid === wid && S.wid === wid;
      const pause = async (ms) => {
        const end = Math.min(serverNow() + ms, hardEnd);
        while (stillArmed() && serverNow() < end) {
          await sleep(Math.min(end - serverNow(), 100));
        }
      };
      const waitRetry = (defaultMs) => pause(retryDelayMs === null ? defaultMs : retryDelayMs);

      // 先刷新一次，校准服务器时间 / 确认没被预约
      try {
        const h = await getDetail(wid);
        S.detail = h;
        if (h.YY_WID) {
          await onSuccess('已预约（之前已成功）');
          return;
        }
      } catch (_) { /* 用上次的 offset 继续 */ }

      setStatus('正在预取验证码…');
      let preCode = null;
      try {
        preCode = await fetchCode();
        setStatus(`验证码已就绪 ${preCode}`);
      } catch (e) {
        setStatus('预取验证码失败，将在开抢后重试', 'warn');
      }

      // 等到设定的提交时刻；取消锁定或离开本场时立即停止等待。
      while (serverNow() < startTs) {
        if (!S.armed || S.armed.wid !== wid || S.wid !== wid) return;
        if (serverNow() >= hardEnd) {
          await onFail('预约尝试时间已截止');
          return;
        }
        const remain = startTs - serverNow();
        if (remain > 0) await sleep(Math.min(remain, 100));
      }

      let attempts = 0;
      let lastMsg = '';
      let nextQuotaPoll = 0;
      setStatus('开抢！');

      while (true) {
        if (!S.armed || S.armed.wid !== wid || S.wid !== wid) {
          setStatus('锁定已被取消，停止抢票', 'warn');
          return;
        }
        const now = serverNow();
        if (now >= hardEnd) {
          await onFail('时间到，未抢到' + (lastMsg ? '：' + lastMsg : ''));
          return;
        }

        // 开放 5 秒后开始看余量，避免一直对满员场盲目提交
        const afterOpen = now - openTs;
        if (afterOpen > 5000 && now >= nextQuotaPoll) {
          nextQuotaPoll = now + 1200;
          try {
            const h = await getDetail(wid);
            S.detail = h;
            if (h.YY_WID) {
              await onSuccess('已约上');
              return;
            }
            const total = Number(h.HDZRS || 0);
            const used = Number(h.YYRS || 0);
            if (total > 0 && used >= total) {
              setStatus(`暂无余票 ${used}/${total}，继续盯回流…`, 'warn');
              await pause(1500);
              continue;
            }
            setStatus(`发现余票 ${used}/${total}，提交中…`, 'ok');
          } catch (_) { /* 继续尝试 */ }
        }

        let code = preCode;
        preCode = null;
        if (!code) {
          try {
            code = await fetchCode();
          } catch (e) {
            setStatus('验证码获取失败：' + e.message, 'warn');
            await waitRetry(300);
            continue;
          }
        }

        // 验证码和名额查询可能耗时较长，提交前再次检查取消及截止时间。
        if (!stillArmed() || serverNow() >= hardEnd) continue;
        attempts += 1;
        let r;
        try {
          r = await addReservation(wid, code);
        } catch (e) {
          lastMsg = e.message;
          setStatus(`第 ${attempts} 次：${lastMsg}`, 'err');
          await waitRetry(400);
          continue;
        }

        if (r && (r.code === 1 || Number(r.code) === 1)) {
          await onSuccess('预约成功');
          return;
        }

        lastMsg = (r && (r.msg || r.message)) || '未成功';
        setStatus(`第 ${attempts} 次：${lastMsg}`, 'warn');

        if (/验证码/.test(lastMsg)) {
          await waitRetry(60);
          continue;
        }
        if (/未开始|尚未开始|不在.*预约|预约时间/.test(lastMsg)) {
          await waitRetry(120);
          continue;
        }
        if (/已满|人数已满|名额|约满/.test(lastMsg)) {
          preCode = null;
          await waitRetry(800);
          continue;
        }
        if (/重复|已预约|已经预约/.test(lastMsg)) {
          // 可能上一次其实成功了，刷新确认
          try {
            const h = await getDetail(wid);
            S.detail = h;
            if (h.YY_WID) {
              await onSuccess('已约上');
              return;
            }
          } catch (_) {}
          await waitRetry(500);
          continue;
        }
        await waitRetry(300);
      }
    } finally {
      S.running = false;
      if (S.phase === 'grabbing') S.phase = 'armed';
      render();
    }
  }

  async function onSuccess(reason) {
    const wid = S.wid;
    S.phase = 'success';
    setStatus('🎉 ' + reason, 'ok');
    beep(1320, 160, 3);
    try {
      await chrome.storage.local.remove(['armed', 'grabLock']);
    } catch (_) {}
    S.armed = null;
    chrome.runtime.sendMessage({
      type: 'notify',
      title: '🎉 SEU 抢票成功',
      message: (S.detail && S.detail.JZMC) || '已预约成功',
    }).catch(() => {});
    try {
      if (S.detail) document.title = '✅ 已抢到 ' + (S.detail.JZMC || '');
    } catch (_) {}
    // 成功后刷新详情，让面板上的按钮也变成「已预约」（服务端可能稍晚一点才写入）
    if (wid && S.wid === wid) {
      for (let i = 0; i < 3; i++) {
        try {
          const h = await getDetail(wid);
          S.detail = h;
          if (h.YY_WID) break;
        } catch (_) {
          break;
        }
        await sleep(350);
      }
    }
    render();
  }

  async function onFail(reason) {
    S.phase = 'failed';
    setStatus('✗ ' + reason, 'err');
    beep(220, 300, 1);
    try {
      await chrome.storage.local.remove(['armed', 'grabLock']);
    } catch (_) {}
    S.armed = null;
    chrome.runtime.sendMessage({
      type: 'notify',
      title: 'SEU 抢票未成功',
      message: reason,
    }).catch(() => {});
    render();
  }

  // ---------- OCR 测试 ----------
  async function testOcr() {
    if (S.testBusy) return;
    S.testBusy = true;
    setStatus('正在获取验证码并识别…');
    try {
      chrome.runtime.sendMessage({ type: 'warmup' }).catch(() => {});
      const text = await fetchCode();
      if (/^\d{3,6}$/.test(text)) {
        setStatus('OCR 识别：' + text, 'ok');
      } else {
        setStatus('OCR 识别结果异常：' + (text || '(空)'), 'warn');
      }
    } finally {
      S.testBusy = false;
    }
  }

  // ---------- 页面状态轮询 ----------
  async function tick() {
    const wid = getWid();
    if (!wid) {
      S.wid = null;
      S.detail = null;
      if (S.host) S.host.style.display = 'none';
      return;
    }
    if (wid !== S.wid) {
      S.wid = wid;
      S.detail = null;
      S.phase = 'idle';
    }
    ensurePanel();
    if (S.host) S.host.style.display = '';
    try {
      S.detail = await getDetail(wid);
      const settings = await getSettings();
      S.startDelayMs = normalizeStartDelay(settings.startDelayMs);
      S.retryDelayMs = normalizeRetryDelay(settings.retryDelayMs);
      const st = await chrome.runtime.sendMessage({ type: 'getState' });
      S.armed = (st && st.armed) || null;
      S.isOwner = !!(st && st.isOwner);
      if (S.detail.YY_WID) {
        const h = S.detail;
        const wasArmed = !!(S.armed && S.armed.wid === wid);
        if (wasArmed) {
          await chrome.storage.local.remove(['armed', 'grabLock']);
          S.armed = null;
        }
        if (!S.status) setStatus('这场你已经预约过了', 'ok');
      }
      render();
      if (S.armed && S.armed.wid === wid && !S.running) schedule();
    } catch (e) {
      if (S.host) S.host.style.display = '';
      ensurePanel();
      setStatus('读取失败：' + e.message, 'err');
      if (S.detail) render();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      S.startDelayMs = normalizeStartDelay(changes.settings.newValue && changes.settings.newValue.startDelayMs);
      S.retryDelayMs = normalizeRetryDelay(changes.settings.newValue && changes.settings.newValue.retryDelayMs);
      render();
      schedule();
    }
    if (changes.armed) {
      S.armed = changes.armed.newValue || null;
      render();
      schedule();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'popupStatus') {
      sendResponse(snapshot());
      return false;
    }
    if (msg.type === 'popupAction') {
      (async () => {
        try {
          if (msg.action === 'arm') await doArm();
          else if (msg.action === 'disarm') await doDisarm();
          else if (msg.action === 'test') await testOcr();
          sendResponse({ ok: true, snapshot: snapshot() });
        } catch (e) {
          sendResponse({ ok: false, error: String(e), snapshot: snapshot() });
        }
      })();
      return true;
    }
    if (msg.type === 'preopen') {
      setStatus('还有 1 分钟开抢，保持页面在前台', 'warn');
      beep(880, 130, 2);
      warmupSoon();
      return false;
    }
    return false;
  });

  async function warmupSoon() {
    try {
      await chrome.runtime.sendMessage({ type: 'warmup' });
      setStatus('识别模型已就绪，等待开抢', 'ok');
    } catch (_) {}
  }

  function snapshot() {
    const currentArmed = S.armed && S.armed.wid === S.wid ? S.armed : null;
    const openTs = (currentArmed && currentArmed.openTs) || (S.detail && parseTs(S.detail.YYKSSJ));
    const closeTs = (currentArmed && currentArmed.closeTs) || (S.detail && parseTs(S.detail.YYJSSJ));
    return {
      wid: S.wid,
      title: (S.detail && S.detail.JZMC) || (currentArmed && currentArmed.title) || '',
      openTs,
      closeTs,
      armed: S.armed,
      isOwner: S.isOwner,
      running: S.running,
      phase: S.phase,
      status: S.status,
      statusKind: S.statusKind,
      booked: !!(S.detail && S.detail.YY_WID),
      total: S.detail ? Number(S.detail.HDZRS || 0) : 0,
      used: S.detail ? Number(S.detail.YYRS || 0) : 0,
      serverNow: serverNow(),
      startDelayMs: S.startDelayMs,
      retryDelayMs: S.retryDelayMs,
      startTs: openTs && grabStartTs(openTs),
    };
  }

  // 开抢前 1 分钟如果页面被切到后台，提醒一下（后台标签页定时器会被节流）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.armed && S.armed.openTs) {
      const remain = S.armed.openTs - serverNow();
      if (remain > 0 && remain < 90 * 1000) {
        chrome.runtime.sendMessage({
          type: 'notify',
          title: '⏰ 请保持抢票标签页在前台',
          message: '后台标签页的定时器会被浏览器节流，可能错过开抢。',
        }).catch(() => {});
      }
    }
  });

  setInterval(tickCountdown, 500);
  setInterval(tick, TICK_MS);
  window.addEventListener('hashchange', () => setTimeout(tick, 120));
  setTimeout(tick, 200);
})();
