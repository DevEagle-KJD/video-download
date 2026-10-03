// POST /api/bible {refs: ['MAT.1.18', …], make?}: the Bible section (admins and
// BIBLE_EMAILS only). Returns each verse's status; with make, starts the GitHub
// "Web Bible verse" workflow for verses that aren't made yet. Verses are shared
// (made once, for everyone allowed) and stored as rows in the phrases table with
// id "bv-<book>-<chapter>-<verse>"; lesson.json is private (read via /api/lesson).
import { env, send, db, currentUser, bibleAccess, BIBLE_START } from './_lib.js';

const REF = /^[1-4A-Z]{3}\.\d{1,3}\.\d{1,3}$/;
const verseId = ref => `bv-${ref.toLowerCase().replace(/\./g, '-')}`;
const label = ref => ref.replace(/^(\w+)\.(\d+)\.(\d+)$/, '$1 $2:$3');

async function start(id, ref) {
  const r = await fetch(`https://api.github.com/repos/${env('GITHUB_REPO')}/actions/workflows/web-bible.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('GITHUB_TOKEN')}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: env('GITHUB_REF') || 'main', inputs: { verse_id: id, ref } }),
  });
  if (!r.ok) await db(`phrases?id=eq.${id}`, { method: 'PATCH', body: { status: 'failed', error: `Couldn’t start (${r.status}).` } });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (!bibleAccess(user)) return send(res, 403, { error: 'Not available.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const refs = [...new Set((body.refs || []).map(String))].filter(r => REF.test(r)).slice(0, 4);
    const ids = refs.map(verseId);
    const rows = ids.length ? await db(`phrases?id=in.(${ids.join(',')})&select=id,status,stage,error,created_at`) : [];
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    const out = [];
    for (const ref of refs) {
      const id = verseId(ref);
      let row = byId[id];
      // A failed verse is tried again; one stuck for over 40 minutes too (the job died).
      const stuck = row && row.status !== 'ready' && row.status !== 'failed' && Date.now() - Date.parse(row.created_at) > 40 * 60e3;
      if (body.make && (!row || row.status === 'failed' || stuck)) {
        if (row) await db(`phrases?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        try {
          [row] = await db('phrases', {
            method: 'POST',
            body: { id, user_id: user.id, text: label(ref), language: 'ru', status: 'queued', stage: 'Waiting to start' },
          });
          await start(id, ref);
        } catch (e) {
          if (e.status !== 409) throw e;                  // someone else just started it
          [row] = await db(`phrases?id=eq.${id}&select=id,status,stage,error,created_at`);
        }
      }
      out.push({ ref, id, status: row?.status || 'none', stage: row?.stage || '', error: row?.error || '' });
    }
    return send(res, 200, { start: BIBLE_START, verses: out });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}
