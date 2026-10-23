'use strict';

const $ = (id) => document.getElementById(id);
let tabId = null;
let timer = null;
let snap = null;
let monitor = true;

function fmtCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function render(s) {
  snap = s;
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
  const now = (s.serverNow || Date.now());

  let cd = '--';
  let cdCls = 'cd';
  if (booked) { cd = '✓ 已预约'; }
  else if (s.phase === 'success') { cd = '🎉 抢票成功'; }
  else if (s.phase === 'failed') { cd = '✗ 未抢到'; cdCls = 'cd err'; }
  else if (s.running) { cd = '抢票中…'; cdCls = 'cd warn'; }
  else if (armed && openTs && now < openTs) { cd = fmtCountdown(openTs - now); }
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
  } catch (_) { monitor = true; }
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
