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
        else if (b.type === 'image' && b.source?.data) parts.push({ inlineData: { mimeType: b.source.media_type || 'image/jpeg', data: b.source.data } });
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
const FAST = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
let goodModel = null; // the last model that worked on this server instance
const RETRY = new Set([404, 429, 500, 502, 503, 504]);
const slow = m => Object.assign(new Error(`Google took too long to answer on ${m}. Try again.`), { geminiStatus: 504 });

// Collects the pieces of an answer, whether it arrives all at once or as a stream.
const newAcc = () => ({ text: '', calls: [], finish: null, blocked: null });
function absorb(acc, j, onText) {
  if (j.promptFeedback?.blockReason) acc.blocked = j.promptFeedback.blockReason;
  const cand = j.candidates?.[0];
  if (!cand) return;
  for (const p of cand.content?.parts || []) {
    if (p.thought) continue;
    if (p.text) { acc.text += p.text; if (onText) onText(p.text); }
    else if (p.functionCall) acc.calls.push({ name: p.functionCall.name, args: p.functionCall.args || {}, sig: p.thoughtSignature });
  }
  if (cand.finishReason) acc.finish = cand.finishReason;
}
function toResult(acc, used) {
  if (acc.blocked) return { content: [], stop_reason: 'refusal', stop_details: { explanation: acc.blocked }, model: used };
  const content = [];
  if (acc.text) content.push({ type: 'text', text: acc.text });
  for (const c of acc.calls) content.push({ type: 'tool_use', id: 'call_' + Math.random().toString(36).slice(2, 12), name: c.name, input: c.args, ...(c.sig ? { gemini_sig: c.sig } : {}) });
  let stop = acc.calls.length ? 'tool_use' : 'end_turn';
  if (!acc.calls.length && acc.finish === 'MAX_TOKENS') stop = 'max_tokens';
  if (!acc.calls.length && !content.length && ['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST'].includes(acc.finish)) stop = 'refusal';
  return { content, stop_reason: stop, stop_details: null, model: used };
}
async function readStream(res, acc, onText) { // Server-Sent Events: lines that start with "data: "
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('data:')) { try { absorb(acc, JSON.parse(line.slice(5).trim()), onText); } catch { /* ignore a broken line */ } }
    }
    if (done) break;
  }
  const rest = buf.trim();
  if (rest.startsWith('data:')) { try { absorb(acc, JSON.parse(rest.slice(5).trim()), onText); } catch {} }
}

// options: onText(delta) streams the answer as it is written; fast=true prefers a small, quick model with little thinking.
export async function geminiChat({ system, tools, messages, apiKey, model, fetchImpl = fetch, onText, fast = false }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toContents(messages),
    ...(tools.some(t => t.input_schema) ? { tools: [{ functionDeclarations: tools.filter(t => t.input_schema).map(toDecl) }] } : {}),
    // Newer Gemini models "think" before answering, which can take very long. Ask for little thinking.
    generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: fast ? 'minimal' : 'low' } }
  };
  const deadline = Date.now() + 52000;
  const stream = typeof onText === 'function';
  const call = async m => {
    const left = deadline - Date.now();
    if (left < 4000) throw slow(m);
    const url = `${BASE}/${m}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    try { return await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(left, 30000)) }); }
    catch (e) { if (e && e.name === 'TimeoutError') throw slow(m); throw Object.assign(new Error('Could not reach Google: ' + (e && e.message)), { geminiStatus: 504 }); }
  };

  const order = [...new Set([...(fast ? FAST : []), goodModel, model, ...CANDIDATES].filter(Boolean))];
  let res, used, lastErr, j;
  for (const m of order) {
    try {
      res = await call(m);
      if (res.status === 400) {
        j = await (res.clone ? res.clone() : res).json().catch(() => ({}));
        if (/think/i.test(j.error?.message || '')) { delete body.generationConfig.thinkingConfig; res = await call(m); } // this model doesn't take that setting
      }
    } catch (e) { lastErr = e; if (e.geminiStatus === 504 && Date.now() >= deadline - 4000) break; continue; }
    if (res.ok) { used = m; break; }
    j = await res.json().catch(() => ({}));
    lastErr = Object.assign(new Error(j.error?.message || `Gemini returned ${res.status}`), { geminiStatus: res.status });
    if (!RETRY.has(res.status)) break; // e.g. a bad key (400/403): another model won't help
  }
  if (!used) throw lastErr || slow(model);
  const acc = newAcc();
  try {
    if (stream) await readStream(res, acc, onText);
    else absorb(acc, await res.json().catch(() => ({})));
  } catch (e) {
    if (acc.text || acc.calls.length) { /* keep what arrived */ }
    else throw Object.assign(new Error(e && e.name === 'TimeoutError' ? `Google took too long to answer on ${used}. Try again.` : 'The answer was cut off: ' + (e && e.message)), { geminiStatus: 504 });
  }
  if (!fast) goodModel = used; // a quick small model is not the one to remember for hard requests
  return toResult(acc, used);
}
export const _test = { toContents };
