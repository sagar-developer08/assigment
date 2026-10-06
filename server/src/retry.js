import { requireDb, checked } from './config.js';
import { syncPurchase } from './zoho.js';
const db = requireDb();
const jobs = checked(await db.from('purchases').select('id').eq('status','paid').neq('crm_status','synced'));
for (const job of jobs) console.log(job.id, await syncPurchase(job.id));
