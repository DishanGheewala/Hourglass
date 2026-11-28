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

// If the configured model has been retired (404), find a current Gemini Flash model on this key and use that.
let fallbackModel = null;
async function findFlashModel(apiKey, fetchImpl) {
  const res = await fetchImpl(`${BASE}?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) return null;
  const j = await res.json().catch(() => ({}));
  const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /^models\/gemini-(flash-latest|[\d.]+-flash)$/.test(m.name));
  const latest = ok.find(m => m.name === 'models/gemini-flash-latest');
  if (latest) return 'gemini-flash-latest';
  ok.sort((a, b) => parseFloat(b.name.match(/gemini-([\d.]+)/)[1]) - parseFloat(a.name.match(/gemini-([\d.]+)/)[1]));
  return ok[0] ? ok[0].name.replace('models/', '') : null;
}

export async function geminiChat({ system, tools, messages, apiKey, model, fetchImpl = fetch }) {
  model = fallbackModel || model;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toContents(messages),
    ...(tools.some(t => t.input_schema) ? { tools: [{ functionDeclarations: tools.filter(t => t.input_schema).map(toDecl) }] } : {}),
    // Newer Gemini models "think" before answering, which can take very long. Ask for little thinking.
    generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } }
  };
  const call = m => fetchImpl(`${BASE}/${m}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(50000) });
  let res;
  try { res = await call(model); }
  catch (e) { throw Object.assign(new Error(e && e.name === 'TimeoutError' ? `Google took too long to answer on ${model}. Try again.` : 'Could not reach Google: ' + (e && e.message)), { geminiStatus: 504 }); }
  if (res.status === 404 && !fallbackModel) {
    const alt = await findFlashModel(apiKey, fetchImpl).catch(() => null);
    if (alt && alt !== model) {
      fallbackModel = alt; model = alt;
      try { res = await call(model); }
      catch (e) { throw Object.assign(new Error(e && e.name === 'TimeoutError' ? `Google took too long to answer on ${model}. Try again.` : 'Could not reach Google: ' + (e && e.message)), { geminiStatus: 504 }); }
    }
  }
  let j = await res.json().catch(() => ({}));
  if (res.status === 400 && /think/i.test(j.error?.message || '')) {
    delete body.generationConfig.thinkingConfig;
    try { res = await call(model); } catch (e) { throw Object.assign(new Error(e && e.name === 'TimeoutError' ? `Google took too long to answer on ${model}. Try again.` : 'Could not reach Google: ' + (e && e.message)), { geminiStatus: 504 }); }
    j = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw Object.assign(new Error(j.error?.message || `Gemini returned ${res.status}`), { geminiStatus: res.status });
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
  return { content, stop_reason: stop, stop_details: null };
}
export const _test = { toContents };
