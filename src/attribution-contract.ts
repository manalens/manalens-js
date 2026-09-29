// Keep this capture contract aligned with the standalone SDK / collector.
export const campaignKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic'] as const;
export const clickNetworks = [['gclid', 'google'], ['gbraid', 'google'], ['wbraid', 'google'], ['fbclid', 'meta'], ['msclkid', 'microsoft'], ['ttclid', 'tiktok'], ['twclid', 'twitter'], ['li_fat_id', 'linkedin'], ['rdt_cid', 'reddit'], ['ScCid', 'snapchat']] as const;
export const paidSources = ['google', 'meta', 'microsoft', 'tiktok', 'twitter', 'linkedin', 'reddit', 'snapchat', 'paid_utm'] as const;
export const acquisitionKeys = [...campaignKeys, ...clickNetworks.map(([key]) => key), 'gad_source', 'ref', 'paid_source', 'click_id'] as const;
const forbidden = /[<>"'`\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\ufeff\ufffd]/;
export function safeCampaign(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || forbidden.test(value) || /^\s*(javascript|data|vbscript):/i.test(value)) return undefined;
  return value;
}
/** All network tokens survive; click_id is only a deterministic compatibility winner. */
export function attributionContext(input: Record<string, unknown>, url?: URL): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of [...campaignKeys, ...clickNetworks.map(([key]) => key), 'gad_source', 'ref']) {
    const value = safeCampaign(input[key]) || safeCampaign(url?.searchParams.get(key));
    if (value) fields[key] = value;
  }
  fields.ref ||= safeCampaign(url?.searchParams.get('referral')) || safeCampaign(url?.searchParams.get('referral_code')) || '';
  if (!fields.ref) delete fields.ref;
  const click = clickNetworks.find(([key]) => fields[key]);
  const legacySource = safeCampaign(input.paid_source);
  const legacyClick = safeCampaign(input.click_id);
  const paidMedium = /^(cpc|cpm|cpv|cpa|ppc|paidsearch|paidsocial|sem|retargeting|paid.*)$/i.test(fields.utm_medium || '');
  const source = click?.[1] || (fields.gad_source ? 'google' : '') || (legacySource && (paidSources as readonly string[]).includes(legacySource) ? legacySource : '') || (paidMedium ? 'paid_utm' : '');
  if (source) fields.paid_source = source;
  if (click) fields.click_id = fields[click[0]]!;
  else if (legacyClick) fields.click_id = legacyClick;
  return fields;
}
