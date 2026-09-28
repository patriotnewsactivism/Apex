-- Persistent cache for paid/limited lead discovery searches.
-- Positive directory results are reusable across campaigns for weeks; fast web
-- lead-search results are likewise reusable without paying Tavily/Brave again.

CREATE TABLE IF NOT EXISTS lead_search_cache (
  cache_key text PRIMARY KEY,
  cache_kind text NOT NULL,
  normalized_query text NOT NULL,
  request_fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text,
  payload jsonb NOT NULL,
  result_count integer NOT NULL DEFAULT 0,
  hit_count integer NOT NULL DEFAULT 0,
  last_hit_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_search_cache_query_idx
  ON lead_search_cache (cache_kind, normalized_query);

CREATE INDEX IF NOT EXISTS lead_search_cache_expiry_idx
  ON lead_search_cache (expires_at);
