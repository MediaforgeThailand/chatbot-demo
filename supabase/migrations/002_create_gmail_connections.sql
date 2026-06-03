create extension if not exists pgcrypto with schema extensions;

create table if not exists gmail_connections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique,
  google_email text,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  access_token_expires_at timestamptz,
  scope text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists gmail_connections_session_id_idx
on gmail_connections (session_id);

alter table gmail_connections enable row level security;
