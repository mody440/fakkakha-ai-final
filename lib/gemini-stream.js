const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function streamGemini(systemPrompt, parts, opts = {}, onText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured on the server');
  const model = opts.model || process.env.GEMINI_MODEL_SMART || 'gemini-3.8-flash';
  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { responseMimeType: 'text/plain', temperature: opts.temperature ?? 0.4 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' }
    ]
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 30000);
  let res;
  try {
    res = await fetch(`${BASE}/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body), signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw new Error('NETWORK_ERROR');
  } finally { clearTimeout(timer); }
  if (!res.ok || !res.body) throw new Error(`GEMINI_STREAM_ERROR_${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const data = JSON.parse(raw);
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (text) { fullText += text; await onText(text); }
      } catch (_) { /* ignore malformed keep-alive chunks */ }
    }
  }
  return fullText;
}

module.exports = { streamGemini };
