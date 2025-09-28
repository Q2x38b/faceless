import { analyzeVideos } from 'analysis.js';
import { runTranscriptionIfEnabled } from 'asr.js';
import { exportCompilation } from 'export.js';
import { formatSeconds } from 'utils.js';

const state = {
  videoFiles: [],
  musicFile: null,
  suggestedClips: [],
  transcription: null,
  aspect: '16:9',
  showSafeGuides: true,
  minLen: 6,
  maxLen: 20,
  maxClips: 8,
  captionStyle: { fontSize: 28, bgOpacity: 0.4 },
};

const els = {
  videoInput: document.getElementById('video-input'),
  videoList: document.getElementById('video-list'),
  musicInput: document.getElementById('music-input'),
  musicGain: document.getElementById('music-gain'),
  minLen: document.getElementById('min-len'),
  maxLen: document.getElementById('max-len'),
  numClips: document.getElementById('num-clips'),
  aspect: document.getElementById('aspect'),
  showSafe: document.getElementById('show-safe'),
  captionSize: document.getElementById('caption-size'),
  captionBg: document.getElementById('caption-bg'),
  enableAsr: document.getElementById('enable-asr'),
  analyzeBtn: document.getElementById('analyze-btn'),
  exportBtn: document.getElementById('export-btn'),
  previewCanvas: document.getElementById('preview-canvas'),
  clipList: document.getElementById('clip-list'),
  progress: document.getElementById('progress'),
  status: document.getElementById('status'),
};

function setStatus(text) {
  els.status.textContent = text;
}

function setProgress(text) {
  els.progress.textContent = text;
}

function refreshVideoList() {
  if (!state.videoFiles.length) {
    els.videoList.innerHTML = '<div>No videos selected</div>';
    return;
  }
  els.videoList.innerHTML = '';
  state.videoFiles.forEach((f, i) => {
    const div = document.createElement('div');
    div.textContent = `${i + 1}. ${f.name} (${Math.round(f.size / 1024 / 1024)} MB)`;
    els.videoList.appendChild(div);
  });
}

function refreshClips() {
  els.clipList.innerHTML = '';
  if (!state.suggestedClips.length) {
    els.clipList.innerHTML = '<div class="chip">Run Analyze to get suggestions.</div>';
    els.exportBtn.disabled = true;
    return;
  }
  els.exportBtn.disabled = false;
  state.suggestedClips.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'clip';
    const idxDiv = document.createElement('div');
    idxDiv.className = 'chip';
    idxDiv.textContent = `#${idx + 1}`;

    const ctxDiv = document.createElement('div');
    ctxDiv.className = 'clip-ctx';
    const name = state.videoFiles[c.fileIndex]?.name || 'video';
    ctxDiv.textContent = `${name}  ${formatSeconds(c.start)} → ${formatSeconds(c.end)}  (${formatSeconds(c.end - c.start)})`;

    const actions = document.createElement('div');
    actions.className = 'clip-actions';
    const previewBtn = document.createElement('button');
    previewBtn.textContent = 'Preview';
    previewBtn.onclick = () => previewClip(c);
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => {
      state.suggestedClips.splice(idx, 1);
      refreshClips();
    };
    actions.appendChild(previewBtn);
    actions.appendChild(removeBtn);

    row.appendChild(idxDiv);
    row.appendChild(ctxDiv);
    row.appendChild(actions);
    els.clipList.appendChild(row);
  });
}

async function previewClip(clip) {
  setStatus('Previewing clip…');
  await renderPreviewForClip(clip);
  setStatus('Idle');
}

async function renderPreviewForClip(clip) {
  const file = state.videoFiles[clip.fileIndex];
  if (!file) return;
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

  const canvas = els.previewCanvas;
  const ctx = canvas.getContext('2d');
  const { width, height } = getTargetDimensions(video.videoWidth, video.videoHeight, state.aspect);
  canvas.width = width;
  canvas.height = height;
  canvas.classList.toggle('safe-guides', state.showSafeGuides);

  const start = clip.start;
  const end = clip.end;

  return new Promise(resolve => {
    function draw() {
      if (video.currentTime >= end) {
        resolve();
        return;
      }
      drawVideoToCanvas(ctx, video, width, height, state.aspect);
      requestAnimationFrame(draw);
    }
    video.playbackRate = 1;
    video.muted = true;
    video.currentTime = start;
    video.play();
    draw();
  }).finally(() => {
    URL.revokeObjectURL(url);
  });
}

function drawVideoToCanvas(ctx, video, targetW, targetH, aspect) {
  ctx.clearRect(0, 0, targetW, targetH);
  const { sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight } = computeCoverRect(
    video.videoWidth, video.videoHeight, targetW, targetH
  );
  ctx.drawImage(video, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
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

function getTargetDimensions(srcW, srcH, aspect) {
  const map = { '16:9': 16/9, '9:16': 9/16, '1:1': 1 };
  const ratio = map[aspect] || (16/9);
  let width = 960;
  let height = Math.round(width / ratio);
  return { width, height };
}

// Event wiring
els.videoInput.addEventListener('change', () => {
  state.videoFiles = Array.from(els.videoInput.files || []);
  refreshVideoList();
});

els.musicInput.addEventListener('change', () => {
  state.musicFile = els.musicInput.files?.[0] || null;
});

els.musicGain.addEventListener('input', () => {
  // handled during export
});

els.minLen.addEventListener('input', () => {
  state.minLen = Number(els.minLen.value);
});
els.maxLen.addEventListener('input', () => {
  state.maxLen = Number(els.maxLen.value);
});
els.numClips.addEventListener('input', () => {
  state.maxClips = Number(els.numClips.value);
});
els.aspect.addEventListener('change', () => {
  state.aspect = els.aspect.value;
});
els.showSafe.addEventListener('change', () => {
  state.showSafeGuides = els.showSafe.checked;
  els.previewCanvas.classList.toggle('safe-guides', state.showSafeGuides);
});
els.captionSize.addEventListener('input', () => {
  state.captionStyle.fontSize = Number(els.captionSize.value);
});
els.captionBg.addEventListener('input', () => {
  state.captionStyle.bgOpacity = Number(els.captionBg.value);
});

els.analyzeBtn.addEventListener('click', async () => {
  if (!state.videoFiles.length) {
    alert('Please upload at least one video.');
    return;
  }
  els.analyzeBtn.disabled = true;
  setStatus('Analyzing…');
  setProgress('Preparing…');
  try {
    const opts = {
      minLen: state.minLen,
      maxLen: state.maxLen,
      maxClips: state.maxClips,
      previewCanvas: els.previewCanvas,
      onProgress: setProgress,
    };
    const analysis = await analyzeVideos(state.videoFiles, opts);
    state.suggestedClips = analysis.clips;
    refreshClips();

    if (els.enableAsr.checked) {
      setProgress('Transcribing…');
      state.transcription = await runTranscriptionIfEnabled(analysis.audioPCM, analysis.sampleRate, setProgress);
    }
    setProgress('Done');
  } catch (err) {
    console.error(err);
    alert('Analysis failed: ' + (err?.message || err));
  } finally {
    els.analyzeBtn.disabled = false;
    setStatus('Idle');
  }
});

els.exportBtn.addEventListener('click', async () => {
  if (!state.suggestedClips.length) return;
  els.exportBtn.disabled = true;
  setStatus('Exporting…');
  setProgress('Initializing…');
  try {
    await exportCompilation({
      videoFiles: state.videoFiles,
      clips: state.suggestedClips,
      aspect: state.aspect,
      captionStyle: state.captionStyle,
      transcription: state.transcription,
      musicFile: state.musicFile,
      musicGain: Number(els.musicGain.value),
      previewCanvas: els.previewCanvas,
      onProgress: setProgress,
        wantAsr: els.enableAsr.checked,
    });
  } catch (err) {
    console.error(err);
    alert('Export failed: ' + (err?.message || err));
  } finally {
    els.exportBtn.disabled = false;
    setStatus('Idle');
  }
});

refreshVideoList();
refreshClips();

