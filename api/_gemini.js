// Free-tier option: runs the assistant on Google's Gemini API instead of Anthropic's.
// The browser keeps one conversation format (Anthropic-style blocks); this file translates it.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const toDecl = t => ({ name: t.name, description: t.description, parameters: t.input_schema });

function toContents(messages) {
  const names = {}; // tool_use id -> function name, so results can be matched
  const out = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else out.push({ role, parts: [...parts] });
  };
  for (const m of messages) {
    if (m.role === 'assistant') {
      const parts = [];
      for (const b of Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') {
          names[b.id] = b.name;
          parts.push({ functionCall: { name: b.name, args: b.input || {} }, ...(b.gemini_sig ? { thoughtSignature: b.gemini_sig } : {}) });
        }
      }
      push('model', parts);
    } else {
      const parts = [];
      if (m.role === 'system') parts.push({ text: `[Context from the app]\n${m.content}` });
      else for (const b of Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_result') {
          let v = b.content;
          if (Array.isArray(v)) v = v.map(x => x.text || '').join('\n');
          try { v = JSON.parse(v); } catch {}
          parts.push({ functionResponse: { name: names[b.tool_use_id] || 'tool', response: b.is_error ? { error: String(v) } : { result: v } } });
        }
      }
      push('user', parts);
    }
  }
  return out;
}

// Google's models are sometimes busy (503), over quota (429) or retired (404). Try the next one.
const CANDIDATES = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
let goodModel = null; // the last model that worked on this server instance
const RETRY = new Set([404, 429, 500, 502, 503, 504]);
const slow = m => Object.assign(new Error(`Google took too long to answer on ${m}. Try again.`), { geminiStatus: 504 });

export async function geminiChat({ system, tools, messages, apiKey, model, fetchImpl = fetch }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toContents(messages),
    ...(tools.some(t => t.input_schema) ? { tools: [{ functionDeclarations: tools.filter(t => t.input_schema).map(toDecl) }] } : {}),
    // Newer Gemini models "think" before answering, which can take very long. Ask for little thinking.
    generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } }
  };
  const deadline = Date.now() + 52000;
  const call = async m => {
    const left = deadline - Date.now();
    if (left < 4000) throw slow(m);
    try { return await fetchImpl(`${BASE}/${m}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(left, 22000)) }); }
    catch (e) { if (e && e.name === 'TimeoutError') throw slow(m); throw Object.assign(new Error('Could not reach Google: ' + (e && e.message)), { geminiStatus: 504 }); }
  };

  const order = [...new Set([goodModel, model, ...CANDIDATES].filter(Boolean))];
  let j, res, used, lastErr;
  for (const m of order) {
    try {
      res = await call(m);
      j = await res.json().catch(() => ({}));
      if (res.status === 400 && /think/i.test(j.error?.message || '')) { // this model doesn't take that setting
        delete body.generationConfig.thinkingConfig;
        res = await call(m);
        j = await res.json().catch(() => ({}));
      }
    } catch (e) { lastErr = e; if (e.geminiStatus === 504 && Date.now() >= deadline - 4000) break; continue; }
    if (res.ok) { used = m; break; }
    lastErr = Object.assign(new Error(j.error?.message || `Gemini returned ${res.status}`), { geminiStatus: res.status });
    if (!RETRY.has(res.status)) break; // e.g. a bad key (400/403): another model won't help
  }
  if (!used) throw lastErr || slow(model);
  goodModel = used;
  const cand = j.candidates?.[0];
  if (!cand || j.promptFeedback?.blockReason) return { content: [], stop_reason: 'refusal', stop_details: { explanation: j.promptFeedback?.blockReason || 'blocked' } };
  const content = [];
  let calls = 0;
  for (const p of cand.content?.parts || []) {
    if (p.thought) continue;
    if (p.text) content.push({ type: 'text', text: p.text });
    else if (p.functionCall) {
      calls++;
      content.push({ type: 'tool_use', id: 'call_' + Math.random().toString(36).slice(2, 12), name: p.functionCall.name, input: p.functionCall.args || {}, ...(p.thoughtSignature ? { gemini_sig: p.thoughtSignature } : {}) });
    }
  }
  let stop = calls ? 'tool_use' : 'end_turn';
  if (!calls && cand.finishReason === 'MAX_TOKENS') stop = 'max_tokens';
  if (!calls && !content.length && ['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST'].includes(cand.finishReason)) stop = 'refusal';
  return { content, stop_reason: stop, stop_details: null, model: used };
}
export const _test = { toContents };
