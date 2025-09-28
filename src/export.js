import { drawCaption } from '/workspace/src/utils.js';
import { transcribePCM } from '/workspace/src/asr.js';

export async function exportCompilation({
  videoFiles,
  clips,
  aspect,
  captionStyle,
  transcription,
  musicFile,
  musicGain,
  previewCanvas,
  onProgress,
  wantAsr,
}) {
  onProgress?.('Loading clips…');

  const canvas = previewCanvas;
  const ctx = canvas.getContext('2d');

  const map = { '16:9': 16/9, '9:16': 9/16, '1:1': 1 };
  const ratio = map[aspect] || (16/9);
  const width = 1280;
  const height = Math.round(width / ratio);
  canvas.width = width;
  canvas.height = height;

  // MediaRecorder from canvas + audio graph
  const videoStream = canvas.captureStream(30);

  // Prepare audio graph and optionally ASR
  const { destination, durationSec } = await prepareAudioGraph({ videoFiles, clips, musicFile, musicGain, onProgress });
  const combinedStream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);

  // Optional ASR: decode audio of selected clips and transcribe
  let captionSegments = null;
  if (wantAsr && !transcription) {
    try {
      onProgress?.('Preparing audio for ASR…');
      const { pcm, sampleRate } = await decodeClipsAudioToPCM({ videoFiles, clips, onProgress });
      const asrResult = await transcribePCM(pcm, sampleRate, onProgress);
      captionSegments = extractSegments(asrResult);
    } catch (e) {
      console.warn('ASR pipeline failed; continuing without captions', e);
    }
  } else if (transcription) {
    captionSegments = extractSegments(transcription);
  }
  const chunks = [];
  const recorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm;codecs=vp9,opus' });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const complete = new Promise(res => { recorder.onstop = () => res(); });
  recorder.start();

  // Render timeline: draw each clip sequentially
  let currentTime = 0;
  for (let i = 0, exportOffset = 0; i < clips.length; i++) {
    const c = clips[i];
    onProgress?.(`Rendering clip ${i + 1}/${clips.length}`);
    await renderClipToCanvas({ ctx, canvas, clip: c, file: videoFiles[c.fileIndex], aspect, captionStyle, captionSegments, exportOffset });
    const dur = (c.end - c.start);
    currentTime += dur;
    exportOffset += dur;
  }

  onProgress?.('Finalizing…');
  recorder.stop();
  await complete;

  const webm = new Blob(chunks, { type: 'video/webm' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(webm);
  a.download = 'compilation.webm';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function renderClipToCanvas({ ctx, canvas, clip, file, aspect, captionStyle, captionSegments, exportOffset }) {
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
  video.currentTime = clip.start;

  const { width, height } = canvas;

  return new Promise(resolve => {
    const start = clip.start;
    const end = clip.end;
    let segIdx = 0;
    function draw() {
      if (video.currentTime >= end) {
        resolve();
        return;
      }
      // draw frame cover-fit
      const { sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight } = computeCoverRect(
        video.videoWidth, video.videoHeight, width, height
      );
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(video, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);

      // captions: show active segment text based on export time
      if (captionSegments && captionSegments.length) {
        const tExport = exportOffset + (video.currentTime - start);
        // advance segIdx to the current segment
        while (segIdx < captionSegments.length && captionSegments[segIdx].end < tExport) segIdx++;
        const seg = captionSegments[segIdx];
        if (seg && seg.start <= tExport && tExport <= seg.end) {
          drawCaption(ctx, seg.text, width, height, captionStyle);
        }
      }
      requestAnimationFrame(draw);
    }
    video.muted = true; // we will use mixed audio track instead
    video.currentTime = start;
    video.play();
    draw();
  }).finally(() => URL.revokeObjectURL(url));
}

function computeCoverRect(srcW, srcH, dstW, dstH) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  let sWidth = srcW, sHeight = srcH;
  if (srcAspect > dstAspect) {
    sWidth = srcH * dstAspect;
  } else {
    sHeight = srcW / dstAspect;
  }
  const sx = (srcW - sWidth) / 2;
  const sy = (srcH - sHeight) / 2;
  return { sx, sy, sWidth, sHeight, dx: 0, dy: 0, dWidth: dstW, dHeight: dstH };
}

async function prepareAudioGraph({ videoFiles, clips, musicFile, musicGain, onProgress }) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const destination = audioCtx.createMediaStreamDestination();

  // Speech-aware ducking placeholder (future: actual VAD/energy-based)
  const speechGain = audioCtx.createGain();
  speechGain.gain.value = 1.0;

  // Music
  let musicSource = null;
  if (musicFile) {
    onProgress?.('Loading music…');
    const musicArray = await musicFile.arrayBuffer();
    const musicBuf = await audioCtx.decodeAudioData(musicArray);
    musicSource = audioCtx.createBufferSource();
    musicSource.buffer = musicBuf;
    const musicGainNode = audioCtx.createGain();
    musicGainNode.gain.value = musicGain;
    musicSource.connect(musicGainNode).connect(destination);
    musicSource.start();
  }

  const durationSec = clips.reduce((acc, c) => acc + (c.end - c.start), 0);
  return { destination, durationSec };
}

async function decodeClipsAudioToPCM({ videoFiles, clips, onProgress }) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const sampleRate = 16000; // target
  const chunks = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const f = videoFiles[c.fileIndex];
    onProgress?.(`Decoding audio ${i + 1}/${clips.length}`);
    const url = URL.createObjectURL(f);
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    URL.revokeObjectURL(url);
    const decoded = await audioCtx.decodeAudioData(buf);
    const ch0 = decoded.getChannelData(0);
    const startIdx = Math.floor(c.start * decoded.sampleRate);
    const endIdx = Math.min(ch0.length, Math.floor(c.end * decoded.sampleRate));
    const slice = ch0.subarray(startIdx, endIdx);
    // simple resample to 16k
    const ratio = decoded.sampleRate / sampleRate;
    const outLen = Math.floor(slice.length / ratio);
    const out = new Float32Array(outLen);
    for (let j = 0; j < outLen; j++) {
      const idx = j * ratio;
      const i0 = Math.floor(idx);
      const frac = idx - i0;
      const v0 = slice[i0] || 0;
      const v1 = slice[i0 + 1] || v0;
      out[j] = v0 + (v1 - v0) * frac;
    }
    chunks.push(out);
  }
  const total = chunks.reduce((acc, a) => acc + a.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const arr of chunks) { pcm.set(arr, off); off += arr.length; }
  return { pcm, sampleRate };
}

function extractSegments(asrResult) {
  if (!asrResult) return null;
  const segs = [];
  const chunks = asrResult.chunks || asrResult.segments || [];
  for (const ch of chunks) {
    const ts = ch.timestamp || ch.time || ch.timestart ? [ch.timestart, ch.timeend] : ch.timestamp;
    const start = Array.isArray(ts) ? (ts[0] ?? 0) : (ch.start ?? 0);
    const end = Array.isArray(ts) ? (ts[1] ?? 0) : (ch.end ?? 0);
    segs.push({ start: Math.max(0, start), end: Math.max(start, end), text: ch.text || ch.chunk || ch.raw_text || '' });
  }
  if (!segs.length && asrResult.text) {
    segs.push({ start: 0, end: Number.MAX_SAFE_INTEGER / 1000, text: asrResult.text });
  }
  return segs;
}

