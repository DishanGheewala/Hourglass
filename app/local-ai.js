// Free on-device AI: a small open model (Qwen2.5) that runs inside the browser with WebGPU, via WebLLM.
// No account, no key, no cost, and the chat never leaves the device. It is much simpler than the full
// cloud AI. Used automatically when the server has no AI key. Needs a recent Chrome or Edge.
const WEBLLM = 'https://esm.run/@mlc-ai/web-llm@0.2.89';
const CONTEXT_CHARS = 2600; // app context given to the model
const HISTORY_CHARS = 5200; // recent conversation kept (the model reads about 4,000 tokens in total)
const TOOL_RESULT_CHARS = 2200;

let engine = null, loading = null;
export const supported = () => typeof navigator !== 'undefined' && !!navigator.gpu;
export const isReady = () => !!engine;

async function pickModel() {
  let f16 = false;
  try { f16 = !!(await navigator.gpu.requestAdapter())?.features?.has('shader-f16'); } catch {}
  const small = navigator.deviceMemory && navigator.deviceMemory < 4;
  return `Qwen2.5-${small ? '0.5B' : '1.5B'}-Instruct-${f16 ? 'q4f16_1' : 'q4f32_1'}-MLC`;
}

export function load(onProgress) {
  if (engine) return Promise.resolve(engine);
  if (!loading) {
    loading = (async () => {
      const webllm = await import(WEBLLM);
      const id = await pickModel();
      engine = await webllm.CreateMLCEngine(id, { initProgressCallback: r => onProgress?.(r) });
      return engine;
    })().catch(e => { engine = null; throw e; }).finally(() => { loading = null; });
  }
  return loading;
}

export async function generate(messages, { onToken, maxTokens = 650 } = {}) {
  const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.5, top_p: 0.9, max_tokens: maxTokens });
  let text = '';
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta?.content;
    if (d) { text += d; onToken?.(text); }
  }
  return text;
}

// ---------- tools (compact versions of the full tools; the app runs them in the browser) ----------
const S = d => ({ type: 'string', description: d });
const DATE = S('YYYY-MM-DD');
const CAT = { type: 'string', enum: ['sleep', 'work', 'free'] };
const T = {
  log_time: ['Save time for a category on a day (replaces the old entry). rating: sleepiness 1-10 for sleep, productivity 1-10 for work.', { category: CAT, date: DATE, hours: { type: 'number' }, rating: { type: 'integer' } }, ['category', 'date', 'hours']],
  delete_log: ['Delete a day\'s log.', { category: CAT, date: DATE }, ['category', 'date']],
  add_deadline: ['Add a deadline to the calendar.', { title: S('What is due'), date: DATE, time: S('Optional HH:MM, 24-hour') }, ['title', 'date']],
  list_deadlines: ['List deadlines with their ids.', {}, []],
  delete_deadline: ['Delete a deadline by id.', { id: S('id from list_deadlines') }, ['id']],
  set_reminders: ['Replace the daily reminder alerts with this full list.', { alerts: { type: 'array', items: { type: 'object', properties: { time: S('HH:MM, 24-hour'), label: S('Message') }, required: ['time'] } } }, ['alerts']],
  remember: ['Save one short lasting fact about the student.', { note: S('One short fact') }, ['note']],
  forget: ['Delete a saved note.', { note: S('Exact text of the note') }, ['note']],
  show_quiz: ['Show a practice quiz (up to 6 questions). Answers are shown only after the student submits.', { title: S('Quiz title'), questions: { type: 'array', items: { type: 'object', properties: { question: S('Question about a real situation'), choices: { type: 'array', items: { type: 'string' } }, answer: S('Correct answer, exactly one of the choices'), explanation: S('Why it is right') }, required: ['question', 'answer', 'explanation'] } } }, ['title', 'questions']],
  draft_email: ['Show the student a finished email with a Send button. Nothing is sent until they press Send.', { to: S('Recipient address'), subject: S('Clear subject'), body: S('Full email: greeting, body, closing and name') }, ['to', 'subject', 'body']],
  gmail_search: ['Search Gmail (Gmail search syntax).', { query: S('Search query'), max_results: { type: 'integer' } }, ['query']],
  gmail_read: ['Read one Gmail message.', { message_id: S('id from gmail_search') }, ['message_id']],
  calendar_list_events: ['List Google Calendar events.', { start_date: DATE, end_date: DATE }, ['start_date', 'end_date']],
  calendar_create_event: ['Create a Google Calendar event.', { title: S('Title'), date: DATE, start_time: S('HH:MM'), end_time: S('HH:MM') }, ['title', 'date']],
  drive_search: ['Search Google Drive files (Docs, Slides, Sheets, PDF, Word, PowerPoint).', { query: S('Words to find'), type: { type: 'string', enum: ['any', 'doc', 'slides', 'sheet', 'pdf', 'word', 'powerpoint', 'folder'] } }, []],
  drive_read_file: ['Read a Drive file (only the start is shown to you).', { file_id: S('id from drive_search') }, ['file_id']],
  drive_create_doc: ['Save text as a new Google Doc.', { title: S('Title'), content: S('Text') }, ['title', 'content']]
};
const NEEDS = { gmail: ['draft_email', 'gmail_search', 'gmail_read'], calendar: ['calendar_list_events', 'calendar_create_event'], drive: ['drive_search', 'drive_read_file', 'drive_create_doc'] };
const GATED = new Set(Object.values(NEEDS).flat());

export function toolNames(linked = {}) {
  const on = new Set(Object.keys(NEEDS).filter(k => linked[k]).flatMap(k => NEEDS[k]));
  return Object.keys(T).filter(n => !GATED.has(n) || on.has(n));
}
function toolsBlock(linked) {
  return toolNames(linked).map(n => JSON.stringify({ type: 'function', function: { name: n, description: T[n][0], parameters: { type: 'object', properties: T[n][1], required: T[n][2] } } })).join('\n');
}

const SYSTEM = `You are the assistant inside Hourglass, an app that helps teenagers handle stress and manage their time ("Make every hour count"). Students log sleep, study/work and free time, and keep deadlines.
Talk like a friendly, clear helper in normal sentences. Keep answers short. If asked why, explain your reasoning. Encourage healthy habits (teens need about 8-10 hours of sleep) without lecturing.
Use the app context below for facts about the student. Never make up data. Never say you did something unless you called the tool and got a result.
You are not a doctor or therapist. If a student mentions self-harm, suicide, abuse or danger, respond with care, urge them to talk to a trusted adult or school counselor, and say that in the US they can call or text 988 any time.
To take an action, reply with ONLY the tool call(s), in exactly this format, and nothing else:
<tool_call>
{"name": "tool_name", "arguments": {"argument": "value"}}
</tool_call>
Dates are YYYY-MM-DD; work out words like "tomorrow" from today's date in the context. After a tool result arrives, tell the student what happened in plain words.
Emails: write a complete polished email: clear subject, greeting ("Dear Ms. Lee,"), short organized body with correct grammar and spelling, closing "Best regards," and the student's name. Use draft_email; the student reviews and presses Send.`;

// ---------- building the prompt for a small model ----------
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n…(shortened)' : String(s));

export function toChat(messages) {
  const out = [];
  const push = (role, content) => {
    if (!content) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + content; else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    if (m.role === 'assistant') {
      let t = '';
      for (const b of blocks) {
        if (b.type === 'text' && b.text) t += (t ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') t += `\n<tool_call>\n${JSON.stringify({ name: b.name, arguments: b.input || {} })}\n</tool_call>`;
      }
      push('assistant', t.trim());
    } else {
      for (const b of blocks) {
        if (b.type === 'text') push('user', b.text);
        else if (b.type === 'tool_result') push('user', `<tool_response>\n${clip(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), TOOL_RESULT_CHARS)}\n</tool_response>`);
      }
    }
  }
  return out;
}

export function buildPrompt(messages, linked = {}) {
  const ctx = [...messages].reverse().find(m => m.role === 'system');
  const system = `${SYSTEM}\n\n# Tools\n<tools>\n${toolsBlock(linked)}\n</tools>\n\n# App context\n${clip(ctx ? ctx.content : '', CONTEXT_CHARS)}`;
  let chat = toChat(messages);
  const size = () => chat.reduce((n, m) => n + m.content.length, 0);
  while (chat.length > 1 && size() > HISTORY_CHARS) chat.shift();
  while (chat.length && (chat[0].role !== 'user' || chat[0].content.startsWith('<tool_response>'))) chat.shift();
  if (!chat.length) chat = [{ role: 'user', content: 'Hello' }];
  const last = chat[chat.length - 1];
  if (last.content.length > HISTORY_CHARS) last.content = clip(last.content, HISTORY_CHARS);
  return [{ role: 'system', content: system }, ...chat];
}

// ---------- reading the model's reply ----------
export function parseOutput(raw) {
  const calls = [];
  const text = String(raw).replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (m, j) => {
    try {
      const o = JSON.parse(j.trim());
      if (o && typeof o.name === 'string') {
        let args = o.arguments ?? o.parameters ?? {};
        if (typeof args === 'string') args = JSON.parse(args);
        calls.push({ name: o.name, input: args && typeof args === 'object' ? args : {} });
      }
    } catch { /* unreadable call: drop it */ }
    return '';
  }).replace(/<\/?tool_call>/g, '').trim();
  return { text, calls };
}
