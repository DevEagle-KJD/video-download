"""Installs Nativnik's sign-in email (web/supabase/email-code.html) as Supabase's
"Magic Link" and "Confirm signup" templates through the Supabase Management API.

Needs SUPABASE_ACCESS_TOKEN (a personal access token, GitHub secret) and SUPABASE_URL.
Run by .github/workflows/supabase-email.yml; does nothing if the token isn't set yet."""
import json
import os
import re
import sys
import urllib.error
import urllib.request

token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
url = os.environ.get("SUPABASE_URL", "").strip()
if not token:
    print("::notice::SUPABASE_ACCESS_TOKEN secret isn't set yet; skipping.")
    sys.exit(0)
m = re.match(r"https://([a-z0-9]+)\.supabase\.co", url)
if not m:
    sys.exit("::error::SUPABASE_URL secret is missing or not a supabase.co address")
ref = m.group(1)

html = open("web/supabase/email-code.html", encoding="utf-8").read()
html = html.split("-->", 1)[1].lstrip() if html.lstrip().startswith("<!--") else html
subject = "Your Nativnik code: {{ .Token }}"
body = {
    "mailer_subjects_magic_link": subject,
    "mailer_templates_magic_link_content": html,
    "mailer_subjects_confirmation": subject,
    "mailer_templates_confirmation_content": html,
}


def call(method, data=None):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/config/auth", method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "User-Agent": "nativnik-email-templates"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"::error::Supabase API {method} failed: {e.code} {e.read()[:300]!r}")


call("PATCH", body)
now = call("GET")
ok = all(now.get(k) == v for k, v in body.items())
print("Templates installed:", "yes" if ok else "NO (values differ)")
print("Magic Link subject:", now.get("mailer_subjects_magic_link"))
print("Confirm signup subject:", now.get("mailer_subjects_confirmation"))
print("SMTP enabled:", bool(now.get("smtp_host")), "| sender:", now.get("smtp_admin_email"))
sys.exit(0 if ok else 1)
