// POST /api/lessons {url}: add a YouTube video to the signed-in user's lessons.
// The lesson is made once per video (by the GitHub "Web lesson" workflow) and
// shared; this only queues it if nobody has added that video before.
import { env, send, db, currentUser, isAdmin, youtubeId, normChannel } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const language = body.language || 'ru';
    if (language !== 'ru') return send(res, 400, { error: 'Only Russian lessons can be made so far. More languages are coming soon.' });
    const videoId = youtubeId(body.url);
    if (!videoId) return send(res, 400, { error: 'Paste a YouTube video link.' });

    const [existing] = await db(`lessons?video_id=eq.${videoId}&select=*`);
    const [mine] = await db(`user_lessons?user_id=eq.${user.id}&video_id=eq.${videoId}&select=video_id`);
    if (mine && existing && existing.status !== 'failed') return send(res, 200, { lesson: existing, already: true });

    // Details from YouTube's public oEmbed endpoint (title, channel, thumbnail).
    const o = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
    if (!o.ok) return send(res, 404, { error: 'That video is private, removed or can’t be embedded.' });
    const info = await o.json();
    const channel = normChannel(info.author_url);

    const admin = isAdmin(user);
    if (!admin) {
      const [ok] = await db(`channels?author_url=eq.${encodeURIComponent(channel)}&approved=is.true&select=author_url`);
      if (!ok) {
        await db('channel_requests', { method: 'POST', body: { user_id: user.id, author_url: channel, name: info.author_name, video_id: videoId } }).catch(() => {});
        return send(res, 403, { error: `“${info.author_name}” isn’t in our library yet. We’ve noted your request and will ask the creator.`, code: 'channel' });
      }
      // Free plan: lessons already in the library only; making a new one is Pro.
      const [profile] = await db(`profiles?id=eq.${user.id}&select=plan`);
      const ready = existing && existing.status !== 'failed';
      if ((profile?.plan || 'free') !== 'pro' && !ready) {
        return send(res, 402, { error: 'Making new lessons from any video is part of Nativnik Pro. Lessons already in Explore are free to study.', code: 'pro' });
      }
    }

    let lesson = existing;
    const start = !existing || existing.status === 'failed';
    if (start) {
      const row = {
        video_id: videoId, language, title: info.title, channel: info.author_name,
        author_url: channel, thumbnail: info.thumbnail_url, status: 'queued', stage: 'Waiting to start', error: null,
        updated_at: new Date().toISOString(),
      };
      [lesson] = await db('lessons?on_conflict=video_id', { method: 'POST', body: row, headers: { Prefer: 'return=representation,resolution=merge-duplicates' } });
    }
    await db('user_lessons?on_conflict=user_id,video_id', {
      method: 'POST', body: { user_id: user.id, video_id: videoId },
      headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    });

    if (start) {
      // Start the lesson maker (GitHub Actions for now; a GPU worker later).
      const r = await fetch(`https://api.github.com/repos/${env('GITHUB_REPO')}/actions/workflows/web-lesson.yml/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('GITHUB_TOKEN')}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ ref: env('GITHUB_REF') || 'main', inputs: { video_id: videoId, language: lesson.language } }),
      });
      if (!r.ok) {
        const msg = `Couldn’t start the lesson maker (${r.status}).`;
        await db(`lessons?video_id=eq.${videoId}`, { method: 'PATCH', body: { status: 'failed', error: msg } });
        return send(res, 502, { error: msg });
      }
    }
    return send(res, 200, { lesson });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}
