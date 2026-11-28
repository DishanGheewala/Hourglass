// GET /api/ai-status: shows which AI the server will use. Never reveals any key.
export default function handler(req, res) {
  const has = n => !!process.env[n];
  const provider = process.env.AI_PROVIDER || (has('ANTHROPIC_API_KEY') ? 'anthropic' : has('GEMINI_API_KEY') ? 'gemini' : null);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    provider,
    ANTHROPIC_API_KEY_set: has('ANTHROPIC_API_KEY'),
    GEMINI_API_KEY_set: has('GEMINI_API_KEY'),
    GEMINI_API_KEY_length: (process.env.GEMINI_API_KEY || '').length,
    gemini_model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    node: process.version,
    deployment: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null,
    vercel_env: process.env.VERCEL_ENV || null
  });
}
