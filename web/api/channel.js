// POST /api/channel {url, more?, ver?}: the videos of an approved
// channel (newest first, about 30 at a time), read from the channel's public
// YouTube page, so Explore can show them and turn any one into a lesson.
import { send, db, currentUser, isAdmin, normChannel } from './_lib.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Every object stored under `key`, anywhere inside YouTube's page data.
function collect(o, key, out = []) {
  if (Array.isArray(o)) o.forEach(x => collect(x, key, out));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (k === key) out.push(v); else collect(v, key, out);
    }
  }
  return out;
}

function videos(page) {
  // Only the video grid (the page also has shelves, chips and other lists).
  const data = collect(page, 'richGridRenderer')[0]?.contents
    || collect(page, 'appendContinuationItemsAction')[0]?.continuationItems || [];
  const list = [];
  for (const v of collect(data, 'lockupViewModel')) {
    if (v.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !v.contentId) continue;
    const meta = v.metadata?.lockupMetadataViewModel || {};
    const parts = collect(meta.metadata, 'metadataParts').flat().map(p => p.text?.content).filter(Boolean);
    const badge = collect(v.contentImage, 'thumbnailBadgeViewModel')[0]?.text || '';
    list.push({ id: v.contentId, title: meta.title?.content || '', duration: badge, views: parts[0] || '', age: parts[1] || '' });
  }
  for (const v of collect(data, 'videoRenderer')) {   // older page layout
    if (!v.videoId) continue;
    list.push({
      id: v.videoId, title: v.title?.runs?.[0]?.text || '', duration: v.lengthText?.simpleText || '',
      views: v.shortViewCountText?.simpleText || '', age: v.publishedTimeText?.simpleText || '',
    });
  }
  const token = collect(data, 'continuationItemRenderer')[0]?.continuationEndpoint?.continuationCommand?.token || null;
  return { videos: list, more: token };
}

export default async function handler(req, res) {
  try {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const q = { ...req.query, ...body };
    const url = normChannel(q.url);
    if (!/^https:\/\/www\.youtube\.com\/(@[\w.-]+|channel\/[\w-]+)$/.test(url)) return send(res, 400, { error: 'Not a channel link.' });
    const [channel] = await db(`channels?author_url=eq.${encodeURIComponent(url)}&select=name,approved`);
    if (!channel?.approved && !isAdmin(user)) return send(res, 403, { error: 'That channel isn’t in our library yet.' });

    let out;
    if (q.more) {
      const [, ver] = String(q.ver || '').match(/^(\d+\.\d{8}\.\d+\.\d+)$/) || [, '2.20261001.00.00'];
      const r = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'en' } }, continuation: String(q.more) }),
      });
      if (!r.ok) throw new Error(`youtube ${r.status}`);
      out = videos(await r.json());
      out.ver = ver;
    } else {
      const r = await fetch(`${url}/videos`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.8' } });
      if (!r.ok) throw new Error(`youtube ${r.status}`);
      const html = await r.text();
      const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
      if (!m) throw new Error('no page data');
      out = videos(JSON.parse(m[1]));
      out.ver = html.match(/"clientVersion":"([^"]+)"/)?.[1] || '';
    }

    // Which of these already are lessons (ready ones open straight away).
    const ids = out.videos.map(v => v.id);
    const made = ids.length ? await db(`lessons?video_id=in.(${ids.join(',')})&select=video_id,status`) : [];
    const status = Object.fromEntries(made.map(l => [l.video_id, l.status]));
    out.videos.forEach(v => { v.lesson = status[v.id] || null; });

    res.setHeader('Cache-Control', 'private, max-age=600');
    return send(res, 200, { name: channel?.name || '', ...out });
  } catch (e) {
    console.error(e);
    return send(res, 502, { error: 'Couldn’t load this channel’s videos. Try again in a minute.' });
  }
}
