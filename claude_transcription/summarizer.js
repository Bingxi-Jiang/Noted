// summarizer.js — Rolling summaries & Q&A via Anthropic Claude API

/**
 * Calls Anthropic Messages API.
 */
async function callClaude(apiKey, systemPrompt, userMessage, maxTokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content.map(b => b.text || '').join('\n');
}


/**
 * Generate a rolling summary of transcript chunks.
 */
export async function generateRollingSummary(apiKey, chunks, previousSummary = null) {
  const transcript = chunks.map(c => {
    const mins = Math.floor(c.start_time / 60);
    const secs = Math.floor(c.start_time % 60);
    return `[${mins}:${String(secs).padStart(2, '0')}] ${c.text}`;
  }).join('\n');

  const system = `You are a lecture/meeting note-taker. Create concise, well-structured summaries.
Include key concepts, definitions, important points, and any action items.
Use bullet points for clarity. Keep summaries focused and information-dense.
If a previous summary is provided, build upon it — don't repeat, just add new information.`;

  const prompt = previousSummary
    ? `Previous summary:\n${previousSummary}\n\n---\nNew transcript to incorporate:\n${transcript}\n\nUpdate the summary with the new content. Don't repeat old points unless they've been expanded on.`
    : `Summarize the following transcript:\n${transcript}`;

  return callClaude(apiKey, system, prompt);
}


/**
 * Detect if a topic change occurred in recent chunks.
 * Returns { changed: boolean, newTopic: string, summary: string }
 */
export async function detectTopicChange(apiKey, recentChunks, previousTopicLabel = '') {
  const transcript = recentChunks.map(c => c.text).join(' ');

  const system = `You analyze lecture/meeting transcripts to detect topic changes.
Respond ONLY in valid JSON with this exact structure:
{"changed": true/false, "topic": "topic label", "summary": "brief summary if changed"}
No markdown, no backticks, just JSON.`;

  const prompt = `Previous topic: "${previousTopicLabel || 'none yet'}"

Recent transcript:
"${transcript}"

Has the speaker moved to a significantly different topic? If so, what is the new topic and a brief summary of what they covered?`;

  const raw = await callClaude(apiKey, system, prompt, 300);

  try {
    return JSON.parse(raw.trim());
  } catch {
    return { changed: false, topic: previousTopicLabel, summary: '' };
  }
}


/**
 * Answer a question based on transcript context (RAG).
 */
export async function answerQuestion(apiKey, question, relevantChunks, summaries = []) {
  const context = relevantChunks.map(c => {
    const mins = Math.floor(c.start_time / 60);
    const secs = Math.floor(c.start_time % 60);
    return `[${mins}:${String(secs).padStart(2, '0')}] ${c.text}`;
  }).join('\n');

  const summaryContext = summaries.length > 0
    ? '\n\nAvailable summaries:\n' + summaries.map(s =>
        `[${s.summary_type}${s.topic_label ? ` - ${s.topic_label}` : ''}] ${s.summary_text}`
      ).join('\n\n')
    : '';

  const system = `You are a helpful assistant answering questions about a lecture/meeting.
You have access to the transcript with timestamps and summaries.
When answering:
- Reference specific timestamps when possible (e.g., "Around 5:30, the speaker mentioned...")
- Be precise and cite the transcript
- If the answer isn't in the provided context, say so clearly
- Keep answers concise but complete`;

  const prompt = `Transcript context:\n${context}${summaryContext}\n\n---\nQuestion: ${question}`;

  return callClaude(apiKey, system, prompt, 1024);
}
