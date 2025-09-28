import { decodeAudioFileToPCM, resampleMonoPCM, computeRMS, movingAverage, detectPeaks, clamp } from '/workspace/src/utils.js';

// Lightweight scene change via frame difference sampling and audio-driven interest scoring
export async function analyzeVideos(videoFiles, opts) {
  const { minLen, maxLen, maxClips, previewCanvas, onProgress } = opts;
  const tmpCanvas = document.createElement('canvas');
  const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });

  const perFileResults = [];
  let globalAudio = [];
  let sampleRate = 16000;

  for (let fileIndex = 0; fileIndex < videoFiles.length; fileIndex++) {
    const file = videoFiles[fileIndex];
    onProgress?.(`Decoding audio: ${file.name}`);
    // Decode audio to build an interest curve
    const { pcm, sampleRate: sr } = await decodeVideoAudioPCM(file);
    sampleRate = sr;
    const mono16 = resampleMonoPCM(pcm, sr, 16000);
    // Build RMS curve (hop ~ 0.1s)
    const rms = computeRMS(mono16, 1600, 1600);
    const smooth = movingAverage(rms, 5);
    globalAudio = globalAudio.concat(Array.from(smooth));

    onProgress?.(`Scanning frames: ${file.name}`);
    const scenes = await detectScenes(file, tmpCanvas, tmpCtx);
    perFileResults.push({ fileIndex, file, scenes, duration: scenes.duration });
  }

  // Interest threshold: top quantile
  const sorted = [...globalAudio].sort((a, b) => a - b);
  const q80 = sorted[Math.floor(sorted.length * 0.8)] || 0.01;
  const peaks = detectPeaks(globalAudio, q80, 3);

  // Map peaks to clips around local maxima, clamped to [minLen,maxLen]
  const clips = [];
  let accTime = 0; // seconds across concatenated videos using 0.1s hops
  const hopSec = 1600 / 16000; // 0.1s

  let videoOffsets = [];
  {
    let offset = 0;
    for (const res of perFileResults) {
      videoOffsets.push(offset);
      offset += res.duration;
    }
  }

  for (const pi of peaks) {
    const t = pi * hopSec;
    // Centered window
    const start = clamp(t - minLen / 2, 0, Infinity);
    const end = clamp(start + maxLen, 0, Infinity);
    // Slice to min..max depending on audio valley
    const clip = mapGlobalTimeToFileRange(start, end, perFileResults, videoOffsets);
    if (clip) clips.push(clip);
    if (clips.length >= maxClips) break;
  }

  // Deduplicate overlaps per file
  const deduped = dedupeClips(clips, 1.0);

  const audioPCM = new Float32Array(globalAudio);
  return { clips: deduped, audioPCM, sampleRate: 10 }; // interest curve is ~10Hz
}

function dedupeClips(clips, minGapSeconds) {
  // Sort by file then start
  clips.sort((a, b) => (a.fileIndex - b.fileIndex) || (a.start - b.start));
  const out = [];
  for (const c of clips) {
    const last = out[out.length - 1];
    if (!last || last.fileIndex !== c.fileIndex || c.start - last.end >= minGapSeconds) {
      out.push(c);
    } else {
      // merge
      last.end = Math.max(last.end, c.end);
    }
  }
  return out.map(c => ({ ...c, start: Math.max(0, c.start), end: Math.max(c.start + 0.5, c.end) }));
}

function mapGlobalTimeToFileRange(start, end, perFileResults, offsets) {
  for (let i = 0; i < perFileResults.length; i++) {
    const off = offsets[i];
    const dur = perFileResults[i].duration;
    if (start >= off && start < off + dur) {
      const localStart = start - off;
      const localEnd = Math.min(end - off, dur);
      return { fileIndex: i, start: localStart, end: localEnd };
    }
  }
  return null;
}

async function decodeVideoAudioPCM(file) {
  // Decode via HTMLMediaElement + OfflineAudioContext
  const url = URL.createObjectURL(file);
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const response = await fetch(url);
    const buf = await response.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(buf);
    const ch0 = decoded.getChannelData(0);
    return { pcm: new Float32Array(ch0), sampleRate: decoded.sampleRate };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function detectScenes(file, canvas, ctx) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.crossOrigin = 'anonymous';
  await video.play().catch(() => {});
  await new Promise(res => {
    if (video.readyState >= 2) res();
    else video.onloadeddata = () => res();
  });
  video.pause();

  const w = canvas.width = 320;
  const h = canvas.height = Math.max(180, Math.round((video.videoHeight / video.videoWidth) * w));
  let lastFrame = null;
  const cuts = [0];

  const sampleStep = Math.max(1, Math.floor(video.duration / 120)); // up to ~120 samples
  for (let t = 0; t < video.duration; t += sampleStep) {
    video.currentTime = t;
    await new Promise(r => video.onseeked = () => r());
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    if (lastFrame) {
      let diff = 0;
      for (let i = 0; i < data.length; i += 4) {
        const dr = data[i] - lastFrame[i];
        const dg = data[i + 1] - lastFrame[i + 1];
        const db = data[i + 2] - lastFrame[i + 2];
        diff += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
      }
      const norm = diff / (w * h * 3 * 255);
      if (norm > 0.12) cuts.push(t);
    }
    lastFrame = data;
  }
  cuts.push(video.duration);
  URL.revokeObjectURL(url);
  return { cuts, duration: video.duration };
}

