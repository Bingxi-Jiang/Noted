// summarizer.js — Summaries, Q&A, note generation, auto-titling via Gemini

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function extractTextFromGeminiResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part?.text || '')
    .join('')
    .trim();
}

async function callGemini(
  apiKey,
  systemPrompt,
  userMessage,
  {
    maxOutputTokens = 1024,
    thinkingLevel = 'low',
    responseMimeType,
  } = {},
) {
  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [{
      role: 'user',
      parts: [{ text: userMessage }],
    }],
    generationConfig: {
      maxOutputTokens,
      thinkingConfig: {
        thinkingLevel,
      },
    },
  };

  if (responseMimeType) {
    body.generationConfig.responseMimeType = responseMimeType;
  }

  const res = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = extractTextFromGeminiResponse(data);
  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }
  return text;
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw.trim());
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]);
    } catch {
      return fallback;
    }
  }
}

// ── Rolling Summary ──
export async function generateRollingSummary(apiKey, chunks, previousSummary = null) {
  const transcript = chunks.map(c => {
    const mins = Math.floor(c.start_time / 60);
    const secs = Math.floor(c.start_time % 60);
    return `[${mins}:${String(secs).padStart(2, '0')}] ${c.text}`;
  }).join('\n');

  const system = `You are a lecture and meeting note-taker. Create concise, well-structured summaries.
Include key concepts, definitions, important points, decisions, and action items.
Use bullet points for clarity. Keep summaries focused, information-dense, and non-redundant.
If a previous summary is provided, extend it with only genuinely new information.`;

  const prompt = previousSummary
    ? `Previous summary:\n${previousSummary}\n\n---\nNew transcript:\n${transcript}\n\nUpdate the summary with new content only.`
    : `Summarize this transcript:\n${transcript}`;

  return callGemini(apiKey, system, prompt, {
    maxOutputTokens: 1024,
    thinkingLevel: 'low',
  });
}

// ── Topic Detection ──
export async function detectTopicChange(apiKey, recentChunks, previousTopicLabel = '') {
  const transcript = recentChunks.map(c => c.text).join(' ');
  const system = `Analyze whether the topic of the transcript has materially changed.
Respond with JSON only using this schema:
{"changed": true/false, "topic": "short label", "summary": "brief explanation if changed"}`;

  const raw = await callGemini(
    apiKey,
    system,
    `Previous topic: "${previousTopicLabel || 'none'}"\nTranscript: "${transcript}"`,
    {
      maxOutputTokens: 300,
      thinkingLevel: 'low',
      responseMimeType: 'application/json',
    },
  );

  return safeJsonParse(raw, {
    changed: false,
    topic: previousTopicLabel,
    summary: '',
  });
}

// ── Q&A ──
export async function answerQuestion(apiKey, question, relevantChunks, summaries = [], crossSession = false) {
  const context = relevantChunks.map(c => {
    const mins = Math.floor(c.start_time / 60);
    const secs = Math.floor(c.start_time % 60);
    const prefix = c.session_title
      ? `[${c.session_title} @ ${mins}:${String(secs).padStart(2, '0')}]`
      : `[${mins}:${String(secs).padStart(2, '0')}]`;
    return `${prefix} ${c.text}`;
  }).join('\n');

  const summaryCtx = summaries.length > 0
    ? '\n\nSummaries:\n' + summaries.map(s => {
        const label = s.session_title ? `[${s.session_title}]` : '';
        return `${label} ${s.summary_text}`;
      }).join('\n\n')
    : '';

  const system = `You answer questions about lectures and meetings using only the provided transcript context.
${crossSession ? 'The context may span multiple sessions, so explicitly mention which session the answer came from when relevant.' : ''}
Reference timestamps when possible. Be precise. If the answer is not supported by the context, say so clearly.`;

  return callGemini(
    apiKey,
    system,
    `Transcript:\n${context}${summaryCtx}\n\n---\nQuestion: ${question}`,
    {
      maxOutputTokens: 1024,
      thinkingLevel: 'low',
    },
  );
}

// ── Auto-title generation ──
export async function generateSessionTitle(apiKey, chunks) {
  const text = chunks.slice(0, 30).map(c => c.text).join(' ').substring(0, 1500);
  const system = 'Generate a concise title for a recording session. Return only the title, 3 to 8 words, with no quotes or extra commentary.';

  return callGemini(apiKey, system, `Transcript excerpt:\n"${text}"`, {
    maxOutputTokens: 50,
    thinkingLevel: 'minimal',
  });
}

// ── Note Generation ──
const NOTE_METHODS = {
  cornell: {
    name: 'Cornell Method',
    mode: 'lecture',
    system: `You are an expert note-taker using the Cornell Method. Structure notes as follows:

## [Title]
---

### Cues / Questions | Notes
Use a two-column format where:
- LEFT side: Key questions, cue words, or prompts that trigger recall
- RIGHT side: Detailed notes, explanations, examples

Format each pair as:
**Q: [question/cue]**
[detailed notes for this topic]

---

### Summary
Write a brief summary (3-5 sentences) of the entire lecture at the bottom.

Keep notes concise. Use timestamps where relevant. Focus on main ideas, definitions, and relationships between concepts.`
  },

  outline: {
    name: 'Outline Method',
    mode: 'lecture',
    system: `You are an expert note-taker using the Outline Method. Structure notes hierarchically:

## [Title]

Use indented bullet points to show relationships:
- **Main Topic 1**
  - Sub-point A
    - Detail or example
    - Detail or example
  - Sub-point B
    - Detail
- **Main Topic 2**
  - Sub-point A
  - Sub-point B

### Key Definitions
List any important terms and their definitions.

### Key Takeaways
3-5 most important points from the lecture.

Keep it scannable. Use timestamps for key moments. Focus on hierarchy and relationships between concepts.`
  },

  meeting: {
    name: 'Meeting Minutes',
    mode: 'meeting',
    system: `You are an expert meeting note-taker. Generate meeting notes in the following format. Output in the SAME LANGUAGE as the transcript (if the transcript is in Chinese, output Chinese; if English, output English).

## Meeting Overview (全文概要)
A comprehensive summary of the entire meeting in 4-8 sentences. Cover the purpose, main discussion points, key decisions made, and overall outcome.

---

## Section Overview (章节速览)
Break the meeting into logical sections/topics that were discussed. For each section:

### [Section Title]
**Time Range:** [start] - [end]
**Participants:** [who spoke in this section]

**Key Points:**
- Bullet point summaries of what was discussed
- Include who said what when relevant (e.g., "Paul suggested..." or "Speaker 1 mentioned...")
- Note any decisions made
- Note any action items assigned

**Disagreements / Open Questions:**
- Any unresolved items or different opinions expressed

---

### Action Items (待办事项)
Consolidate all action items from the meeting:
- [ ] [Action item] — assigned to [person], deadline: [if mentioned]

### Decisions Made (决定事项)
List all decisions reached during the meeting.

Use speaker names where available. Reference timestamps. Be thorough but concise.`
  },
};

export function getNoteMethods(mode = null) {
  if (mode) {
    return Object.entries(NOTE_METHODS)
      .filter(([, m]) => m.mode === mode)
      .map(([id, m]) => ({ id, name: m.name }));
  }
  return Object.entries(NOTE_METHODS).map(([id, m]) => ({ id, name: m.name, mode: m.mode }));
}

export async function generateNotes(apiKey, chunks, summaries = [], method = 'cornell', speakerNameMap = {}) {
  const config = NOTE_METHODS[method] || NOTE_METHODS.cornell;

  const transcript = chunks.map(c => {
    const mins = Math.floor(c.start_time / 60);
    const secs = Math.floor(c.start_time % 60);
    const speakerLabel = speakerNameMap[c.speaker] || c.speaker;
    if (method === 'meeting') {
      return `[${mins}:${String(secs).padStart(2, '0')}] [${speakerLabel}] ${c.text}`;
    }
    return `[${mins}:${String(secs).padStart(2, '0')}] ${c.text}`;
  }).join('\n');

  const summaryCtx = summaries.length > 0
    ? '\n\nExisting summaries (for reference):\n' + summaries.map(s => s.summary_text).join('\n\n')
    : '';

  let prompt;
  if (method === 'meeting') {
    const speakerInfo = Object.keys(speakerNameMap).length > 0
      ? '\n\nSpeaker name mapping:\n' + Object.entries(speakerNameMap).map(([k, v]) => `${k} = ${v}`).join('\n')
      : '';
    prompt = `Generate comprehensive meeting notes from this transcript.${speakerInfo}${summaryCtx}\n\nFull transcript:\n${transcript}`;
  } else {
    prompt = `Generate comprehensive notes from this lecture transcript.${summaryCtx}\n\nFull transcript:\n${transcript}`;
  }

  return callGemini(apiKey, config.system, prompt, {
    maxOutputTokens: 4096,
    thinkingLevel: 'medium',
  });
}
