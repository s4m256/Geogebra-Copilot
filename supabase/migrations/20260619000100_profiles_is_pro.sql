alter table public.profiles
  add column if not exists is_pro boolean not null default false;

update public.profiles
set is_pro = plan = 'pro'
where is_pro is distinct from (plan = 'pro');

create or replace function public.sync_profile_is_pro()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.is_pro := new.plan = 'pro';
  return new;
end;
$$;

drop trigger if exists profiles_sync_is_pro on public.profiles;

create trigger profiles_sync_is_pro
  before insert or update of plan on public.profiles
  for each row execute procedure public.sync_profile_is_pro();
