create extension if not exists vector with schema extensions;

create table if not exists document_chunks (
  id bigint primary key generated always as identity,
  source_name text not null,
  source_type text,
  content text not null,
  metadata jsonb default '{}',
  embedding extensions.vector(768),
  created_at timestamptz default now()
);

create or replace function match_documents (
  query_embedding extensions.vector(768),
  match_threshold float,
  match_count int
)
returns table (
  id bigint,
  source_name text,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    document_chunks.id,
    document_chunks.source_name,
    document_chunks.content,
    document_chunks.metadata,
    1 - (document_chunks.embedding <=> query_embedding) as similarity
  from document_chunks
  where 1 - (document_chunks.embedding <=> query_embedding) > match_threshold
  order by document_chunks.embedding <=> query_embedding
  limit match_count;
$$;

create index if not exists document_chunks_embedding_hnsw
on document_chunks
using hnsw (embedding vector_cosine_ops);
