import { db, env, checked } from './config.js';
async function jsonRequest(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`Zoho HTTP ${response.status}`);
  return body;
}
export async function syncPurchase(id) {
  const job = checked(await db.rpc('claim_crm_sync', { p_purchase_id: id }));
  if (!job?.length) return { status: 'unchanged' };
  const purchase = job[0];
  try {
    if (![env.ZOHO_CLIENT_ID, env.ZOHO_CLIENT_SECRET, env.ZOHO_REFRESH_TOKEN].every(Boolean)) throw new Error('Zoho credentials are not configured');
    const accounts = env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in';
    const api = env.ZOHO_API_DOMAIN || 'https://sandbox.zohoapis.in';
    if (!/^https:\/\/accounts\.zoho\.(in|com|eu|com\.au|jp|com\.cn|sa)$/.test(accounts) || !/^https:\/\/(sandbox|developer)\.zohoapis\.(in|com|eu|com\.au|jp|com\.cn|sa)$/.test(api)) throw new Error('Use a supported Zoho test environment');
    const token = await jsonRequest(`${accounts}/oauth/v2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET, refresh_token: env.ZOHO_REFRESH_TOKEN }) });
    if (!token.access_token) throw new Error('Zoho token refresh failed');
    const field = env.ZOHO_PAYMENT_FIELD || 'Payment_Status';
    const result = await jsonRequest(`${api}/crm/v8/Deals/${encodeURIComponent(purchase.zoho_deal_id)}`, { method: 'PUT', headers: { Authorization: `Zoho-oauthtoken ${token.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [{ [field]: 'Paid' }], trigger: [] }) });
    if (result.data?.[0]?.status !== 'success') throw new Error('Zoho rejected Deal update; check field API name and Deal ID');
    checked(await db.rpc('finish_crm_sync', { p_purchase_id: id, p_success: true, p_error: null }));
    return { status: 'synced' };
  } catch (error) {
    checked(await db.rpc('finish_crm_sync', { p_purchase_id: id, p_success: false, p_error: error.message }));
    return { status: 'pending' };
  }
}
