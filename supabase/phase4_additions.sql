-- Fakkakha AI additive migration. Apply only after review in the target Supabase project.
-- No curriculum, teacher, school, or payment data is fabricated here.

alter table profiles add column if not exists parental_consent_at timestamptz;
alter table profiles add column if not exists parental_consent_version text;
alter table profiles add column if not exists consent_required boolean not null default false;

create table if not exists daily_quotas (
  user_id uuid not null references auth.users(id) on delete cascade,
  quota_date date not null default current_date,
  ai_requests int not null default 0,
  research_requests int not null default 0,
  abuse_score int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, quota_date)
);

create table if not exists ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  endpoint text not null,
  model text,
  input_tokens_estimated int not null default 0,
  output_tokens_estimated int not null default 0,
  estimated_cost_usd numeric(12,8) not null default 0,
  request_id text,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_created_idx on ai_usage(user_id, created_at);

alter table daily_quotas enable row level security;
alter table ai_usage enable row level security;
revoke all on daily_quotas from anon, authenticated;
revoke all on ai_usage from anon, authenticated;
