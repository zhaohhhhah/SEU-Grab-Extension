'use strict';

// 本地 OCR：ddddocr 的识别模型（common_old.onnx）+ onnxruntime-web (wasm)。
// 预处理与 ddddocr 保持一致：按高 64 等比缩放 → 灰度 → (x/255 - 0.5)/0.5。
let initPromise = null;

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
    ort.env.wasm.numThreads = 1;
    const t0 = performance.now();
    const model = await fetch(chrome.runtime.getURL('model/common_old.onnx')).then((r) => r.arrayBuffer());
    const charset = await fetch(chrome.runtime.getURL('model/charset.json')).then((r) => r.json());
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    console.log(`[SEU OCR] model ready in ${Math.round(performance.now() - t0)}ms, charset=${charset.length}`);
    return { session, charset };
  })();
  try {
    return await initPromise;
  } catch (e) {
    initPromise = null; // 允许下次重试
    throw e;
  }
}

async function recognize(dataUrl) {
  const { session, charset } = await init();
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const h = 64;
  const w = Math.max(1, Math.round((bmp.width * h) / bmp.height));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);

  const rgba = ctx.getImageData(0, 0, w, h).data;
  const input = new Float32Array(h * w);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    // PIL Image.convert('L') 的亮度公式
    const g = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    input[j] = (g / 255 - 0.5) / 0.5;
  }

  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 1, h, w]);
  const out = await session.run(feeds);
  const tensor = out[session.outputNames[0]];
  const vals = Array.from(tensor.data, (x) => (typeof x === 'bigint' ? Number(x) : Number(x)));

  // CTC 贪心解码：去掉连续重复和 blank(0)
  let text = '';
  let last = 0;
  for (const it of vals) {
    if (it === last) continue;
    last = it;
    if (it !== 0) text += charset[it] || '';
  }
  bmp.close && bmp.close();
  return text;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  (async () => {
    try {
      if (msg.type === 'warmup') {
        await init();
        sendResponse({ ok: true });
      } else if (msg.type === 'ocr') {
        const text = await recognize(msg.dataUrl);
        sendResponse({ ok: true, text });
      } else {
        sendResponse({ ok: false, error: 'unknown offscreen message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();

  return true;
});
