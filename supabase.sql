-- AI COURT / Supabase setup
-- Run this whole file once in Supabase SQL Editor.
-- After that enable Anonymous Sign-Ins in Authentication > Providers > Anonymous.

create extension if not exists pgcrypto;

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  title text not null default 'Человек против ИИ',
  status text not null default 'open' check (status in ('open','closed')),
  current_activity text not null default 'lobby',
  show_results boolean not null default false,
  group_count integer not null default 6 check (group_count between 1 and 10),
  max_group_size integer not null default 4 check (max_group_size in (3,4)),
  created_at timestamptz not null default now()
);

create table if not exists public.sessions_private (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  teacher_token text not null
);

create table if not exists public.teacher_members (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (session_id,user_id)
);

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 40),
  group_no integer not null,
  role text not null check (role in ('prosecutor','defender','expert','secretary')),
  joined_at timestamptz not null default now(),
  unique(session_id,user_id),
  unique(session_id,group_no,role)
);

create table if not exists public.responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  group_no integer not null,
  role text not null,
  activity_id text not null,
  answer jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique(participant_id,activity_id)
);

create table if not exists public.group_responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  group_no integer not null,
  activity_id text not null,
  answer jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique(session_id,group_no,activity_id)
);

-- RLS: all writes happen through RPC functions below.
alter table public.sessions enable row level security;
alter table public.sessions_private enable row level security;
alter table public.teacher_members enable row level security;
alter table public.participants enable row level security;
alter table public.responses enable row level security;
alter table public.group_responses enable row level security;

-- Read own classroom state after joining.
drop policy if exists "session members can read session" on public.sessions;
create policy "session members can read session" on public.sessions for select to authenticated
using (
  exists(select 1 from public.participants p where p.session_id=sessions.id and p.user_id=auth.uid())
  or exists(select 1 from public.teacher_members t where t.session_id=sessions.id and t.user_id=auth.uid())
);

drop policy if exists "participants can read group members" on public.participants;
create policy "participants can read group members" on public.participants for select to authenticated
using (
  exists(select 1 from public.participants me where me.user_id=auth.uid() and me.session_id=participants.session_id and me.group_no=participants.group_no)
  or exists(select 1 from public.teacher_members t where t.session_id=participants.session_id and t.user_id=auth.uid())
);

drop policy if exists "participants can read group responses" on public.responses;
create policy "participants can read group responses" on public.responses for select to authenticated
using (
  participant_id in (select id from public.participants me where me.user_id=auth.uid())
  or exists(select 1 from public.participants me where me.user_id=auth.uid() and me.session_id=responses.session_id and me.group_no=responses.group_no)
  or exists(select 1 from public.teacher_members t where t.session_id=responses.session_id and t.user_id=auth.uid())
);

drop policy if exists "participants can read group verdict" on public.group_responses;
create policy "participants can read group verdict" on public.group_responses for select to authenticated
using (
  exists(select 1 from public.participants me where me.user_id=auth.uid() and me.session_id=group_responses.session_id and me.group_no=group_responses.group_no)
  or exists(select 1 from public.teacher_members t where t.session_id=group_responses.session_id and t.user_id=auth.uid())
);

-- No direct access to sessions_private. teacher_token is checked only inside SECURITY DEFINER functions.

create or replace function public.join_session(p_code text, p_nickname text, p_requested_group integer default null)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  s public.sessions%rowtype;
  p public.participants%rowtype;
  g integer;
  used_count integer;
  chosen_role text;
  roles text[] := array['prosecutor','defender','expert','secretary'];
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into s from public.sessions where upper(code)=upper(p_code) and status='open' limit 1;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;

  select * into p from public.participants where session_id=s.id and user_id=auth.uid();
  if found then return jsonb_build_object('participant',to_jsonb(p),'session',to_jsonb(s)); end if;

  perform pg_advisory_xact_lock(hashtext(s.id::text));

  if p_requested_group is not null and p_requested_group between 1 and s.group_count then
    select count(*) into used_count from public.participants where session_id=s.id and group_no=p_requested_group;
    if used_count < s.max_group_size then g:=p_requested_group; end if;
  end if;

  if g is null then
    select gs into g
    from generate_series(1,s.group_count) gs
    order by (select count(*) from public.participants p2 where p2.session_id=s.id and p2.group_no=gs), gs
    limit 1;
  end if;

  select count(*) into used_count from public.participants where session_id=s.id and group_no=g;
  if used_count >= s.max_group_size then raise exception 'SESSION_FULL'; end if;

  chosen_role := roles[used_count+1];
  if s.max_group_size=3 and chosen_role='secretary' then raise exception 'GROUP_FULL'; end if;

  insert into public.participants(session_id,user_id,nickname,group_no,role)
  values(s.id,auth.uid(),trim(p_nickname),g,chosen_role)
  returning * into p;

  return jsonb_build_object('participant',to_jsonb(p),'session',to_jsonb(s));
end $$;

create or replace function public.get_my_participant(p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.sessions%rowtype; p public.participants%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into s from public.sessions where upper(code)=upper(p_code) limit 1;
  if not found then return null; end if;
  select * into p from public.participants where session_id=s.id and user_id=auth.uid();
  if not found then return null; end if;
  return jsonb_build_object('participant',to_jsonb(p),'session',to_jsonb(s));
end $$;

create or replace function public.get_session_state(p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.sessions%rowtype;
begin
  select * into s from public.sessions where upper(code)=upper(p_code) limit 1;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if not exists(select 1 from public.participants p where p.session_id=s.id and p.user_id=auth.uid())
     and not exists(select 1 from public.teacher_members t where t.session_id=s.id and t.user_id=auth.uid()) then
     raise exception 'NOT_A_MEMBER';
  end if;
  return to_jsonb(s);
end $$;

create or replace function public.submit_response(p_activity_id text, p_answer jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare p public.participants%rowtype;
begin
  select * into p from public.participants where user_id=auth.uid() limit 1;
  if not found then raise exception 'NOT_JOINED'; end if;
  insert into public.responses(session_id,participant_id,group_no,role,activity_id,answer,updated_at)
  values(p.session_id,p.id,p.group_no,p.role,p_activity_id,p_answer,now())
  on conflict(participant_id,activity_id) do update set answer=excluded.answer,updated_at=now(),group_no=excluded.group_no,role=excluded.role;
end $$;

create or replace function public.get_my_response(p_activity_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.participants%rowtype; r public.responses%rowtype;
begin
  select * into p from public.participants where user_id=auth.uid() limit 1;
  if not found then return null; end if;
  select * into r from public.responses where participant_id=p.id and activity_id=p_activity_id;
  if not found then return null; end if;
  return to_jsonb(r);
end $$;

create or replace function public.get_group_activity(p_activity_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.participants%rowtype; gr jsonb;
begin
  select * into p from public.participants where user_id=auth.uid() limit 1;
  if not found then raise exception 'NOT_JOINED'; end if;
  select to_jsonb(g) into gr from public.group_responses g where g.session_id=p.session_id and g.group_no=p.group_no and g.activity_id=p_activity_id;
  return jsonb_build_object(
    'roleResponses', coalesce((select jsonb_agg(to_jsonb(r) order by r.updated_at) from public.responses r where r.session_id=p.session_id and r.group_no=p.group_no and r.activity_id=p_activity_id),'[]'::jsonb),
    'groupResponse', gr
  );
end $$;

create or replace function public.submit_group_response(p_activity_id text, p_answer jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare p public.participants%rowtype; s public.sessions%rowtype;
begin
  select * into p from public.participants where user_id=auth.uid() limit 1;
  if not found then raise exception 'NOT_JOINED'; end if;
  select * into s from public.sessions where id=p.session_id;
  if not (p.role='secretary' or (p.role='expert' and s.max_group_size=3)) then raise exception 'ONLY_RECORDER_CAN_SUBMIT'; end if;
  insert into public.group_responses(session_id,group_no,activity_id,answer,updated_at)
  values(p.session_id,p.group_no,p_activity_id,p_answer,now())
  on conflict(session_id,group_no,activity_id) do update set answer=excluded.answer,updated_at=now();
end $$;

create or replace function public.teacher_authenticate(p_code text, p_teacher_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into s from public.sessions where upper(code)=upper(p_code) limit 1;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if not exists(select 1 from public.sessions_private sp where sp.session_id=s.id and sp.teacher_token=p_teacher_token) then raise exception 'INVALID_TEACHER_TOKEN'; end if;
  insert into public.teacher_members(session_id,user_id) values(s.id,auth.uid()) on conflict do nothing;
  return jsonb_build_object('ok',true,'session',to_jsonb(s));
end $$;

create or replace function public.teacher_snapshot(p_code text, p_teacher_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.sessions%rowtype;
begin
  select * into s from public.sessions where upper(code)=upper(p_code) limit 1;
  if not found or not exists(select 1 from public.sessions_private sp where sp.session_id=s.id and sp.teacher_token=p_teacher_token) then raise exception 'INVALID_TEACHER_TOKEN'; end if;
  return jsonb_build_object(
    'session',to_jsonb(s),
    'participants',coalesce((select jsonb_agg(to_jsonb(p) order by p.group_no,p.joined_at) from public.participants p where p.session_id=s.id),'[]'::jsonb),
    'responses',coalesce((select jsonb_agg(to_jsonb(r) order by r.updated_at) from public.responses r where r.session_id=s.id),'[]'::jsonb),
    'group_responses',coalesce((select jsonb_agg(to_jsonb(g) order by g.group_no) from public.group_responses g where g.session_id=s.id),'[]'::jsonb)
  );
end $$;

create or replace function public.teacher_set_activity(p_code text,p_teacher_token text,p_activity_id text)
returns void language plpgsql security definer set search_path=public as $$
declare sid uuid;
begin
  select s.id into sid from public.sessions s join public.sessions_private sp on sp.session_id=s.id where upper(s.code)=upper(p_code) and sp.teacher_token=p_teacher_token;
  if sid is null then raise exception 'INVALID_TEACHER_TOKEN'; end if;
  update public.sessions set current_activity=p_activity_id,show_results=false where id=sid;
end $$;

create or replace function public.teacher_reset_activity(p_code text,p_teacher_token text,p_activity_id text)
returns void language plpgsql security definer set search_path=public as $$
declare sid uuid;
begin
  select s.id into sid from public.sessions s join public.sessions_private sp on sp.session_id=s.id where upper(s.code)=upper(p_code) and sp.teacher_token=p_teacher_token;
  if sid is null then raise exception 'INVALID_TEACHER_TOKEN'; end if;
  delete from public.responses where session_id=sid and activity_id=p_activity_id;
  delete from public.group_responses where session_id=sid and activity_id=p_activity_id;
end $$;

create or replace function public.teacher_reset_progress(p_code text,p_teacher_token text)
returns void language plpgsql security definer set search_path=public as $$
declare sid uuid;
begin
  select s.id into sid from public.sessions s join public.sessions_private sp on sp.session_id=s.id where upper(s.code)=upper(p_code) and sp.teacher_token=p_teacher_token;
  if sid is null then raise exception 'INVALID_TEACHER_TOKEN'; end if;
  delete from public.responses where session_id=sid;
  delete from public.group_responses where session_id=sid;
  update public.sessions set current_activity='lobby',show_results=false where id=sid;
end $$;

create or replace function public.teacher_full_reset(p_code text,p_teacher_token text)
returns void language plpgsql security definer set search_path=public as $$
declare sid uuid;
begin
  select s.id into sid from public.sessions s join public.sessions_private sp on sp.session_id=s.id where upper(s.code)=upper(p_code) and sp.teacher_token=p_teacher_token;
  if sid is null then raise exception 'INVALID_TEACHER_TOKEN'; end if;
  delete from public.responses where session_id=sid;
  delete from public.group_responses where session_id=sid;
  delete from public.participants where session_id=sid;
  update public.sessions set current_activity='lobby',show_results=false where id=sid;
end $$;

create or replace function public.teacher_update_group_settings(p_code text,p_teacher_token text,p_group_count integer,p_max_group_size integer)
returns void language plpgsql security definer set search_path=public as $$
declare sid uuid;
begin
  if p_group_count not between 1 and 10 or p_max_group_size not in (3,4) then raise exception 'INVALID_GROUP_SETTINGS'; end if;
  select s.id into sid from public.sessions s join public.sessions_private sp on sp.session_id=s.id where upper(s.code)=upper(p_code) and sp.teacher_token=p_teacher_token;
  if sid is null then raise exception 'INVALID_TEACHER_TOKEN'; end if;
  if exists(select 1 from public.participants where session_id=sid) then raise exception 'RESET_PARTICIPANTS_FIRST'; end if;
  update public.sessions set group_count=p_group_count,max_group_size=p_max_group_size where id=sid;
end $$;

-- Seed one classroom session. CHANGE THE TOKEN before the lesson.
insert into public.sessions(code,title,group_count,max_group_size)
values('AI-01','Человек против ИИ: кому доверить решение?',6,4)
on conflict(code) do update set title=excluded.title;

insert into public.sessions_private(session_id,teacher_token)
select id,'COURT-2026-CHANGE-ME' from public.sessions where code='AI-01'
on conflict(session_id) do update set teacher_token=excluded.teacher_token;

-- Optional: add tables to Realtime publication for future extensions.
-- The current build uses fast polling (~1.2 sec) for maximum reliability on classroom Wi-Fi.
do $$ begin
  alter publication supabase_realtime add table public.participants;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.responses;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.group_responses;
exception when duplicate_object then null; end $$;
