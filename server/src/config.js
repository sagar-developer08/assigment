import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
export const env = process.env;
export const db = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) throw new Error('Only Stripe test secret keys are allowed');
export const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
export function requireDb() { if (!db) { const error = new Error('Supabase is not configured yet'); error.status = 503; throw error; } return db; }
export function checked(result) { if (result.error) throw result.error; return result.data; }
