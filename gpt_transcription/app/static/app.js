const state = {
  sessionId: null,
  ws: null,
  mediaStream: null,
  systemStream: null,
  audioContext: null,
  audioNode: null,
  sinkNode: null,
  sourceNodes: [],
  isRecording: false,
  activeInputMode: "mic",
};

const $ = (id) => document.getElementById(id);

const sessionNameEl = $("sessionName");
const summaryModeEl = $("summaryMode");
const summaryIntervalEl = $("summaryInterval");
const topicThresholdEl = $("topicThreshold");
const inputModeEl = $("inputMode");
const inputHintEl = $("inputHint");
const createSessionBtn = $("createSessionBtn");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const flushBtn = $("flushBtn");
const applyConfigBtn = $("applyConfigBtn");
const liveDot = $("liveDot");
const liveStatus = $("liveStatus");
const wsStatus = $("wsStatus");
const sessionIdLabel = $("sessionIdLabel");
const partialLive = $("partialLive");
const utteranceList = $("utteranceList");
const finalTranscriptList = $("finalTranscriptList");
const summaryList = $("summaryList");
const qaQuestion = $("qaQuestion");
const qaMinutesBack = $("qaMinutesBack");
const askBtn = $("askBtn");
const qaAnswer = $("qaAnswer");
const qaSources = $("qaSources");

function setLiveState(text, active = false) {
  liveStatus.textContent = text;
  liveDot.classList.toggle("active", active);
}

function appendSegment(container, payload, extraClass = "") {
  const card = document.createElement("div");
  card.className = `segment ${extraClass}`.trim();
  card.innerHTML = `
    <div class="time">${payload.start_label} → ${payload.end_label}</div>
    <div>${escapeHtml(payload.text)}</div>
  `;
  container.prepend(card);
}

function appendSummary(summary) {
  const card = document.createElement("div");
  card.className = "summary-card";
  card.innerHTML = `
    <div class="time">${summary.mode.toUpperCase()} · ${summary.start_label} → ${summary.end_label}</div>
    <div>${escapeHtml(summary.text)}</div>
  `;
  summaryList.prepend(card);
}

function renderSources(sources) {
  qaSources.innerHTML = "";
  if (!sources || !sources.length) return;

  for (const source of sources) {
    const card = document.createElement("div");
    card.className = "source-card";
    card.innerHTML = `
      <div class="source-tag">${source.type.toUpperCase()}</div>
      <div class="time">${source.start_label} → ${source.end_label}</div>
      <div>${escapeHtml(source.text)}</div>
    `;
    qaSources.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("\n", "<br>");
}

function updateInputHint() {
  const mode = inputModeEl.value;
  if (mode === "mic") {
    inputHintEl.textContent = "Mic only. Uses getUserMedia().";
  } else if (mode === "system") {
    inputHintEl.textContent = "System/tab audio. Browser will ask you to share a tab, window, or screen. Availability depends on browser/OS/share target.";
  } else {
    inputHintEl.textContent = "Mixed input. Captures mic plus screen/tab audio and sums them before streaming.";
  }
}

async function createSession() {
  const body = {
    name: sessionNameEl.value || "Live Lecture Session",
    summary_mode: summaryModeEl.value,
    summary_interval_seconds: Number(summaryIntervalEl.value || 300),
    topic_similarity_threshold: Number(topicThresholdEl.value || 0.72),
  };

  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }
  const data = await response.json();
  state.sessionId = data.session_id;
  sessionIdLabel.textContent = state.sessionId;
  startBtn.disabled = false;
  askBtn.disabled = false;
  flushBtn.disabled = false;
  applyConfigBtn.disabled = false;
  setLiveState("Session created", false);
}

async function applySummaryConfig() {
  if (!state.sessionId) return;
  const body = {
    summary_mode: summaryModeEl.value,
    summary_interval_seconds: Number(summaryIntervalEl.value || 300),
    topic_similarity_threshold: Number(topicThresholdEl.value || 0.72),
  };
  const response = await fetch(`/api/sessions/${state.sessionId}/summary-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Failed to update config: ${response.status}`);
  }
  setLiveState("Summary config updated", state.isRecording);
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws/transcribe/${state.sessionId}`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      state.ws = ws;
      wsStatus.textContent = "Connected";
      resolve();
    };

    ws.onerror = () => reject(new Error("WebSocket connection failed."));

    ws.onclose = () => {
      wsStatus.textContent = "Disconnected";
      state.ws = null;
      if (state.isRecording) setLiveState("Socket disconnected", false);
    };

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      handleServerEvent(payload);
    };
  });
}

function handleServerEvent(payload) {
  switch (payload.type) {
    case "status":
      setLiveState(payload.message || payload.status, state.isRecording);
      break;
    case "speech_started":
      setLiveState("Speech detected", true);
      break;
    case "speech_stopped":
      setLiveState(`Processing ${state.activeInputMode} audio`, true);
      break;
    case "partial_transcript":
      partialLive.textContent = payload.text || "No partial transcript yet.";
      partialLive.classList.toggle("muted", !payload.text);
      break;
    case "utterance_final":
      appendSegment(utteranceList, payload.segment, "raw-utterance");
      break;
    case "final_transcript":
      appendSegment(finalTranscriptList, payload.segment);
      break;
    case "rolling_summary":
      appendSummary(payload.summary);
      break;
    case "error":
      setLiveState(payload.message || "Error", false);
      console.error(payload);
      break;
    default:
      console.log("Unhandled event", payload);
  }
}

async function ensureAudioPipeline() {
  state.audioContext = new AudioContext({ latencyHint: "interactive" });
  await state.audioContext.audioWorklet.addModule("/static/audio-worklet.js");

  state.audioNode = new AudioWorkletNode(state.audioContext, "pcm-streamer", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  state.audioNode.port.onmessage = (event) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(event.data);
    }
  };
  state.audioNode.port.postMessage({ type: "configure", targetSampleRate: 24000 });

  state.sinkNode = state.audioContext.createGain();
  state.sinkNode.gain.value = 0;
  state.audioNode.connect(state.sinkNode);
  state.sinkNode.connect(state.audioContext.destination);
}

async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    },
    video: false,
  });
}

async function getSystemStream() {
  return navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

function attachAudioStreamToPipeline(stream, label) {
  const hasAudio = stream.getAudioTracks().length > 0;
  if (!hasAudio) {
    throw new Error(`${label} capture succeeded but no audio track was provided. Try sharing a browser tab/window that includes audio.`);
  }

  const sourceNode = state.audioContext.createMediaStreamSource(stream);
  sourceNode.connect(state.audioNode);
  state.sourceNodes.push(sourceNode);
}

async function startCapture() {
  if (!state.sessionId) {
    throw new Error("Create a session first.");
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    await connectWebSocket();
  }
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser does not expose the required media capture APIs.");
  }

  state.activeInputMode = inputModeEl.value;
  await ensureAudioPipeline();

  try {
    if (state.activeInputMode === "mic" || state.activeInputMode === "both") {
      state.mediaStream = await getMicStream();
      attachAudioStreamToPipeline(state.mediaStream, "Microphone");
    }

    if (state.activeInputMode === "system" || state.activeInputMode === "both") {
      state.systemStream = await getSystemStream();
      attachAudioStreamToPipeline(state.systemStream, "System audio");
    }
  } catch (error) {
    await teardownCapture(false);
    throw error;
  }

  state.isRecording = true;
  setLiveState(`Listening (${state.activeInputMode})`, true);
  startBtn.disabled = true;
  stopBtn.disabled = false;
}

async function teardownCapture(sendCommit = true) {
  for (const node of state.sourceNodes) {
    try {
      node.disconnect();
    } catch (_) {
      // no-op
    }
  }
  state.sourceNodes = [];

  if (state.audioNode) {
    try {
      state.audioNode.disconnect();
    } catch (_) {
      // no-op
    }
    state.audioNode = null;
  }

  if (state.sinkNode) {
    try {
      state.sinkNode.disconnect();
    } catch (_) {
      // no-op
    }
    state.sinkNode = null;
  }

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }
  if (state.systemStream) {
    state.systemStream.getTracks().forEach((track) => track.stop());
    state.systemStream = null;
  }
  if (state.audioContext) {
    await state.audioContext.close();
    state.audioContext = null;
  }

  if (sendCommit && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "commit_audio_buffer" }));
    state.ws.send(JSON.stringify({ type: "flush" }));
  }
}

async function stopCapture() {
  await teardownCapture(true);
  state.isRecording = false;
  setLiveState("Stopped", false);
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

async function askQuestion() {
  if (!state.sessionId) return;
  const body = {
    session_id: state.sessionId,
    question: qaQuestion.value,
    minutes_back: Number(qaMinutesBack.value || 15),
  };

  qaAnswer.textContent = "Thinking...";
  qaAnswer.classList.remove("muted");
  qaSources.innerHTML = "";

  const response = await fetch("/api/qa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    qaAnswer.textContent = `Q&A failed: ${text}`;
    return;
  }

  const data = await response.json();
  qaAnswer.textContent = data.answer;
  renderSources(data.sources);
}

createSessionBtn.addEventListener("click", async () => {
  try {
    await createSession();
  } catch (error) {
    console.error(error);
    setLiveState(error.message || "Failed to create session", false);
  }
});

applyConfigBtn.addEventListener("click", async () => {
  try {
    await applySummaryConfig();
  } catch (error) {
    console.error(error);
    setLiveState(error.message || "Failed to update config", false);
  }
});

startBtn.addEventListener("click", async () => {
  try {
    await startCapture();
  } catch (error) {
    console.error(error);
    setLiveState(error.message || "Failed to start capture", false);
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await stopCapture();
  } catch (error) {
    console.error(error);
    setLiveState(error.message || "Failed to stop capture", false);
  }
});

flushBtn.addEventListener("click", () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "flush" }));
  }
});

askBtn.addEventListener("click", async () => {
  try {
    await askQuestion();
  } catch (error) {
    console.error(error);
    qaAnswer.textContent = error.message || "Q&A failed.";
  }
});

inputModeEl.addEventListener("change", updateInputHint);
updateInputHint();
