// POST /api/lesson {id}: a video lesson's content for the signed-in user. Free
// users get the first FREE_SENTENCES sentences (the rest is never sent, so it
// can't be read some other way); Pro and admins get the whole lesson.
import { send, currentUser, planOf, lessonFile, bibleAccess, FREE_SENTENCES } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(body.id || '');
    if (/^bv-[a-z0-9-]{5,30}$/.test(id)) {          // a Bible verse (Bible section only)
      if (!bibleAccess(user)) return send(res, 403, { error: 'Unknown lesson.' });
      const data = await lessonFile(id);
      if (!data) return send(res, 404, { error: 'Couldn’t load the verse.' });
      res.setHeader('Cache-Control', 'private, no-cache');
      return send(res, 200, data);
    }
    if (!/^[\w-]{11}$/.test(id)) return send(res, 400, { error: 'Unknown lesson.' });
    const [plan, data] = await Promise.all([planOf(user), lessonFile(id)]);
    if (!data) return send(res, 404, { error: 'Couldn’t load the lesson.' });
    const total = (data.sentences || []).length;
    if (plan === 'free' && total > FREE_SENTENCES) {
      data.sentences = data.sentences.slice(0, FREE_SENTENCES);
      data.locked = total - FREE_SENTENCES;
      // Only the voice clips for what's shown.
      const keep = new Set();
      const plain = w => String(w || '').normalize('NFD').replace(/́/g, '').normalize('NFC')
        .replace(/[^\p{L}\p{N}_\s-]/gu, ' ').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
      for (const s of data.sentences) {
        keep.add(plain(s.ru || s.text));
        for (const t of s.tokens || []) { keep.add(plain(t.w)); keep.add(plain(t.b)); }
      }
      if (data.audio?.clips) data.audio.clips = Object.fromEntries(Object.entries(data.audio.clips).filter(([k]) => keep.has(k)));
    }
    data.total = total;
    data.plan = plan;
    res.setHeader('Cache-Control', 'private, no-cache');
    return send(res, 200, data);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Couldn’t load the lesson.' });
  }
}
