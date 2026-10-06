import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayment } from '../src/payment.js';
const purchase={id:'purchase-1',user_id:'user-1',zoho_deal_id:'deal-1',amount:10000,currency:'inr',stripe_session_id:'cs_test_1'};
function event(overrides={}){return {livemode:false,type:'checkout.session.completed',data:{object:{id:'cs_test_1',mode:'payment',payment_status:'paid',client_reference_id:'user-1',metadata:{purchase_id:'purchase-1',zoho_deal_id:'deal-1'},amount_total:10000,currency:'inr',...overrides}}};}
test('accepts matched paid test checkout',()=>assert.equal(validatePayment(event(),purchase),true));
test('ignores unpaid checkout',()=>assert.equal(validatePayment(event({payment_status:'unpaid'}),purchase),false));
test('rejects live payment',()=>assert.throws(()=>validatePayment({...event(),livemode:true},purchase)));
for(const [name,override] of Object.entries({client:{client_reference_id:'other'},amount:{amount_total:1},currency:{currency:'usd'},session:{id:'cs_test_other'},deal:{metadata:{purchase_id:'purchase-1',zoho_deal_id:'other'}},purchase:{metadata:{purchase_id:'other',zoho_deal_id:'deal-1'}}}))test(`rejects mismatched ${name}`,()=>assert.throws(()=>validatePayment(event(override),purchase)));
test('ignores irrelevant events',()=>assert.equal(validatePayment({...event(),type:'charge.refunded'},purchase),false));
test('accepts delayed payment success',()=>assert.equal(validatePayment({...event(),type:'checkout.session.async_payment_succeeded'},purchase),true));
