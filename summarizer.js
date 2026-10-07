// Summaries, Q&A, notes, and screen analysis via the selected AI provider.
import { generateAI } from './ai-client.js';

const callAI = generateAI;
function callAIWithImage(config, system, text, imageBase64, mimeType = 'image/jpeg', options = {}) {
  return generateAI(config, system, text, { ...options, imageBase64, mimeType, responseMimeType: 'application/json' });
}

// ── Analyze screen capture ──
export async function analyzeScreenCapture(apiKey, imageBase64, recentTranscript = '', mimeType = 'image/jpeg') {
  const system = `You are analyzing a screenshot captured during a lecture or meeting. Your job is to extract ALL useful information visible on screen.

Focus on:
1. Any text visible (slides, documents, code, chat messages, whiteboard notes)
2. Diagrams, charts, or visual aids — describe their content and meaning
3. Key concepts, formulas, or data shown
4. UI elements that indicate context (app name, slide number, page title)

Output in this JSON format:
{
  "description": "Brief 1-2 sentence description of what's on screen",
  "extracted_text": "All readable text from the screenshot, preserving structure",
  "key_concepts": ["concept1", "concept2"],
  "visual_elements": "Description of any diagrams, charts, or images",
  "context_clue": "Any contextual info (slide number, app name, etc.)"
}`;

  const prompt = recentTranscript
    ? `Analyze this screenshot. Recent audio transcript for context:\n"${recentTranscript.substring(0, 500)}"\n\nExtract all visible information.`
    : `Analyze this screenshot and extract all visible information.`;

  const raw = await callAIWithImage(apiKey, system, prompt, imageBase64, mimeType, {
    maxOutputTokens: 1024,
    thinkingLevel: 'low',
  });

  return safeJsonParse(raw, {
    description: raw.substring(0, 200),
    extracted_text: '',
    key_concepts: [],
    visual_elements: '',
    context_clue: '',
  });
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

function normalizeSectionHeading(title = '') {
  return String(title || '')
    .toLowerCase()
    .replace(/[：:]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarkdownSection(markdown, targetHeadings = []) {
  if (!markdown) return '';
  const targets = new Set(targetHeadings.map(normalizeSectionHeading));
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{2,6})\s+(.+)$/);
    if (!match) {
      result.push(lines[i]);
      continue;
    }

    const level = match[1].length;
    const title = normalizeSectionHeading(match[2]);
    if (!targets.has(title)) {
      result.push(lines[i]);
      continue;
    }

    i += 1;
    while (i < lines.length) {
      const nextMatch = lines[i].match(/^(#{2,6})\s+(.+)$/);
      if (nextMatch && nextMatch[1].length <= level) {
        i -= 1;
        break;
      }
      i += 1;
    }
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildTranscriptForMode(chunks, method, speakerNameMap = {}) {
  return chunks.map(c => {
    const mins = Math.floor(c.start_time / 60);
    const secs = Math.floor(c.start_time % 60);
    const speakerLabel = speakerNameMap[c.speaker] || c.speaker;
    if (method === 'meeting') {
      return `[${mins}:${String(secs).padStart(2, '0')}] [${speakerLabel}] ${c.text}`;
    }
    return `[${mins}:${String(secs).padStart(2, '0')}] ${c.text}`;
  }).join('\n');
}

function buildScreenCaptureContext(screenCaptures = []) {
  if (!screenCaptures || screenCaptures.length === 0) return '';
  let screenCtx = '\n\n=== Screen Capture Context (visual information from shared screen) ===\n';
  screenCtx += screenCaptures.map(sc => {
    const mins = Math.floor(sc.capture_time / 60);
    const secs = Math.floor(sc.capture_time % 60);
    let entry = `[${mins}:${String(secs).padStart(2, '0')}] 📺 ${sc.description}`;
    if (sc.extracted_text) entry += `\n    Visible text: ${sc.extracted_text}`;
    return entry;
  }).join('\n');
  screenCtx += '\n=== End Screen Captures ===';
  return screenCtx;
}

function formatActionItemsMarkdown(items = []) {
  if (!items.length) return '- None identified';
  return items.map(item => {
    const text = (item.text || '').trim();
    const meta = [];
    if (item.assignee) meta.push(`assigned to ${item.assignee}`);
    if (item.deadline) meta.push(`deadline: ${item.deadline}`);
    if (item.timestamp) meta.push(`timestamp: ${item.timestamp}`);
    return `- [ ] ${text}${meta.length ? ` — ${meta.join(', ')}` : ''}`;
  }).join('\n');
}

function buildDefaultActionItemsLog(items = [], mode = 'generic') {
  const modeLabel = mode === 'lecture'
    ? 'lecture-specific student action items'
    : mode === 'meeting'
      ? 'meeting action items'
      : 'action items';

  return {
    summary: items.length > 0
      ? `Extracted ${items.length} ${modeLabel} based on explicit tasks, deadlines, reminders, or follow-up commitments in the transcript.`
      : mode === 'lecture'
        ? 'No lecture-specific student action items were detected. This extractor ignores general lecture content and only keeps student-facing tasks, deadlines, reminders, or required follow-ups.'
        : 'No explicit future-facing tasks, deadlines, reminders, or commitments were detected.',
    included: items.map(item => ({
      timestamp: item.timestamp || '',
      candidate: item.text || '',
      decision: 'included',
      reason: item.source || 'Explicit task, deadline, reminder, or follow-up mention.',
    })),
    excluded: [],
  };
}

function normalizeAssignee(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isLectureAudienceAssignee(assignee = '') {
  const normalized = normalizeAssignee(assignee);
  if (!normalized) return true;

  const audiencePatterns = [
    /^class$/,
    /^whole class$/,
    /^everyone$/,
    /^all students?$/,
    /^students?$/,
    /^the students?$/,
    /^audience$/,
    /^the audience$/,
    /^you$/,
    /^you all$/,
    /^all of you$/,
    /^we$/,
    /^us$/,
    /^team$/,
  ];

  return audiencePatterns.some(pattern => pattern.test(normalized));
}

function getLectureActionSignals(item = {}) {
  const combined = [item.text, item.source, item.deadline]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();

  const matches = [];
  const tests = [
    ['quiz or exam', /\b(quiz|midterm|final|exam|test)\b/],
    ['assignment or deliverable', /\b(homework|assignment|problem set|pset|project|paper|essay|lab report|deliverable|submission)\b/],
    ['deadline or due date', /\b(due|deadline|submit by|turn in by|before class|next (?:class|week|tuesday|wednesday|thursday|friday|monday)|this (?:friday|week|weekend)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by \w+)\b/],
    ['reading or preparation', /\b(read|review|watch|prepare|study|go over|finish|complete)\b/],
    ['form, survey, or evaluation', /\b(form|survey|evaluation|course eval|feedback form)\b/],
    ['contact or attendance action', /\b(email me|send me an email|come to office hours|office hours|attend|show up|bring|sign up|register|upload|post on|submit to|turn in)\b/],
    ['explicit reminder', /\b(remember to|make sure to|do not forget|please)\b/],
  ];

  for (const [label, pattern] of tests) {
    if (pattern.test(combined)) matches.push(label);
  }

  return { combined, matches };
}

function postProcessLectureActionItems(items = [], originalLog = null) {
  const included = [];
  const excluded = Array.isArray(originalLog?.excluded) ? [...originalLog.excluded] : [];

  for (const item of items) {
    const assigneeOk = isLectureAudienceAssignee(item.assignee);
    const { matches } = getLectureActionSignals(item);
    const hasDeadline = Boolean((item.deadline || '').trim());
    const include = assigneeOk && (matches.length > 0 || hasDeadline);

    if (include) {
      included.push({
        ...item,
        source: item.source || `Matched lecture action signals: ${matches.join(', ') || 'explicit deadline'}`,
      });
      continue;
    }

    const reasons = [];
    if (!assigneeOk) reasons.push('assignee is a specific person rather than the class or students');
    if (!hasDeadline && matches.length === 0) reasons.push('no clear lecture-style action signal such as quiz, homework, deadline, form, reading, email, or reminder');

    excluded.push({
      timestamp: item.timestamp || '',
      candidate: item.text || '',
      decision: 'excluded',
      reason: reasons.join('; ') || 'did not meet lecture action item criteria',
    });
  }

  const log = {
    summary: included.length > 0
      ? `Lecture mode kept ${included.length} student-facing action item(s). Rule: include only class-wide or student-directed tasks, deadlines, quizzes, homework, forms, required reminders, or instructor follow-ups; exclude person-specific assignments and general lecture content.`
      : 'Lecture mode found no student-facing action items. Rule: only class-wide or student-directed tasks, deadlines, quizzes, homework, forms, reminders, and required follow-ups are kept.',
    included: included.map(item => ({
      timestamp: item.timestamp || '',
      candidate: item.text || '',
      decision: 'included',
      reason: item.source || 'Matched lecture action item rule.',
    })),
    excluded,
  };

  return { items: included, log };
}

export function sanitizeGeneratedNotes(content = '') {
  return stripMarkdownSection(content, ['Action Items', 'Action Item', '待办事项']);
}

// ── Rolling Summary (kept for internal use / notes context) ──
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

  return callAI(apiKey, system, prompt, {
    maxOutputTokens: 1024,
    thinkingLevel: 'low',
  });
}

// ── Concept Boundary Detection + Recap ──
export async function detectConceptBoundary(apiKey, recentChunks, previousConcepts = []) {
  const transcript = recentChunks.map(c => c.text).join(' ');
  const prevList = previousConcepts.length > 0
    ? previousConcepts.map(c => `- "${c}"`).join('\n')
    : 'none';

  const system = `You are analyzing a live lecture/presentation transcript to detect whether a COMPLETE concept or topic has just been explained.

STRICT RULES — only output changed=true when ALL of these are met:
1. The speaker has FINISHED explaining a distinct concept (not just mentioned it)
2. There is a CLEAR transition signal: the speaker moves to a new topic, says "next", "moving on", "now let's look at", pauses significantly, or the content clearly shifts
3. The completed concept is substantive enough to warrant a recap (not a brief aside or transition phrase)
4. The concept is NOT already in the previous concepts list
5. At least 3-5 minutes of content should have elapsed since the last concept was detected

Be CONSERVATIVE. It is much better to miss a boundary than to fire too often.
When in doubt, output changed=false.

Respond with JSON only:
{"changed": true/false, "concept_title": "short title of the completed concept", "reason": "why you detected a boundary"}`;

  const raw = await callAI(
    apiKey,
    system,
    `Previous concepts already captured:\n${prevList}\n\nRecent transcript (last ~2-3 minutes):\n"${transcript}"`,
    {
      maxOutputTokens: 300,
      thinkingLevel: 'low',
      responseMimeType: 'application/json',
    },
  );

  return safeJsonParse(raw, {
    changed: false,
    concept_title: '',
    reason: '',
  });
}

export async function generateConceptRecap(apiKey, chunks, conceptTitle) {
  const transcript = chunks.map(c => {
    const mins = Math.floor(c.start_time / 60);
    const secs = Math.floor(c.start_time % 60);
    return `[${mins}:${String(secs).padStart(2, '0')}] ${c.text}`;
  }).join('\n');

  const system = `You are generating a CONCEPT RECAP card for a lecture. This card should be a quick-reference summary of ONE specific concept that was just explained.

Output in this exact structure (use the same language as the transcript):

## ${conceptTitle}

**Core Idea:** One sentence explaining the concept in plain language.

**Key Details:**
- 2-4 bullet points with the most important facts, formulas, or relationships
- Include any definitions, examples, or analogies the speaker used

**Why It Matters:** One sentence on significance or how it connects to the bigger picture.

Keep it SHORT and DENSE — this is a flashcard-style recap, not a full summary. Max 150 words total.`;

  return callAI(apiKey, system, `Transcript covering this concept:\n${transcript}`, {
    maxOutputTokens: 512,
    thinkingLevel: 'low',
  });
}

// ── Topic Detection ──
export async function detectTopicChange(apiKey, recentChunks, previousTopicLabel = '') {
  const transcript = recentChunks.map(c => c.text).join(' ');
  const system = `Analyze whether the topic of the transcript has materially changed.
Respond with JSON only using this schema:
{"changed": true/false, "topic": "short label", "summary": "brief explanation if changed"}`;

  const raw = await callAI(
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

  return callAI(
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

  return callAI(apiKey, system, `Transcript excerpt:\n"${text}"`, {
    maxOutputTokens: 1024,
    thinkingLevel: 'low',
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

Do not include a separate Action Items section. Keep notes concise. Use timestamps where relevant. Focus on main ideas, definitions, and relationships between concepts.`
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

Do not include a separate Action Items section. Keep it scannable. Use timestamps for key moments. Focus on hierarchy and relationships.`
  },

  meeting: {
    name: 'Meeting Minutes',
    mode: 'meeting',
    system: `You are an expert meeting note-taker. Generate meeting notes in the following format. Keep section headings in English only. The body content can follow the transcript language.

## Meeting Overview
A comprehensive summary of the entire meeting in 4-8 sentences. Cover the purpose, main discussion points, key decisions made, and overall outcome.

---

## Section Overview
Break the meeting into logical sections/topics that were discussed. For each section:

### [Section Title]
**Time Range:** [start] - [end]
**Participants:** [who spoke in this section]

**Key Points:**
- Bullet point summaries of what was discussed
- Include who said what when relevant (e.g., "Paul suggested..." or "Speaker 1 mentioned...")
- Note any decisions made

**Disagreements / Open Questions:**
- Any unresolved items or different opinions expressed

---

### Decisions Made
List all decisions reached during the meeting.

Do not include a separate Action Items section in the notes. Use speaker names where available. Reference timestamps. Be thorough but concise.`
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

export async function generateNotes(apiKey, chunks, summaries = [], method = 'cornell', speakerNameMap = {}, screenCaptures = []) {
  const config = NOTE_METHODS[method] || NOTE_METHODS.cornell;

  const transcript = buildTranscriptForMode(chunks, method, speakerNameMap);

  const summaryCtx = summaries.length > 0
    ? '\n\nExisting summaries (for reference):\n' + summaries.map(s => s.summary_text).join('\n\n')
    : '';

  const screenCtx = buildScreenCaptureContext(screenCaptures);

  let prompt;
  if (method === 'meeting') {
    const speakerInfo = Object.keys(speakerNameMap).length > 0
      ? '\n\nSpeaker name mapping:\n' + Object.entries(speakerNameMap).map(([k, v]) => `${k} = ${v}`).join('\n')
      : '';
    prompt = `Generate comprehensive meeting notes from this transcript.${speakerInfo}${summaryCtx}${screenCtx}\n\nFull transcript:\n${transcript}`;
  } else {
    prompt = `Generate comprehensive notes from this lecture transcript. Use BOTH the audio transcript AND the screen capture data to create thorough notes. The screen captures contain text, slides, diagrams, and visual content that supplement the spoken content.${summaryCtx}${screenCtx}\n\nFull transcript:\n${transcript}`;
  }

  const content = await callAI(apiKey, config.system, prompt, {
    maxOutputTokens: 4096,
    thinkingLevel: 'medium',
  });

  return sanitizeGeneratedNotes(content);
}

export async function extractActionItems(apiKey, chunks, mode = 'lecture', speakerNameMap = {}, screenCaptures = []) {
  const method = mode === 'meeting' ? 'meeting' : 'lecture';
  const transcript = buildTranscriptForMode(chunks, method === 'meeting' ? 'meeting' : 'lecture', speakerNameMap);
  const screenCtx = buildScreenCaptureContext(screenCaptures);

  const system = mode === 'lecture'
    ? `You extract lecture-specific action items from class transcripts.

In lecture mode, an action item means something the STUDENTS / WHOLE CLASS should do, remember, submit, prepare, attend, read, or follow up on.
Good examples:
- quiz, exam, midterm, final, homework, assignment, project, lab, reading, deadline, due date
- complete a form or evaluation
- email the professor or TA
- come to office hours, bring something, sign up, register, upload, submit
- explicit reminders such as "remember to finish the evaluation form" or "make sure you read chapter 3 before Tuesday"

Do NOT treat general lecture content as an action item.
Do NOT include tasks assigned to a specific individual unless they clearly apply to the entire class.
Do NOT include the professor's own to-dos, planning remarks, examples, or generic advice unless the class is explicitly expected to act.

Return JSON only using this schema:
{
  "items": [
    {
      "text": "clear student-facing action item",
      "assignee": "students|class|everyone|you, if explicit",
      "deadline": "deadline/date/time, if explicit",
      "timestamp": "mm:ss",
      "source": "short supporting quote or paraphrase",
      "confidence": "high|medium"
    }
  ],
  "log": {
    "summary": "1-2 sentences summarizing the lecture extraction rule applied",
    "included": [
      {
        "timestamp": "mm:ss",
        "candidate": "candidate phrase",
        "decision": "included",
        "reason": "why it qualifies as a student-facing lecture action item"
      }
    ],
    "excluded": [
      {
        "timestamp": "mm:ss",
        "candidate": "candidate phrase",
        "decision": "excluded",
        "reason": "why it was excluded"
      }
    ]
  }
}`
    : `You extract concrete action items from meeting transcripts.

Include only future-facing tasks, deadlines, reminders, commitments, readings, deliverables, follow-ups, preparation items, and scheduled evaluations such as quizzes or exams.
Exclude background discussion, completed work, vague ideas, historical context, and general information with no action required.

Return JSON only using this schema:
{
  "items": [
    {
      "text": "clear action item",
      "assignee": "person or audience, if explicit",
      "deadline": "deadline/date/time, if explicit",
      "timestamp": "mm:ss",
      "source": "short supporting quote or paraphrase",
      "confidence": "high|medium"
    }
  ],
  "log": {
    "summary": "1-2 sentences summarizing the extraction rule applied",
    "included": [
      {
        "timestamp": "mm:ss",
        "candidate": "candidate phrase",
        "decision": "included",
        "reason": "why it qualifies as an action item"
      }
    ],
    "excluded": [
      {
        "timestamp": "mm:ss",
        "candidate": "candidate phrase",
        "decision": "excluded",
        "reason": "why it was excluded"
      }
    ]
  }
}`;

  const raw = await callAI(apiKey, system, `Transcript:
${transcript}${screenCtx}`, {
    maxOutputTokens: 2048,
    thinkingLevel: 'medium',
    responseMimeType: 'application/json',
  });

  const parsed = safeJsonParse(raw, { items: [], log: buildDefaultActionItemsLog([], mode) });
  const extractedItems = Array.isArray(parsed.items)
    ? parsed.items
        .filter(item => item && typeof item.text === 'string' && item.text.trim())
        .map(item => ({
          text: item.text.trim(),
          assignee: item.assignee ? String(item.assignee).trim() : '',
          deadline: item.deadline ? String(item.deadline).trim() : '',
          timestamp: item.timestamp ? String(item.timestamp).trim() : '',
          source: item.source ? String(item.source).trim() : '',
          confidence: item.confidence ? String(item.confidence).trim() : '',
        }))
    : [];

  const baseLog = parsed.log && typeof parsed.log === 'object'
    ? {
        summary: parsed.log.summary ? String(parsed.log.summary).trim() : buildDefaultActionItemsLog(extractedItems, mode).summary,
        included: Array.isArray(parsed.log.included) ? parsed.log.included : [],
        excluded: Array.isArray(parsed.log.excluded) ? parsed.log.excluded : [],
      }
    : buildDefaultActionItemsLog(extractedItems, mode);

  const normalized = mode === 'lecture'
    ? postProcessLectureActionItems(extractedItems, baseLog)
    : { items: extractedItems, log: baseLog };

  return {
    items: normalized.items,
    actionItemsMarkdown: formatActionItemsMarkdown(normalized.items),
    log: normalized.log,
  };
}
