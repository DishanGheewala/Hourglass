// POST /api/chat: the assistant endpoint. The real work is in _chat.js; this thin wrapper makes sure any
// start-up failure comes back as a readable message instead of a bare "500".
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const impl = await import('./_chat.js');
    return await impl.default(req, res);
  } catch (err) {
    console.error('chat failed', err);
    if (!res.headersSent) res.status(500).json({ error: 'The AI server hit a problem: ' + (err && err.message ? err.message : String(err)).slice(0, 300) });
  }
}
