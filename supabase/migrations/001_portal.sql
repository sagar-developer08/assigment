begin;
create table public.profiles (id uuid primary key references auth.users on delete cascade, full_name text not null default '', zoho_deal_id text unique, created_at timestamptz not null default now());
create table public.documents (id text primary key, title text not null, description text not null, storage_path text not null);
insert into public.documents values ('sample-guide','The Client Launch Playbook','A practical guide to turning your next project into a confident launch.','sample-guide.html');
create table public.purchases (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles, document_id text not null references public.documents, zoho_deal_id text not null, amount integer not null check(amount>0), currency text not null, status text not null default 'pending' check(status in ('pending','paid','expired')), stripe_session_id text unique, payment_intent text, crm_status text not null default 'not_started' check(crm_status in ('not_started','pending','syncing','synced')), crm_attempts integer not null default 0, crm_error text, crm_locked_at timestamptz, created_at timestamptz not null default now(), paid_at timestamptz);
create unique index one_pending_purchase on public.purchases(user_id, document_id) where status='pending';
create table public.entitlements (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles, document_id text not null references public.documents, purchase_id uuid not null references public.purchases, granted_at timestamptz not null default now(), unique(user_id,document_id));
create table public.webhook_events (id text primary key, purchase_id uuid not null references public.purchases, processed_at timestamptz not null default now());
create table public.audit_logs (id bigint generated always as identity primary key, user_id uuid not null references public.profiles, action text not null, detail jsonb not null default '{}', created_at timestamptz not null default now());
create index audit_user_time on public.audit_logs(user_id, created_at desc);
create function public.create_profile() returns trigger language plpgsql security definer set search_path=public as $$ begin insert into public.profiles(id,full_name) values(new.id,coalesce(new.raw_user_meta_data->>'full_name','')); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.create_profile();
insert into public.profiles(id,full_name) select id,coalesce(raw_user_meta_data->>'full_name','') from auth.users on conflict do nothing;
alter table public.profiles enable row level security;
alter table public.documents enable row level security;
alter table public.purchases enable row level security;
alter table public.entitlements enable row level security;
alter table public.webhook_events enable row level security;
alter table public.audit_logs enable row level security;
create policy own_profile on public.profiles for select to authenticated using(id=auth.uid());
create policy document_catalog on public.documents for select to authenticated using(true);
create policy own_purchase on public.purchases for select to authenticated using(user_id=auth.uid());
create policy own_entitlement on public.entitlements for select to authenticated using(user_id=auth.uid());
create policy own_audit on public.audit_logs for select to authenticated using(user_id=auth.uid());
revoke all on public.profiles,public.documents,public.purchases,public.entitlements,public.webhook_events,public.audit_logs from anon,authenticated;
grant select on public.profiles,public.documents,public.purchases,public.entitlements,public.audit_logs to authenticated;
create function public.apply_paid_checkout(p_event_id text,p_purchase_id uuid,p_session_id text,p_payment_intent text) returns boolean language plpgsql security definer set search_path=public as $$
declare p public.purchases; begin
select * into p from public.purchases where id=p_purchase_id for update;
if not found then raise exception 'Unknown purchase'; end if;
if p.stripe_session_id is not null and p.stripe_session_id<>p_session_id then raise exception 'Session mismatch'; end if;
insert into public.webhook_events(id,purchase_id) values(p_event_id,p.id) on conflict do nothing;
if not found then return false; end if;
if p.status='paid' then return false; end if;
if p.status<>'pending' then raise exception 'Invalid purchase state'; end if;
update public.purchases set status='paid',stripe_session_id=p_session_id,payment_intent=p_payment_intent,paid_at=now(),crm_status='pending' where id=p.id;
insert into public.entitlements(user_id,document_id,purchase_id) values(p.user_id,p.document_id,p.id) on conflict(user_id,document_id) do nothing;
insert into public.audit_logs(user_id,action,detail) values(p.user_id,'payment.confirmed',jsonb_build_object('purchase_id',p.id,'event_id',p_event_id)),(p.user_id,'access.granted',jsonb_build_object('document_id',p.document_id));
return true; end $$;
create function public.claim_crm_sync(p_purchase_id uuid) returns setof public.purchases language plpgsql security definer set search_path=public as $$ begin
return query update public.purchases set crm_status='syncing',crm_locked_at=now(),crm_attempts=crm_attempts+1 where id=p_purchase_id and status='paid' and (crm_status='pending' or (crm_status='syncing' and crm_locked_at<now()-interval '2 minutes')) returning *;
end $$;
create function public.finish_crm_sync(p_purchase_id uuid,p_success boolean,p_error text) returns void language plpgsql security definer set search_path=public as $$
declare p public.purchases; begin
update public.purchases set crm_status=case when p_success then 'synced' else 'pending' end,crm_error=case when p_success then null else left(p_error,500) end,crm_locked_at=null where id=p_purchase_id returning * into p;
insert into public.audit_logs(user_id,action,detail) values(p.user_id,case when p_success then 'crm.synced' else 'crm.pending' end,jsonb_build_object('purchase_id',p.id,'attempt',p.crm_attempts));
end $$;
revoke all on function public.apply_paid_checkout(text,uuid,text,text),public.claim_crm_sync(uuid),public.finish_crm_sync(uuid,boolean,text),public.create_profile() from public,anon,authenticated;
grant execute on function public.apply_paid_checkout(text,uuid,text,text),public.claim_crm_sync(uuid),public.finish_crm_sync(uuid,boolean,text) to service_role;
insert into storage.buckets(id,name,public) values('client-documents','client-documents',false) on conflict(id) do update set public=false;
-- No direct client storage access; the authenticated API verifies entitlement then issues a 60-second URL.
commit;
