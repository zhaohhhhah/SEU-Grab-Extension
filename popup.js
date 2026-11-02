'use strict';

const $ = (id) => document.getElementById(id);
let tabId = null;
let timer = null;
let snap = null;
let monitor = true;
let startDelayMs = 0;
let retryDelayMs = null;

function normalizeStartDelay(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 60000 ? n : 0;
}

function normalizeRetryDelay(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 60000 ? n : null;
}

function fmtCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function render(s) {
  snap = s;
  $('startDelay').disabled = !!(s && s.running);
  $('retryDelay').disabled = !!(s && s.running);
  $('saveDelay').disabled = !!(s && s.running);
  const box = $('content');
  if (!s) {
    box.className = 'tip';
    box.innerHTML = '请先打开东南大学素质讲座的<strong>详情页</strong>，再点工具栏图标。';
    $('monitorRow').style.display = 'none';
    return;
  }
  if (!s.wid) {
    box.className = 'tip';
    box.innerHTML = '当前不是讲座详情页。<br>请从活动列表点进某场讲座的详情页。';
    $('monitorRow').style.display = 'none';
    return;
  }

  const armed = !!(s.armed && s.armed.wid === s.wid);
  const booked = !!s.booked;
  const openTs = s.openTs || (s.armed && s.armed.openTs);
  const startTs = s.startTs || (openTs && openTs + startDelayMs);
  const now = (s.serverNow || Date.now());

  let cd = '--';
  let cdCls = 'cd';
  if (booked) { cd = '✓ 已预约'; }
  else if (s.phase === 'success') { cd = '🎉 抢票成功'; }
  else if (s.phase === 'failed') { cd = '✗ 未抢到'; cdCls = 'cd err'; }
  else if (armed && startTs && now < startTs) { cd = (now >= openTs ? '延迟等待 ' : '') + fmtCountdown(startTs - now); }
  else if (s.running) { cd = '抢票中…'; cdCls = 'cd warn'; }
  else if (armed) { cd = '已开抢 · 盯回流'; cdCls = 'cd warn'; }

  const status = s.status || '';
  const stCls = s.statusKind ? 'st ' + s.statusKind : 'st';

  box.className = '';
  box.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = s.title || (s.armed && s.armed.title) || '讲座';
  box.appendChild(title);

  if (s.total || s.used) {
    const m = document.createElement('div');
    m.className = 'muted';
    m.textContent = `名额 ${s.used || 0} / ${s.total || 0}`;
    box.appendChild(m);
  }

  const cdEl = document.createElement('div');
  cdEl.className = cdCls;
  cdEl.textContent = cd;
  box.appendChild(cdEl);

  const stEl = document.createElement('div');
  stEl.className = stCls;
  stEl.textContent = status;
  box.appendChild(stEl);

  const row = document.createElement('div');
  row.className = 'row';

  const armBtn = document.createElement('button');
  if (booked) {
    armBtn.className = 'primary';
    armBtn.textContent = '已预约';
    armBtn.disabled = true;
  } else if (armed) {
    armBtn.className = 'danger';
    armBtn.textContent = '取消锁定';
    armBtn.disabled = false;
    armBtn.onclick = () => act('disarm');
  } else {
    armBtn.className = 'primary';
    armBtn.textContent = '锁定本场';
    armBtn.disabled = false;
    armBtn.onclick = () => act('arm');
  }
  row.appendChild(armBtn);

  const testBtn = document.createElement('button');
  testBtn.className = 'ghost';
  testBtn.textContent = '测试 OCR';
  testBtn.disabled = !!(s.running);
  testBtn.onclick = () => act('test');
  row.appendChild(testBtn);
  box.appendChild(row);

  if (s.phase === 'success') {
    const hint = document.createElement('div');
    hint.className = 'foot';
    hint.textContent = '预约已提交成功，请到「我的活动」查看入场券。';
    box.appendChild(hint);
  }

  $('monitorRow').style.display = '';
  $('monitor').checked = !!monitor;
}

async function refresh() {
  if (tabId === null) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tabs && tabs[0] ? tabs[0].id : null;
    } catch (_) { tabId = null; }
  }
  if (tabId === null) { render(null); return; }
  let s = null;
  try {
    s = await chrome.tabs.sendMessage(tabId, { type: 'popupStatus' });
  } catch (_) { s = null; }
  render(s);
}

async function act(action) {
  if (tabId === null) return;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'popupAction', action });
    if (r && r.snapshot) render(r.snapshot);
    else if (r && !r.ok) alert(r.error || '操作失败');
  } catch (e) {
    alert('无法连接到页面，请刷新详情页后重试');
  }
}

async function loadSettings() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    monitor = !settings || settings.monitorUntilClose !== false;
    startDelayMs = normalizeStartDelay(settings && settings.startDelayMs);
    retryDelayMs = normalizeRetryDelay(settings && settings.retryDelayMs);
  } catch (_) { monitor = true; }
  $('startDelay').value = startDelayMs / 1000;
  $('retryDelay').value = retryDelayMs === null ? '' : retryDelayMs / 1000;
}

$('saveDelay').addEventListener('click', async () => {
  if (snap && snap.running) return;
  const input = $('startDelay');
  const retryInput = $('retryDelay');
  if (input.value.trim() === '' || !input.reportValidity()) return;
  if (!retryInput.reportValidity()) return;
  const value = Math.round(Number(input.value) * 1000);
  const retryValue = retryInput.value.trim() === '' ? null : Math.round(Number(retryInput.value) * 1000);
  if (!Number.isInteger(value) || value < 0 || value > 60000) return;
  if (retryValue !== null && (!Number.isInteger(retryValue) || retryValue < 0 || retryValue > 60000)) return;
  const status = $('delayStatus');
  try {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, startDelayMs: value, retryDelayMs: retryValue } });
    startDelayMs = value;
    retryDelayMs = retryValue;
    delete input.dataset.dirty;
    delete retryInput.dataset.dirty;
    status.textContent = `已保存：开抢延迟 ${value / 1000} 秒，重试间隔${retryValue === null ? '自动' : ' ' + retryValue / 1000 + ' 秒'}`;
    status.className = 'st ok';
    await refresh();
  } catch (_) {
    status.textContent = '保存失败，请重试';
    status.className = 'st err';
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const settings = changes.settings.newValue || {};
  monitor = settings.monitorUntilClose !== false;
  startDelayMs = normalizeStartDelay(settings.startDelayMs);
  retryDelayMs = normalizeRetryDelay(settings.retryDelayMs);
  if (document.activeElement !== $('startDelay') && !$('startDelay').dataset.dirty) $('startDelay').value = startDelayMs / 1000;
  if (document.activeElement !== $('retryDelay') && !$('retryDelay').dataset.dirty) $('retryDelay').value = retryDelayMs === null ? '' : retryDelayMs / 1000;
  $('monitor').checked = monitor;
});

for (const id of ['startDelay', 'retryDelay']) {
  $(id).addEventListener('input', () => { $(id).dataset.dirty = 'true'; });
}

$('monitor').addEventListener('change', async (e) => {
  monitor = e.target.checked;
  try {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: Object.assign({}, settings || {}, { monitorUntilClose: monitor }),
    });
  } catch (_) {}
});

(async () => {
  await loadSettings();
  await refresh();
  timer = setInterval(refresh, 1000);
  window.addEventListener('unload', () => clearInterval(timer));
})();
