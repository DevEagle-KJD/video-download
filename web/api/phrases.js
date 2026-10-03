// POST /api/phrases {text}: "Say it like a native". Saves the request for the
// signed-in user and starts the GitHub "Web phrase" workflow, which fills in the
// row (status/stage) and uploads the result to storage (lessons/<id>/).
import { randomBytes } from 'node:crypto';
import { env, send, db, currentUser, isAdmin } from './_lib.js';

const FREE_PER_WEEK = 3;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const text = String(body.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return send(res, 400, { error: 'Type what you want to say.' });
    if (text.length > 300) return send(res, 400, { error: 'That’s a bit long. Try one or two sentences.' });

    if (!isAdmin(user)) {
      const [profile] = await db(`profiles?id=eq.${user.id}&select=plan`);
      if ((profile?.plan || 'free') !== 'pro') {
        const since = new Date(Date.now() - 7 * 864e5).toISOString();
        const recent = await db(`phrases?user_id=eq.${user.id}&id=like.ph-*&created_at=gte.${since}&select=id`);
        if (recent.length >= FREE_PER_WEEK) {
          return send(res, 402, { error: `You’ve used your ${FREE_PER_WEEK} free phrases this week. Nativnik Pro gives you unlimited.`, code: 'pro' });
        }
      }
    }

    const id = `ph-${Array.from(randomBytes(12), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
    const [row] = await db('phrases', {
      method: 'POST',
      body: { id, user_id: user.id, text, language: 'ru', status: 'queued', stage: 'Waiting to start' },
    });

    const r = await fetch(`https://api.github.com/repos/${env('GITHUB_REPO')}/actions/workflows/web-phrase.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('GITHUB_TOKEN')}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref: env('GITHUB_REF') || 'main', inputs: { phrase_id: id } }),
    });
    if (!r.ok) {
      const msg = `Couldn’t start (${r.status}). Try again in a minute.`;
      await db(`phrases?id=eq.${id}`, { method: 'PATCH', body: { status: 'failed', error: msg } });
      return send(res, 502, { error: msg });
    }
    return send(res, 200, { phrase: row });
  } catch (e) {
    console.error(e);
    if (/PGRST205|phrases/.test(String(e.message))) return send(res, 503, { error: '“Say it like a native” isn’t switched on yet. (Admin: run supabase/schema.sql again.)' });
    return send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}
