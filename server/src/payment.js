export function validatePayment(event, purchase) {
  if (event.livemode) throw new Error('Live payments are not allowed');
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return false;
  const s = event.data.object;
  if (s.payment_status !== 'paid') return false;
  if (!purchase || s.mode !== 'payment' || s.metadata?.purchase_id !== purchase.id || s.client_reference_id !== purchase.user_id || s.metadata?.zoho_deal_id !== purchase.zoho_deal_id || s.amount_total !== purchase.amount || s.currency !== purchase.currency || !purchase.zoho_deal_id) throw new Error('Payment does not match the stored purchase');
  if (purchase.stripe_session_id && purchase.stripe_session_id !== s.id) throw new Error('Checkout session mismatch');
  return true;
}
