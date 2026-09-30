// Shared helpers for the server functions (files starting with "_" aren't routes).
// Settings come from Vercel → Project → Settings → Environment Variables.
export const env = name => process.env[name] || '';

export function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

// Supabase REST call with the server's service key (bypasses row-level security).
export async function db(path, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`database ${r.status}: ${text.slice(0, 200)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

// The signed-in user, from the "Authorization: Bearer <access token>" header.
export async function currentUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: `Bearer ${token}` },
  });
  return r.ok ? r.json() : null;
}

export const isAdmin = user => env('ADMIN_EMAILS').toLowerCase().split(/[\s,]+/).filter(Boolean)
  .includes(String(user?.email || '').toLowerCase());

export function youtubeId(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

// "https://www.youtube.com/@EasyRussian/" → "https://www.youtube.com/@easyrussian"
export const normChannel = url => String(url || '').trim().replace(/^http:/, 'https:')
  .replace('://youtube.com', '://www.youtube.com').replace(/\/+$/, '').toLowerCase();
