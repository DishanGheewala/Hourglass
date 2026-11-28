// GET /api/ai-status: shows which AI the server will use. Never reveals any key.
// GET /api/ai-status?test=1: also makes one tiny test call to Gemini and reports what Google said and how long it took.
export default async function handler(req, res) {
  const has = n => !!process.env[n];
  const provider = process.env.AI_PROVIDER || (has('ANTHROPIC_API_KEY') ? 'anthropic' : has('GEMINI_API_KEY') ? 'gemini' : null);
  const out = {
    provider,
    ANTHROPIC_API_KEY_set: has('ANTHROPIC_API_KEY'),
    GEMINI_API_KEY_set: has('GEMINI_API_KEY'),
    GEMINI_API_KEY_length: (process.env.GEMINI_API_KEY || '').length,
    gemini_model: (/^[a-z0-9.-]+$/.test(req.query.model || '') ? req.query.model : null) || process.env.GEMINI_MODEL || 'gemini-flash-latest',
    node: process.version,
    deployment: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null,
    vercel_env: process.env.VERCEL_ENV || null
  };
  if (req.query.test && has('GEMINI_API_KEY')) {
    const base = 'https://generativelanguage.googleapis.com/v1beta/models';
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY };
    const t0 = Date.now();
    try {
      const { geminiChat } = await import('./_gemini.js');
      const r = await geminiChat({ system: 'You are a helpful assistant. Keep replies short.', tools: [], messages: [{ role: 'user', content: 'Say hi in three words.' }], apiKey: process.env.GEMINI_API_KEY, model: out.gemini_model });
      out.test = { status: 200, ms: Date.now() - t0, reply: r.content.map(c => c.text).filter(Boolean).join(' ').slice(0, 80) };
    } catch (e) { out.test = { status: e.geminiStatus || null, error: `${e.name}: ${String(e.message).slice(0, 200)}`, ms: Date.now() - t0 }; }
    try {
      const r = await fetch(`${base}?pageSize=200`, { headers, signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => ({}));
      out.models = { status: r.status, flash: (j.models || []).map(m => m.name.replace('models/', '')).filter(n => /flash/.test(n) && !/image|tts|live|audio/.test(n)).slice(0, 12), error: j.error?.message?.slice(0, 160) };
    } catch (e) { out.models = { error: `${e.name}: ${e.message}` }; }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
