export function formatSeconds(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export async function decodeAudioFileToPCM(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
    2, 44100 * 10, 44100
  );
  // Fallback to regular AudioContext decode if OfflineAudioContext not supported
  let decoded;
  try {
    decoded = await new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(arrayBuffer);
  } catch (e) {
    // Some browsers still require callback form
    decoded = await new Promise((res, rej) => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.decodeAudioData(arrayBuffer, res, rej);
    });
  }
  const channelData = decoded.getChannelData(0);
  return { pcm: new Float32Array(channelData), sampleRate: decoded.sampleRate };
}

export function resampleMonoPCM(sourcePCM, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) return sourcePCM;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(sourcePCM.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const v0 = sourcePCM[i0] || 0;
    const v1 = sourcePCM[i0 + 1] || v0;
    out[i] = v0 + (v1 - v0) * frac;
  }
  return out;
}

export function computeRMS(buffer, windowSize = 1024, hop = 512) {
  const rms = [];
  for (let i = 0; i + windowSize <= buffer.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const v = buffer[i + j];
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / windowSize));
  }
  return rms;
}

export function movingAverage(arr, k = 5) {
  const out = new Array(arr.length).fill(0);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= k) sum -= arr[i - k];
    out[i] = sum / Math.min(i + 1, k);
  }
  return out;
}

export function detectPeaks(arr, threshold, minDistance = 10) {
  const peaks = [];
  let lastIdx = -Infinity;
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] > threshold && arr[i] > arr[i - 1] && arr[i] >= arr[i + 1]) {
      if (i - lastIdx >= minDistance) {
        peaks.push(i);
        lastIdx = i;
      }
    }
  }
  return peaks;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function drawCaption(ctx, text, canvasWidth, canvasHeight, style) {
  const fontSize = style.fontSize || 28;
  const bgOpacity = style.bgOpacity ?? 0.4;
  ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const padding = Math.round(fontSize * 0.4);
  const lines = wrapText(ctx, text, canvasWidth * 0.8);
  const lineHeight = Math.round(fontSize * 1.2);
  const totalHeight = lines.length * lineHeight + padding * 2;
  const yBottom = canvasHeight - padding;
  const yTop = yBottom - totalHeight;
  // BG
  ctx.fillStyle = `rgba(0,0,0,${bgOpacity})`;
  ctx.fillRect(canvasWidth * 0.1, yTop, canvasWidth * 0.8, totalHeight);
  // Text
  ctx.fillStyle = '#fff';
  lines.forEach((line, idx) => {
    const y = yTop + padding + (idx + 1) * lineHeight;
    ctx.fillText(line, canvasWidth / 2, y);
  });
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    const w = ctx.measureText(test).width;
    if (w > maxWidth && line) {
      lines.push(line);
      line = words[i];
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

