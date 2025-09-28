// Client-side ASR via transformers.js + Xenova Whisper tiny.en
// This file lazy-loads the pipeline only if enabled.

let pipelinePromise = null;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@3.0.0');
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    })();
  }
  return pipelinePromise;
}

export async function runTranscriptionIfEnabled(audioPCM, sampleRate, onProgress) {
  if (!audioPCM || !audioPCM.length) return null;
  try {
    onProgress?.('Loading ASR model…');
    const asr = await getPipeline();
    onProgress?.('Transcribing…');
    // The interest curve is ~10Hz, not raw audio. For usable captions, we need raw audio.
    // If we only have the interest curve, skip. Analysis could be extended to keep raw PCM.
    if (sampleRate < 100) return null;
    const floatArr = audioPCM;
    const result = await asr(floatArr, { sampling_rate: sampleRate, return_timestamps: true });
    return result;
  } catch (e) {
    console.warn('ASR failed', e);
    return null;
  }
}

export async function transcribePCM(float32PCM, sampleRate, onProgress) {
  if (!float32PCM || !float32PCM.length) return null;
  try {
    onProgress?.('Loading ASR model…');
    const asr = await getPipeline();
    onProgress?.('Transcribing…');
    const result = await asr(float32PCM, {
      sampling_rate: sampleRate,
      return_timestamps: true,
      chunk_length_s: 30,
    });
    return result; // { text, chunks?: [{ text, timestamp: [start, end] }, ...] }
  } catch (e) {
    console.warn('ASR failed', e);
    return null;
  }
}

