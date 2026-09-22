-- Fakkakha AI phase 5: production atomic rate limiting.
-- Applied to the connected Supabase project on 2026-09-22.
create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count int not null default 0
);

alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from anon, authenticated;

create or replace function public.consume_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
)
returns table(allowed boolean, retry_after_seconds int)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.rate_limits%rowtype;
  elapsed_seconds double precision;
begin
  insert into public.rate_limits(key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do nothing;
  select * into current_row from public.rate_limits where key = p_key for update;
  elapsed_seconds := extract(epoch from (now() - current_row.window_start));
  if elapsed_seconds >= p_window_seconds then
    update public.rate_limits set window_start = now(), count = 1 where key = p_key;
    return query select true, 0;
  elsif current_row.count >= p_limit then
    return query select false, greatest(1, ceil(p_window_seconds - elapsed_seconds)::int);
  else
    update public.rate_limits set count = current_row.count + 1 where key = p_key;
    return query select true, 0;
  end if;
end;
$$;

revoke all on function public.consume_rate_limit(text, int, int) from public;
grant execute on function public.consume_rate_limit(text, int, int) to service_role;

-- Keep the service-only table invisible to browser clients.
comment on table public.rate_limits is 'Backend-only atomic fixed-window rate limiting state';
