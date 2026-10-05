import { generateText } from 'ai';

const SUPABASE_URL = 'https://firnmcqtjprckgqdcplg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_oG0bcYmr6nijxKeY02U0YA_iHnp79gZ';
const MODEL = 'openai/gpt-5.6-sol';

async function supabaseCall(path, token, body = {}) {
  const r = await fetch(SUPABASE_URL + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(typeof data === 'string' ? data : (data?.message || data?.error || 'Supabase request failed'));
  return data;
}

async function getUser(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + token }
  });
  if (!r.ok) return null;
  const user = await r.json();
  return user?.id ? user : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sign in first.' });

    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Session expired. Sign in again.' });

    const message = String(req.body?.message || '').trim().slice(0, 2500);
    if (!message) return res.status(400).json({ error: 'Write a message first.' });

    const history = Array.isArray(req.body?.history)
      ? req.body.history.slice(-8).map((m) => ({
          role: m?.role === 'assistant' ? 'assistant' : 'user',
          content: String(m?.content || '').slice(0, 1800)
        })).filter((m) => m.content)
      : [];

    const isOwner = await supabaseCall('/rest/v1/rpc/is_site_owner', token, {});
    const allowed = await supabaseCall('/rest/v1/rpc/consume_ai_request', token, { p_limit: 20 });
    if (!allowed) return res.status(429).json({ error: 'Daily assistant limit reached. The site owner has unlimited app access.' });

    const context = JSON.stringify(req.body?.context || {}).slice(0, 14000);
    const system = [
      'You are the embedded assistant inside Hamza Tracker.',
      'Be concise, direct, and practical. Use the tracker context when relevant.',
      'Never pretend the tracker contains data that is not in the provided context.',
      'College and German are attendance-based; Study and Training are hour-based.',
      'Treat missing/unconfirmed data as missing, not zero.',
      'Do not reveal or infer other users private data.',
      'The user is a teenager: do not provide explicit sexual content, self-harm descriptions, dangerous-activity instructions, or restrictive body/weight advice.',
      isOwner === true ? 'The signed-in user is the site owner. They have no app-level assistant request limit.' : 'The signed-in user is a normal site user.',
      'Current tracker context (JSON): ' + context
    ].join(' ');

    const result = await generateText({
      model: MODEL,
      system,
      messages: [
        ...history,
        { role: 'user', content: message }
      ],
      maxOutputTokens: 700
    });

    const reply = result?.text;
    if (!reply) return res.status(502).json({ error: 'The assistant returned no text.' });

    return res.status(200).json({ reply, model: MODEL, owner: isOwner === true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Assistant error' });
  }
}
