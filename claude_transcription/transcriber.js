// transcriber.js — Deepgram real-time transcription bridge
import WebSocket from 'ws';

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

/**
 * Creates a Deepgram streaming connection for a session.
 * Returns an object with methods to pipe audio and receive transcript events.
 */
export function createTranscriber(apiKey, options = {}) {
  const {
    model = 'nova-2',
    language = 'en',
    smart_format = true,
    punctuate = true,
    diarize = false,
    interim_results = true,     // partial transcripts
    utterance_end_ms = 1500,    // silence threshold for utterance boundary
    vad_events = true,          // voice activity detection
    endpointing = 300,
  } = options;

  const params = new URLSearchParams({
    model,
    language,
    smart_format: String(smart_format),
    punctuate: String(punctuate),
    diarize: String(diarize),
    interim_results: String(interim_results),
    utterance_end_ms: String(utterance_end_ms),
    vad_events: String(vad_events),
    endpointing: String(endpointing),
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  });

  const dgUrl = `${DEEPGRAM_WS_URL}?${params.toString()}`;
  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  const emitter = {
    _handlers: {},
    on(event, fn) {
      (this._handlers[event] ??= []).push(fn);
      return this;
    },
    emit(event, ...args) {
      (this._handlers[event] ?? []).forEach(fn => fn(...args));
    },
  };

  dgWs.on('open', () => {
    console.log('[Deepgram] Connected');
    emitter.emit('open');
  });

  let audioBytesSent = 0;
  let dgMsgCount = 0;

  dgWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      dgMsgCount++;

      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0];
        if (!alt) {
          if (dgMsgCount <= 5) console.log('[Deepgram] Results msg with no alternatives');
          return;
        }

        const transcript = alt.transcript;
        if (!transcript) {
          // Empty transcript = silence, this is normal
          return;
        }

        const isFinal = msg.is_final;
        const speechFinal = msg.speech_final;
        const start = msg.start ?? 0;
        const duration = msg.duration ?? 0;
        const words = alt.words ?? [];
        const speaker = words[0]?.speaker ?? 0;

        emitter.emit('transcript', {
          text: transcript,
          is_final: isFinal,
          speech_final: speechFinal,
          start,
          end: start + duration,
          duration,
          speaker: `speaker_${speaker}`,
          words,
          confidence: alt.confidence ?? 0,
        });

        if (speechFinal) {
          emitter.emit('utterance_end', { start, end: start + duration });
        }
      } else if (msg.type === 'UtteranceEnd') {
        emitter.emit('utterance_end', msg);
      } else if (msg.type === 'Metadata') {
        console.log('[Deepgram] Metadata:', JSON.stringify(msg).substring(0, 200));
        emitter.emit('metadata', msg);
      } else if (msg.type === 'Error' || msg.error) {
        console.error('[Deepgram] Error response:', JSON.stringify(msg));
        emitter.emit('error', new Error(msg.message || msg.description || 'Deepgram error'));
      } else {
        console.log('[Deepgram] Unknown msg type:', msg.type);
      }
    } catch (e) {
      console.error('[Deepgram] Parse error:', e.message, 'raw:', raw.toString().substring(0, 200));
    }
  });

  dgWs.on('close', (code, reason) => {
    console.log(`[Deepgram] Closed: ${code} ${reason}`);
    emitter.emit('close', { code, reason: reason.toString() });
  });

  dgWs.on('error', (err) => {
    console.error('[Deepgram] Error:', err.message);
    emitter.emit('error', err);
  });

  return {
    /** Send raw audio bytes to Deepgram */
    sendAudio(buffer) {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(buffer);
        audioBytesSent += buffer.byteLength;
        if (audioBytesSent % (16000 * 2 * 5) < buffer.byteLength) { // log every ~5 seconds of audio
          console.log(`[Deepgram] Audio sent: ${(audioBytesSent / 1024).toFixed(0)}KB total, dgMsgs received: ${dgMsgCount}`);
        }
      } else {
        // Log only occasionally to avoid spam
        if (audioBytesSent === 0) {
          console.warn('[Deepgram] sendAudio called but WS not open, readyState:', dgWs.readyState);
        }
      }
    },

    /** Gracefully close the Deepgram connection */
    close() {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: 'CloseStream' }));
        dgWs.close();
      }
    },

    /** Check if connected */
    get isOpen() {
      return dgWs.readyState === WebSocket.OPEN;
    },

    /** Event emitter */
    on: emitter.on.bind(emitter),
  };
}
