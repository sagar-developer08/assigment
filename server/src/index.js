import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { db, stripe, env, checked, requireDb } from './config.js';
import { validatePayment } from './payment.js';
import { syncPurchase } from './zoho.js';
const app = express();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.join(__dirname, '../../client/dist');
const serveStatic = env.SERVE_STATIC === 'true' && existsSync(staticRoot);
if (serveStatic) app.set('trust proxy', 1);
app.use(helmet(serveStatic ? { contentSecurityPolicy: false } : undefined));
app.use(cors({ origin: env.CLIENT_URL || 'http://localhost:5173' }));
app.use((req, res, next) => { req.requestId = randomUUID(); res.setHeader('X-Request-ID', req.requestId); res.setHeader('Cache-Control', 'no-store'); next(); });
app.get('/api/health', (req, res) => res.json({ status: 'ok', configured: { supabase: !!db, stripe: !!stripe && !!env.STRIPE_PRICE_ID && !!env.STRIPE_WEBHOOK_SECRET, zoho: !!env.ZOHO_REFRESH_TOKEN } }));
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), asyncRoute(async (req, res) => {
  requireDb();
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe webhook is not configured' });
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET); } catch { return res.status(400).json({ error: 'Invalid webhook signature' }); }
  if (event.livemode) return res.status(400).json({ error: 'Live payments are disabled' });
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) || event.data.object.payment_status !== 'paid') return res.json({ received: true });
  const s = event.data.object;
  const purchase = checked(await db.from('purchases').select('*').eq('id', s.metadata?.purchase_id || '00000000-0000-0000-0000-000000000000').maybeSingle());
  try { validatePayment(event, purchase); } catch { return res.status(400).json({ error: 'Payment mapping validation failed' }); }
  const applied = checked(await db.rpc('apply_paid_checkout', { p_event_id: event.id, p_purchase_id: purchase.id, p_session_id: s.id, p_payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : null }));
  if (applied) await syncPurchase(purchase.id);
  res.json({ received: true, duplicate: !applied });
}));
app.use(express.json({ limit: '16kb' }));
app.use('/api', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api', asyncRoute(async (req, res, next) => {
  requireDb();
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Please sign in' });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  req.user = data.user; next();
}));
async function ownedPurchase(req) {
  const p = checked(await db.from('purchases').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle());
  if (!p) { const e = new Error('Purchase not found'); e.status = 404; throw e; } return p;
}
app.post('/api/checkout', asyncRoute(async (req, res) => {
  if (!stripe || !env.STRIPE_PRICE_ID) return res.status(503).json({ error: 'Stripe test credentials are needed before checkout is available.' });
  const profile = checked(await db.from('profiles').select('zoho_deal_id').eq('id', req.user.id).single());
  if (!profile.zoho_deal_id) return res.status(409).json({ error: 'Your test client needs a Zoho Deal mapping. Follow the setup instructions.' });
  const entitled = checked(await db.from('entitlements').select('id').eq('user_id', req.user.id).eq('document_id', 'sample-guide').maybeSingle());
  if (entitled) return res.status(409).json({ error: 'You already have access to this document.' });
  const price = await stripe.prices.retrieve(env.STRIPE_PRICE_ID);
  if (price.livemode || !price.active || !price.unit_amount || price.type !== 'one_time') return res.status(409).json({ error: 'Configure an active, one-time Stripe test price.' });
  // A unique partial index makes simultaneous checkout requests converge on one purchase.
  let p = checked(await db.from('purchases').select('*').eq('user_id', req.user.id).eq('status', 'pending').maybeSingle());
  if (!p) {
    const inserted = await db.from('purchases').insert({ user_id: req.user.id, document_id: 'sample-guide', zoho_deal_id: profile.zoho_deal_id, amount: price.unit_amount, currency: price.currency }).select().single();
    if (inserted.error?.code === '23505') p = checked(await db.from('purchases').select('*').eq('user_id', req.user.id).eq('status', 'pending').single()); else p = checked(inserted);
  }
  if (p.stripe_session_id) {
    const previous = await stripe.checkout.sessions.retrieve(p.stripe_session_id);
    if (previous.status === 'open') return res.json({ url: previous.url });
    if (previous.status === 'complete') return res.status(409).json({ error: 'Payment processing. Please refresh shortly.' });
    checked(await db.from('purchases').update({ status: 'expired' }).eq('id', p.id).eq('status', 'pending'));
    return res.status(409).json({ error: 'Checkout expired. Click purchase again to start a new checkout.' });
  }
  if (p.amount !== price.unit_amount || p.currency !== price.currency) return res.status(409).json({ error: 'Price changed. Resolve the pending purchase before continuing.' });
  const session = await stripe.checkout.sessions.create({ mode: 'payment', line_items: [{ price: price.id, quantity: 1 }], client_reference_id: req.user.id, customer_email: req.user.email, metadata: { purchase_id: p.id, zoho_deal_id: p.zoho_deal_id }, success_url: `${env.CLIENT_URL || 'http://localhost:5173'}/?checkout=success`, cancel_url: `${env.CLIENT_URL || 'http://localhost:5173'}/?checkout=cancelled` }, { idempotencyKey: `purchase-${p.id}` });
  checked(await db.from('purchases').update({ stripe_session_id: session.id }).eq('id', p.id));
  res.json({ url: session.url });
}));
app.post('/api/purchases/:id/retry', asyncRoute(async (req, res) => { const p = await ownedPurchase(req); if (p.status !== 'paid') return res.status(409).json({ error: 'Only paid purchases can sync' }); res.json(await syncPurchase(p.id)); }));
app.get('/api/documents/:id/download', asyncRoute(async (req, res) => {
  const entitlement = checked(await db.from('entitlements').select('id').eq('user_id', req.user.id).eq('document_id', req.params.id).maybeSingle());
  if (!entitlement) return res.status(403).json({ error: 'Purchase this document to access it.' });
  const document = checked(await db.from('documents').select('*').eq('id', req.params.id).single());
  const signed = checked(await db.storage.from('client-documents').createSignedUrl(document.storage_path, 60));
  checked(await db.from('audit_logs').insert({ user_id: req.user.id, action: 'document.download', detail: { document_id: req.params.id } }));
  res.json({ url: signed.signedUrl });
}));
app.post('/api/audit/login', asyncRoute(async (req, res) => { checked(await db.from('audit_logs').insert({ user_id: req.user.id, action: 'session.verified', detail: { source: 'portal' } })); res.status(204).end(); }));
if (serveStatic) {
  app.use(express.static(staticRoot, { index: false }));
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(staticRoot, 'index.html'));
  });
}
app.use((error, req, res, next) => { console.error(JSON.stringify({ requestId: req.requestId, error: error.message })); res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong. Please try again.', requestId: req.requestId }); });
const port = Number(env.PORT || 4000);
const host = env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Prospect API listening on ${host}:${port}${serveStatic ? ' (static UI enabled)' : ''}`));
