// Adapted from getformo/sdk's EventFactory and traffic-source sanitizer.
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const FORBIDDEN = /[<>"'`\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\ufeff\ufffd]/;

function safeUtm(value: string | null): string | undefined {
  if (!value || value.length > 255 || FORBIDDEN.test(value) || /^\s*(javascript|data|vbscript):/i.test(value)) return undefined;
  return value;
}

export function pageContext() {
  const url = new URL(location.href);
  const path = url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '/';
  // Only explicitly selected campaign parameters leave the browser. Full query
  // strings and fragments often contain emails, tokens, and other private data.
  const campaign: Partial<Record<(typeof UTM_KEYS)[number], string>> = {};
  for (const key of UTM_KEYS) {
    const value = safeUtm(url.searchParams.get(key));
    if (value) campaign[key] = value;
  }
  let referrer = '';
  if (document.referrer) {
    try {
      const ref = new URL(document.referrer);
      if (ref.hostname !== url.hostname && /^https?:$/.test(ref.protocol)) referrer = ref.origin;
    } catch { /* Ignore malformed referrers. */ }
  }
  return {
    page: { path, title: document.title.slice(0, 300), url: `${url.origin}${path}` },
    referrer,
    ...campaign,
    locale: navigator.language?.slice(0, 32),
  };
}
