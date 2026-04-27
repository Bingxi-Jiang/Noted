from .config import APP_TITLE, CHUNK_MS

HTML_PAGE = rf"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{APP_TITLE}</title>
  <style>
    * {{ box-sizing: border-box; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1300px; margin: 24px auto; padding: 0 16px; line-height: 1.5; color: #1a1a1a; }}
    h1 {{ margin-bottom: 4px; }}
    h3 {{ margin: 20px 0 8px; color: #333; }}
    .row {{ display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 12px 0; }}
    button, textarea, select {{ font-size: 14px; }}
    button {{ padding: 10px 14px; cursor: pointer; border-radius: 6px; border: 1px solid #ccc; background: #fff; transition: background 0.15s; }}
    button:hover:not(:disabled) {{ background: #f0f0f0; }}
    button:disabled {{ opacity: 0.5; cursor: not-allowed; }}
    textarea {{ width: 100%; min-height: 90px; border-radius: 8px; border: 1px solid #ccc; padding: 10px; }}
    .pill {{ display: inline-block; background: #eef; padding: 4px 10px; border-radius: 999px; font-size: 13px; }}
    .muted {{ color: #666; font-size: 13px; }}

    /* ---- Dual transcript panels ---- */
    .transcript-grid {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin: 12px 0;
    }}
    @media (max-width: 780px) {{
      .transcript-grid {{ grid-template-columns: 1fr; }}
    }}
    .panel {{
      border: 1px solid #ddd;
      border-radius: 10px;
      background: #fafafa;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }}
    .panel-header {{
      padding: 10px 14px;
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid #eee;
    }}
    .panel-header .dot {{
      width: 8px; height: 8px; border-radius: 50%; display: inline-block;
    }}
    .panel-live .panel-header {{ background: #f0fdf4; }}
    .panel-live .panel-header .dot {{ background: #22c55e; }}
    .panel-db .panel-header {{ background: #eff6ff; }}
    .panel-db .panel-header .dot {{ background: #3b82f6; }}
    .panel-body {{
      padding: 12px 14px;
      white-space: pre-wrap;
      font-size: 13px;
      line-height: 1.65;
      max-height: 420px;
      overflow-y: auto;
      flex: 1;
    }}
    .panel-body .chunk-line {{
      margin-bottom: 6px;
      padding: 4px 0;
    }}
    .panel-body .chunk-idx {{
      color: #999;
      font-size: 11px;
      font-family: monospace;
      margin-right: 6px;
    }}
    .panel-body .pending-line {{
      color: #b45309;
      font-style: italic;
    }}
    .panel-body .filtered-line {{
      color: #9ca3af;
      font-style: italic;
      font-size: 12px;
    }}

    #log, #answer, #summaries {{
      border: 1px solid #ddd;
      padding: 12px;
      border-radius: 8px;
      background: #fafafa;
      white-space: pre-wrap;
      font-size: 13px;
    }}
    #log {{ max-height: 250px; overflow-y: auto; font-family: monospace; font-size: 12px; }}
    .counter {{ font-size: 12px; color: #888; margin-left: auto; }}
  </style>
</head>
<body>
  <h1>{APP_TITLE}</h1>
  <div class="muted">PCM capture → WAV chunk upload → transcript storage → rolling summaries → session QA</div>

  <div class="row">
    <button id="newSessionBtn">New Session</button>
    <span>Session: <span class="pill" id="sessionId">(none)</span></span>
    <span>Lang: <span class="pill" id="languageMode">force:en</span></span>
  </div>

  <div class="muted" id="storageInfo">Storage: pending</div>
  <div class="row">
    <label for="captureMode">Capture source</label>
    <select id="captureMode" style="border-radius:6px;border:1px solid #ccc;padding:6px 10px;">
      <option value="mic">1. Microphone</option>
      <option value="system">2. System audio</option>
      <option value="both">3. Both</option>
    </select>
    <span class="muted">System audio uses screen/tab capture.</span>
  </div>

  <div class="row">
    <button id="startBtn" disabled>Start Recording</button>
    <button id="stopBtn" disabled>Stop Recording</button>
    <span id="recordingState" class="muted">Idle</span>
  </div>

  <!-- ========== DUAL DISPLAY ========== -->
  <div class="transcript-grid">
    <div class="panel panel-live">
      <div class="panel-header">
        <span class="dot"></span>
        Live Transcript (raw, real-time)
        <span class="counter" id="liveCount">0 chunks</span>
      </div>
      <div class="panel-body" id="liveTranscript">Waiting for audio...</div>
    </div>
    <div class="panel panel-db">
      <div class="panel-header">
        <span class="dot"></span>
        DB Transcript (finalized sentences)
        <span class="counter" id="dbCount">0 chunks</span>
      </div>
      <div class="panel-body" id="dbTranscript">No finalized transcript yet.</div>
    </div>
  </div>

  <h3>Rolling Summaries</h3>
  <div id="summaries">No summaries yet.</div>

  <h3>Ask</h3>
  <textarea id="question" placeholder="Ask something about this session..."></textarea>
  <div class="row">
    <button id="askBtn" disabled>Ask</button>
  </div>

  <h3>Answer</h3>
  <div id="answer">No answer yet.</div>

  <h3>Log</h3>
  <div id="log">Ready.</div>

<script>
let currentSessionId = null;
let isRecording = false;

// ---- Dual data stores ----
let liveItems = [];       // Every raw transcription result (for live panel)
let dbItems = [];          // Only finalized, stored-to-DB items
let pendingText = '';      // Current pending fragment
let summaryItems = [];

const CHUNK_MS = {CHUNK_MS};

let captureStream = null;
let audioContext = null;
let processorNode = null;
let destinationNode = null;
let sourceNodes = [];
let flushTimer = null;

let pcmChunks = [];
let currentChunkSampleCount = 0;
let currentChunkStartedAt = null;
let uploadCount = 0;
let pendingStepSampleCount = 0;
const OVERLAP_MS = Math.min(1200, Math.max(600, Math.floor(CHUNK_MS * 0.15)));
const STEP_MS = Math.max(1000, CHUNK_MS - OVERLAP_MS);

const sessionIdEl = document.getElementById('sessionId');
const languageModeEl = document.getElementById('languageMode');
const recordingStateEl = document.getElementById('recordingState');
const liveTranscriptEl = document.getElementById('liveTranscript');
const dbTranscriptEl = document.getElementById('dbTranscript');
const liveCountEl = document.getElementById('liveCount');
const dbCountEl = document.getElementById('dbCount');
const summariesEl = document.getElementById('summaries');
const answerEl = document.getElementById('answer');
const logEl = document.getElementById('log');
const questionEl = document.getElementById('question');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const askBtn = document.getElementById('askBtn');
const storageInfoEl = document.getElementById('storageInfo');
const captureModeEl = document.getElementById('captureMode');

function log(msg) {{
  const now = new Date().toLocaleTimeString();
  logEl.textContent = `[${{now}}] ${{msg}}\n` + logEl.textContent;
}}

// ---- RENDER: Live panel (shows every raw chunk + pending) ----
function renderLiveTranscript() {{
  if (!liveItems.length && !pendingText) {{
    liveTranscriptEl.innerHTML = 'Waiting for audio...';
    liveCountEl.textContent = '0 chunks';
    return;
  }}
  let html = '';
  liveItems.forEach((item, i) => {{
    const cls = item.filtered ? 'chunk-line filtered-line' : 'chunk-line';
    const label = item.filtered ? `<span class="chunk-idx">[#${{i}} filtered:${{item.reason || '?'}}]</span>` : `<span class="chunk-idx">[#${{i}}]</span>`;
    html += `<div class="${{cls}}">${{label}} ${{escapeHtml(item.text)}}</div>`;
  }});
  if (pendingText) {{
    html += `<div class="chunk-line pending-line"><span class="chunk-idx">[pending]</span> ${{escapeHtml(pendingText)}}</div>`;
  }}
  liveTranscriptEl.innerHTML = html;
  liveCountEl.textContent = `${{liveItems.length}} chunks`;
  // Auto-scroll to bottom
  liveTranscriptEl.scrollTop = liveTranscriptEl.scrollHeight;
}}

// ---- RENDER: DB panel (only finalized, stored sentences) ----
function renderDbTranscript() {{
  if (!dbItems.length) {{
    dbTranscriptEl.innerHTML = 'No finalized transcript yet.';
    dbCountEl.textContent = '0 chunks';
    return;
  }}
  let html = '';
  dbItems.forEach(item => {{
    html += `<div class="chunk-line"><span class="chunk-idx">[chunk ${{item.chunk_index}}]</span> ${{escapeHtml(item.text)}}</div>`;
  }});
  dbTranscriptEl.innerHTML = html;
  dbCountEl.textContent = `${{dbItems.length}} sentences`;
  dbTranscriptEl.scrollTop = dbTranscriptEl.scrollHeight;
}}

function renderSummaries() {{
  summariesEl.textContent = summaryItems.length
    ? summaryItems.map(item => `[summary ${{item.summary_index}} | chunks ${{item.start_chunk_index}}-${{item.end_chunk_index}}] ${{item.text}}`).join('\n\n')
    : 'No summaries yet.';
}}

function escapeHtml(text) {{
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}}

async function createSession() {{
  const res = await fetch('/api/session/new', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify({{ title: null }})
  }});
  const data = await res.json();
  currentSessionId = data.session_id;
  sessionIdEl.textContent = currentSessionId;
  startBtn.disabled = false;
  askBtn.disabled = false;
  liveItems = [];
  dbItems = [];
  pendingText = '';
  summaryItems = [];
  renderLiveTranscript();
  renderDbTranscript();
  renderSummaries();
  answerEl.textContent = 'No answer yet.';
  storageInfoEl.textContent = 'Storage folder: ./voice_rag_data';
  log(`Created session ${{currentSessionId}}`);
}}

async function getMicStream() {{
  return navigator.mediaDevices.getUserMedia({{
    audio: {{
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }}
  }});
}}

async function getSystemStream() {{
  const displayStream = await navigator.mediaDevices.getDisplayMedia({{
    video: true,
    audio: true,
  }});
  const audioTracks = displayStream.getAudioTracks();
  if (!audioTracks.length) {{
    displayStream._childStreams = [];
    return displayStream;
  }}
  const audioOnlyStream = new MediaStream(audioTracks);
  audioOnlyStream._childStreams = [displayStream];
  return audioOnlyStream;
}}

function stopStream(stream) {{
  if (!stream) return;
  stream.getTracks().forEach(track => track.stop());
  if (stream._childStreams) stream._childStreams.forEach(stopStream);
}}

function logTrackInfo(stream, label) {{
  const tracks = stream.getTracks().map(t => ({{
    kind: t.kind,
    label: t.label,
    enabled: t.enabled,
    muted: t.muted,
    readyState: t.readyState
  }}));
  log(`${{label}} tracks: ${{JSON.stringify(tracks)}}`);
}}

function buildMixedAudioGraph(inputStreams) {{
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx({{ sampleRate: 16000 }});
  const destination = ctx.createMediaStreamDestination();
  const sources = [];
  for (const stream of inputStreams) {{
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) continue;
    const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    source.connect(destination);
    sources.push(source);
  }}
  return {{ ctx, destination, sources }};
}}

async function createCaptureSetup(mode) {{
  if (mode === 'mic') {{
    const mic = await getMicStream();
    const graph = buildMixedAudioGraph([mic]);
    return {{
      stream: mic,
      childStreams: [mic],
      audioContext: graph.ctx,
      destination: graph.destination,
      sourceNodes: graph.sources,
    }};
  }}
  if (mode === 'system') {{
    const system = await getSystemStream();
    const graph = buildMixedAudioGraph([system]);
    return {{
      stream: system,
      childStreams: [system],
      audioContext: graph.ctx,
      destination: graph.destination,
      sourceNodes: graph.sources,
    }};
  }}
  const mic = await getMicStream();
  const system = await getSystemStream();
  const graph = buildMixedAudioGraph([mic, system]);
  return {{
    stream: graph.destination.stream,
    childStreams: [mic, system],
    audioContext: graph.ctx,
    destination: graph.destination,
    sourceNodes: graph.sources,
  }};
}}

function resetPcmBuffer() {{
  pcmChunks = [];
  currentChunkSampleCount = 0;
  currentChunkStartedAt = null;
  uploadCount = 0;
  pendingStepSampleCount = 0;
}}

function mergeFloat32Arrays(chunks, totalLength) {{
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {{
    merged.set(chunk, offset);
    offset += chunk.length;
  }}
  return merged;
}}

function keepTailSamples(samples, keepCount) {{
  if (!keepCount || keepCount <= 0 || samples.length <= keepCount) {{
    return samples;
  }}
  return samples.slice(samples.length - keepCount);
}}

function replacePcmBufferFromMerged(samples, overlapSampleCount) {{
  const tail = keepTailSamples(samples, overlapSampleCount);
  pcmChunks = tail.length ? [tail] : [];
  currentChunkSampleCount = tail.length;
  currentChunkStartedAt = tail.length ? Date.now() - OVERLAP_MS : null;
}}

function encodeWavFromFloat32(samples, sampleRate) {{
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  function writeString(offset, text) {{
    for (let i = 0; i < text.length; i++) {{
      view.setUint8(offset + i, text.charCodeAt(i));
    }}
  }}
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {{
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }}
  return new Blob([buffer], {{ type: 'audio/wav' }});
}}

function buildStatsFromSamples(samples, sampleRate) {{
  const durationMs = sampleRate > 0 ? Math.round((samples.length / sampleRate) * 1000) : null;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {{
    sumSquares += samples[i] * samples[i];
  }}
  const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;
  const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  return {{
    duration_ms: durationMs,
    rms_dbfs: Number.isFinite(rmsDbfs) ? Number(rmsDbfs.toFixed(2)) : -Infinity,
    channels: 1,
    frame_rate: sampleRate,
    sample_width: 2,
  }};
}}

async function uploadChunk(blob, stats) {{
  if (!currentSessionId) return;

  const formData = new FormData();
  formData.append('session_id', currentSessionId);
  formData.append('capture_mode', captureModeEl.value);
  formData.append('audio_stats_json', JSON.stringify(stats));
  formData.append('audio', new File([blob], 'chunk.wav', {{ type: 'audio/wav' }}));

  const res = await fetch('/api/transcribe', {{ method: 'POST', body: formData }});
  const data = await res.json();
  if (!res.ok) {{
    log(`Transcribe failed: ${{data.detail || 'unknown error'}}`);
    return;
  }}

  languageModeEl.textContent = data.language_mode || 'force:en';

  // ---- LIVE PANEL: always show raw_text if present ----
  const rawText = data.raw_text || data.text || '';
  if (rawText) {{
    liveItems.push({{
      text: rawText,
      filtered: !!data.filtered,
      reason: data.filter_reason || null,
    }});
    renderLiveTranscript();
  }}

  // ---- Update pending display ----
  if (data.pending_text) {{
    pendingText = data.pending_text;
    renderLiveTranscript();
  }}

  if (data.filtered) {{
    log(`Filtered: ${{data.filter_reason}}${{rawText ? ` | "${{rawText.substring(0,60)}}..."` : ''}}`);
    return;
  }}

  // ---- DB PANEL: only when stored ----
  if (data.stored) {{
    pendingText = '';  // Clear pending since it was consumed
    dbItems.push({{ chunk_index: data.chunk_index, text: data.text, capture_mode: data.capture_mode }});
    renderDbTranscript();
    renderLiveTranscript();
    log(`Stored chunk ${{data.chunk_index}}: "${{data.text.substring(0,80)}}..."${{data.merge_reason ? ` | ${{data.merge_reason}}` : ''}}${{data.phrase_dedup ? ' | dedup' : ''}}`);
    if (data.summary_created) {{
      summaryItems.push(data.summary_created);
      renderSummaries();
      log(`Summary ${{data.summary_created.summary_index}} created`);
    }}
    storageInfoEl.textContent = `DB: ${{data.db_path}}`;
  }}
}}

async function flushPcmChunk(force = false) {{
  if (!pcmChunks.length || !audioContext || currentChunkSampleCount <= 0) return;

  const chunkSampleCount = Math.round(audioContext.sampleRate * (CHUNK_MS / 1000));
  const overlapSampleCount = Math.round(audioContext.sampleRate * (OVERLAP_MS / 1000));
  const stepSampleCount = Math.max(1, Math.round(audioContext.sampleRate * (STEP_MS / 1000)));

  if (!force) {{
    if (uploadCount === 0 && currentChunkSampleCount < chunkSampleCount) return;
    if (uploadCount > 0 && pendingStepSampleCount < stepSampleCount) return;
  }} else {{
    if (uploadCount > 0 && pendingStepSampleCount <= 0) return;
  }}

  const merged = mergeFloat32Arrays(pcmChunks, currentChunkSampleCount);
  const stats = buildStatsFromSamples(merged, audioContext.sampleRate);
  const wavBlob = encodeWavFromFloat32(merged, audioContext.sampleRate);

  await uploadChunk(wavBlob, stats);
  uploadCount += 1;
  pendingStepSampleCount = 0;
  replacePcmBufferFromMerged(merged, overlapSampleCount);
}}

function installProcessor() {{
  if (!audioContext || !destinationNode) {{
    throw new Error('Audio graph is not ready.');
  }}
  const bufferSize = 4096;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  const streamSource = audioContext.createMediaStreamSource(destinationNode.stream);
  streamSource.connect(processor);
  processor.connect(audioContext.destination);
  processor.onaudioprocess = (event) => {{
    if (!isRecording) return;
    const input = event.inputBuffer.getChannelData(0);
    if (!input || !input.length) return;
    if (!currentChunkStartedAt) currentChunkStartedAt = Date.now();
    const copy = new Float32Array(input.length);
    copy.set(input);
    pcmChunks.push(copy);
    currentChunkSampleCount += copy.length;
    pendingStepSampleCount += copy.length;
  }};
  return {{ processor, streamSource }};
}}

async function startRecording() {{
  try {{
    const setup = await createCaptureSetup(captureModeEl.value);
    captureStream = setup.stream;
    audioContext = setup.audioContext;
    destinationNode = setup.destination;
    sourceNodes = setup.sourceNodes || [];

    setup.childStreams.forEach((stream, index) => logTrackInfo(stream, `inputStream[${{index}}]`));
    logTrackInfo(destinationNode.stream, 'mixedDestinationStream');

    if (!destinationNode.stream.getAudioTracks().length) {{
      alert('No audio track was captured. For system audio, choose a tab/window/screen that shares audio.');
      stopRecording();
      return;
    }}

    if (audioContext.state === 'suspended') {{
      await audioContext.resume();
    }}

    resetPcmBuffer();
    const installed = installProcessor();
    processorNode = installed.processor;
    processorNode._sourceNode = installed.streamSource;

    isRecording = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    recordingStateEl.textContent = `Recording (${{captureModeEl.value}}, window=${{CHUNK_MS}}ms, step=${{STEP_MS}}ms, overlap=${{OVERLAP_MS}}ms)`;
    log(`Recording started: source=${{captureModeEl.value}}, sampleRate=${{audioContext.sampleRate}}`);

    flushTimer = setInterval(async () => {{
      await flushPcmChunk(false);
    }}, 300);
  }} catch (err) {{
    alert(`Recording failed: ${{String(err)}}`);
  }}
}}

async function stopRecording() {{
  isRecording = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  recordingStateEl.textContent = 'Idle';

  if (flushTimer) {{
    clearInterval(flushTimer);
    flushTimer = null;
  }}

  try {{
    await flushPcmChunk(true);
  }} catch (err) {{
    log(`Final flush failed: ${{String(err)}}`);
  }}

  if (processorNode) {{
    processorNode.disconnect();
    if (processorNode._sourceNode) processorNode._sourceNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }}

  sourceNodes = [];
  stopStream(captureStream);
  captureStream = null;

  if (audioContext) {{
    audioContext.close().catch(() => {{}});
    audioContext = null;
  }}
  destinationNode = null;
  resetPcmBuffer();
  log('Recording stopped.');
}}

async function askQuestion() {{
  const question = questionEl.value.trim();
  if (!question || !currentSessionId) return;
  answerEl.textContent = 'Thinking...';
  const res = await fetch('/api/ask', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify({{ session_id: currentSessionId, question }})
  }});
  const data = await res.json();
  if (!res.ok) {{
    answerEl.textContent = `Error: ${{data.detail || 'unknown error'}}`;
    return;
  }}
  answerEl.textContent = data.answer;
  log(`Question answered. Citations: ${{(data.citations || []).join(', ')}}`);
}}

document.getElementById('newSessionBtn').addEventListener('click', createSession);
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
askBtn.addEventListener('click', askQuestion);
</script>
</body>
</html>
"""
