// Provider adapters. API keys are used only by the server.
async function post(url, headers, body, provider) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(data.error?.message || response.statusText).replaceAll(headers['x-goog-api-key'] || headers['x-api-key'] || headers.Authorization?.replace('Bearer ', '') || 'NO_KEY', '[redacted]');
    throw new Error(`${provider} API error ${response.status}: ${message}`);
  }
  return data;
}

export async function generateAI(config, systemPrompt, userMessage, { maxOutputTokens = 1024, thinkingLevel = 'low', responseMimeType, imageBase64, mimeType = 'image/jpeg' } = {}) {
  // Retain compatibility for callers that previously supplied a Gemini key.
  if (typeof config === 'string') config = { provider: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-3.8-flash', apiKey: config };
  const { provider, model, apiKey } = config;
  if (!apiKey || /^(your_|replace_|<)/i.test(apiKey)) throw new Error(`Missing ${provider} API key. Configure .env and restart Noted.`);
  let text;
  if (provider === 'gemini') {
    const parts = [];
    if (imageBase64) parts.push({ inlineData: { mimeType, data: imageBase64 } });
    parts.push({ text: userMessage });
    const generationConfig = { maxOutputTokens };
    if (/^gemini-3/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: thinkingLevel === 'minimal' ? 'low' : thinkingLevel };
    if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
    const data = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': apiKey }, {
      systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: 'user', parts }], generationConfig,
    }, 'Gemini');
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') throw new Error('Gemini output was truncated. Try a shorter transcript or another model.');
    text = candidate?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('');
  } else if (provider === 'openai') {
    const content = [{ type: 'input_text', text: userMessage }];
    if (imageBase64) content.unshift({ type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}`, detail: 'auto' });
    const body = { model, instructions: systemPrompt, input: [{ role: 'user', content }], max_output_tokens: maxOutputTokens, store: false };
    if (/^(gpt-6|gpt-5|o[134])/.test(model)) {
      body.reasoning = { effort: thinkingLevel === 'minimal' ? 'low' : thinkingLevel };
      // Responses counts internal reasoning against the same output limit.
      body.max_output_tokens += thinkingLevel === 'medium' ? 8192 : 4096;
    }
    if (responseMimeType === 'application/json') body.text = { format: { type: 'json_object' } };
    const data = await post('https://api.openai.com/v1/responses', { Authorization: `Bearer ${apiKey}` }, body, 'OpenAI');
    if (data.status === 'incomplete') throw new Error('OpenAI output was incomplete. Try a shorter transcript or another model.');
    text = data.output?.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
  } else if (provider === 'claude') {
    const content = [];
    if (imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } });
    content.push({ type: 'text', text: userMessage });
    const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, {
      model, system: systemPrompt, messages: [{ role: 'user', content }], max_tokens: maxOutputTokens,
    }, 'Claude');
    if (data.stop_reason === 'max_tokens') throw new Error('Claude output was truncated. Try a shorter transcript or another model.');
    text = data.content?.filter(item => item.type === 'text').map(item => item.text).join('');
  } else throw new Error(`Unsupported AI provider: ${provider}`);
  if (!text?.trim()) throw new Error(`${provider} returned an empty or blocked response.`);
  return text.trim();
}
