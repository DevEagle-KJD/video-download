// POST /api/phrase-quick {id}: the quick first answer for "Say it like a native",
// in a few seconds, while the full check (GitHub "Web phrase" workflow: real-video
// matches, a second native review, stress marks, word meanings, voices) runs.
// Same instructions as scripts/study/phrase.py (GEN_SYSTEM), so both agree. The
// answer is saved as lessons/<id>/quick.json so it survives a reload.
import Anthropic from '@anthropic-ai/sdk';
import { env, send, db, currentUser } from './_lib.js';

const MODEL = env('QUICK_MODEL') || 'claude-opus-5-5';

// Copied from scripts/study/phrase.py GEN_SYSTEM. Keep the two in step.
const SYSTEM = "You are a native Russian speaker helping an English speaker learn to talk like a native through real sentences, never grammar lessons.\n\nThe learner tells you something they want to be able to say: usually in English, sometimes in Russian they heard or wrote themselves.\nReturn how native Russians actually say it in everyday conversation today:\n- 1 to 3 ways of saying it. Prefer what people really say out loud over textbook phrasing. When casual and polite speech differ, give a version for friends/family and a polite one for strangers, work and older people; give a single version when one fits everywhere.\n- Russian words often change with who is speaking or who is listening (ты спал / ты спала, я рад / я рада, ты готов / ты готова). Whenever a version's wording depends on that, give each form as its own version (same context, en and note) and set who:\n  - \"to a man\" / \"to a woman\" when it depends on the person you're talking to;\n  - \"if you're a man\" / \"if you're a woman\" when it depends on the speaker;\n  - \"if you're a man, to a woman\" (and so on) only when it depends on both.\n  Polite вы forms and plural forms are the same for everyone, so they get who \"\". Use who \"\" whenever the wording is the same for anyone. Never leave out the woman's form.\n- For each version:\n  - ru: the Russian, with normal punctuation and no stress marks;\n  - context: \"with friends\", \"with strangers\" (the polite вы form) or \"anywhere\";\n  - who: as above, or \"\";\n  - en: what it means, in natural English. A polite вы version speaks to one person, so never write \"you all\" unless the learner meant a group;\n  - note: a short tip on when natives use it (at most 15 words, no grammar terms); \"\" if nothing useful to add;\n  - confidence: \"high\" if natives commonly say exactly this, \"medium\" if it's natural but equally common alternatives exist, \"low\" if you're unsure.\n- If the learner wrote Russian, also fill check: verdict \"natural\", \"understandable but not natural\" or \"wrong\", and a one-line comment in English. Include their wording as a version only if natives would really say it.\n- If the learner wrote English, return check with verdict \"\" and comment \"\".\nNever invent slang you're not sure of. If the request is ambiguous, use the most common meaning and mention it in a note.";

const SCHEMA = {
  type: 'object',
  properties: {
    versions: { type: 'array', items: { type: 'object', properties: {
      ru: { type: 'string' }, context: { type: 'string' }, who: { type: 'string' },
      en: { type: 'string' }, note: { type: 'string' }, confidence: { type: 'string' } },
      required: ['ru', 'context', 'who', 'en', 'note', 'confidence'], additionalProperties: false } },
    check: { type: 'object', properties: { verdict: { type: 'string' }, comment: { type: 'string' } },
      required: ['verdict', 'comment'], additionalProperties: false },
  },
  required: ['versions', 'check'],
  additionalProperties: false,
};

function storageHeaders() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(body.id || '');
    if (!/^ph-[a-z0-9]{8,32}$/.test(id)) return send(res, 400, { error: 'Unknown phrase.' });
    const [row] = await db(`phrases?id=eq.${id}&user_id=eq.${user.id}&select=text`);
    if (!row) return send(res, 404, { error: 'Unknown phrase.' });
    if (!env('ANTHROPIC_API_KEY')) return send(res, 503, { error: 'Quick answers are not switched on.' });

    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `The learner wants to say: ${row.text}` }],
    });
    if (response.stop_reason === 'refusal') return send(res, 422, { error: 'No quick answer for this one.' });
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const out = JSON.parse(text);
    const quick = { input: row.text, check: out.check, versions: out.versions.slice(0, 8), at: new Date().toISOString() };

    // Keep it for reloads (public bucket, next to where the full lesson.json will go).
    await fetch(`${env('SUPABASE_URL')}/storage/v1/object/lessons/${id}/quick.json`, {
      method: 'POST',
      headers: { ...storageHeaders(), 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(quick),
    }).catch(() => {});
    return send(res, 200, { quick });
  } catch (e) {
    console.error(e);
    return send(res, 502, { error: 'No quick answer right now; the full answer is on its way.' });
  }
}
