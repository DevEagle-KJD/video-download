// POST /api/decks {source}: import one of the owner's Anki decks (web/decks/<source>.tsv,
// from the russian-study repo) into Practice. Admins only for now (the decks are personal).
// The deck is a row in the phrases table with id "dk-<source>-…"; the GitHub "Web deck"
// workflow fills it in and uploads lesson.json + voices to storage (lessons/<id>/).
import { randomBytes } from 'node:crypto';
import { env, send, db, currentUser, isAdmin } from './_lib.js';

const DECKS = {
  conversation: 'Russian Conversation', vocab: 'Russian Vocabulary',
  bible: 'Russian Bible (НРП)',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (!isAdmin(user)) return send(res, 403, { error: 'Importing Anki decks is coming soon.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const sources = body.source ? [body.source] : Object.keys(DECKS);
    const made = [];
    for (const source of sources) {
      if (!DECKS[source]) return send(res, 400, { error: 'Unknown deck.' });
      // Updating replaces the old copy of this deck (cards saved from it keep working:
      // its files stay in storage).
      await db(`phrases?user_id=eq.${user.id}&id=like.dk-${source}-*`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      const id = `dk-${source}-${Array.from(randomBytes(6), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
      const [row] = await db('phrases', {
        method: 'POST',
        body: { id, user_id: user.id, text: DECKS[source], language: 'ru', status: 'queued', stage: 'Waiting to start' },
      });
      const r = await fetch(`https://api.github.com/repos/${env('GITHUB_REPO')}/actions/workflows/web-deck.yml/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('GITHUB_TOKEN')}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ ref: env('GITHUB_REF') || 'main', inputs: { deck_id: id, source } }),
      });
      if (!r.ok) {
        await db(`phrases?id=eq.${id}`, { method: 'PATCH', body: { status: 'failed', error: `Couldn’t start (${r.status}).` } });
        return send(res, 502, { error: `Couldn’t start (${r.status}). Try again in a minute.` });
      }
      made.push(row);
    }
    return send(res, 200, { decks: made });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}
