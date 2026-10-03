// Public settings the app needs to talk to Supabase (the anon key is meant to be public;
// row-level security in schema.sql decides what it can do).
import { env, send } from './_lib.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  send(res, 200, {
    appName: env('APP_NAME') || 'Nativnik',
    supabaseUrl: env('SUPABASE_URL'),
    supabaseAnonKey: env('SUPABASE_ANON_KEY'),
    freeSentences: 5,
    freePhrasesPerWeek: 3,
    languages: [{ code: 'ru', name: 'Russian', ready: true }, { code: 'es', name: 'Spanish', ready: false }],
  });
}
