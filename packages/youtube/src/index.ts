/**
 * YouTube Data API v3 client.
 *
 * Scoped deliberately narrowly: this reads live chat and comment threads, and
 * posts a reply when the orchestrator asks it to. It does not delete, ban or
 * time anyone out, because nothing in this system is allowed to do those
 * without a human, and a capability that is never used is better absent than
 * merely unexercised.
 *
 * Quota is the constraint that shapes the design. The Data API grants 10,000
 * units/day by default. `liveChatMessages.list` costs 1 unit per call, so a
 * live broadcast polled at the interval YouTube itself dictates is affordable;
 * `commentThreads.list` is also 1, but `search.list` is 100, which is why
 * finding the active broadcast goes through `liveBroadcasts` (1) and never
 * through search.
 */

const API = 'https://www.googleapis.com/youtube/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface OAuthTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. Treated as expired a minute early to avoid racing the edge. */
  accessExpiresAt?: number;
}

export interface YouTubeClientOptions {
  clientId: string;
  clientSecret: string;
  tokens: OAuthTokens;
  /** Called whenever a refresh yields a new access token, so it can be persisted. */
  onTokenRefreshed?: (next: { accessToken: string; accessExpiresAt: number }) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface LiveChatMessage {
  id: string;
  authorChannelId: string | null;
  authorDisplayName: string;
  authorChannelUrl: string | null;
  text: string;
  publishedAt: string;
  isOwner: boolean;
  isModerator: boolean;
}

export interface LiveChatPage {
  messages: LiveChatMessage[];
  nextPageToken: string | null;
  /** YouTube's own instruction for how long to wait. Honour it, don't guess. */
  pollingIntervalMillis: number;
}

export interface CommentThreadItem {
  id: string;
  authorChannelId: string | null;
  authorDisplayName: string;
  authorChannelUrl: string | null;
  text: string;
  publishedAt: string;
  videoId: string | null;
  parentId: string | null;
}

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null,
    /** Mirrors agent-runtime's retry classification. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

export class YouTubeClient {
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null;
  private accessExpiresAt: number;

  constructor(private readonly options: YouTubeClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accessToken = options.tokens.accessToken ?? null;
    this.accessExpiresAt = options.tokens.accessExpiresAt ?? 0;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /**
   * Returns a valid access token, refreshing if it is missing or within a
   * minute of expiry.
   *
   * A refresh failure is deliberately non-retryable: `invalid_grant` means the
   * user revoked access or changed their password, and hammering the endpoint
   * neither fixes that nor produces a different answer.
   */
  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessExpiresAt - 60_000) return this.accessToken;

    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.tokens.refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !payload.access_token) {
      throw new YouTubeApiError(
        `token refresh failed: ${payload.error ?? res.status} ${payload.error_description ?? ''}`.trim(),
        res.status,
        payload.error ?? null,
        // 5xx from Google's token endpoint is worth another go; a rejected
        // grant is not.
        res.status >= 500,
      );
    }

    this.accessToken = payload.access_token;
    this.accessExpiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
    await this.options.onTokenRefreshed?.({
      accessToken: this.accessToken,
      accessExpiresAt: this.accessExpiresAt,
    });
    return this.accessToken;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | undefined>,
    init: RequestInit = {},
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, v);

    const res = await this.fetchImpl(`${API}${path}?${query}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });

    if (res.ok) return (await res.json()) as T;

    const detail = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    const reason = detail.error?.errors?.[0]?.reason ?? null;

    // quotaExceeded means the daily budget is gone; retrying inside this run
    // cannot help and only burns the next day's allowance faster.
    const retryable =
      res.status >= 500 ||
      (res.status === 403 && reason === 'rateLimitExceeded') ||
      res.status === 429;

    throw new YouTubeApiError(
      `${path} failed: ${res.status} ${detail.error?.message ?? res.statusText}`,
      res.status,
      reason,
      retryable,
    );
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The authenticated user's own channel. Used to confirm what we connected to. */
  async myChannel(): Promise<{ id: string; title: string }> {
    const data = await this.request<{
      items?: Array<{ id: string; snippet?: { title?: string } }>;
    }>('/channels', { part: 'snippet', mine: 'true' });
    const channel = data.items?.[0];
    if (!channel) throw new YouTubeApiError('no channel on this account', 404, 'notFound', false);
    return { id: channel.id, title: channel.snippet?.title ?? channel.id };
  }

  /**
   * The active live broadcast's chat id, or null when nothing is live.
   *
   * `liveBroadcasts.list` with `broadcastStatus=active` costs 1 unit and only
   * works for the authenticated channel — which is exactly our case, and is
   * why this never falls back to `search.list` at 100 units a call.
   */
  async activeLiveChatId(): Promise<{ liveChatId: string; videoId: string } | null> {
    const data = await this.request<{
      items?: Array<{ id: string; snippet?: { liveChatId?: string } }>;
    }>('/liveBroadcasts', {
      part: 'snippet',
      broadcastStatus: 'active',
      broadcastType: 'all',
      maxResults: '1',
    });
    const item = data.items?.[0];
    if (!item?.snippet?.liveChatId) return null;
    return { liveChatId: item.snippet.liveChatId, videoId: item.id };
  }

  /** One page of live chat. Pass the previous page's token to continue. */
  async liveChatMessages(liveChatId: string, pageToken?: string): Promise<LiveChatPage> {
    const data = await this.request<{
      items?: Array<{
        id: string;
        snippet?: { displayMessage?: string; publishedAt?: string };
        authorDetails?: {
          channelId?: string;
          displayName?: string;
          channelUrl?: string;
          isChatOwner?: boolean;
          isChatModerator?: boolean;
        };
      }>;
      nextPageToken?: string;
      pollingIntervalMillis?: number;
    }>('/liveChatMessages', {
      liveChatId,
      part: 'snippet,authorDetails',
      maxResults: '200',
      pageToken,
    });

    return {
      messages: (data.items ?? [])
        .filter((i) => i.snippet?.displayMessage)
        .map((i) => ({
          id: i.id,
          authorChannelId: i.authorDetails?.channelId ?? null,
          authorDisplayName: i.authorDetails?.displayName ?? 'unknown',
          authorChannelUrl: i.authorDetails?.channelUrl ?? null,
          text: i.snippet?.displayMessage ?? '',
          publishedAt: i.snippet?.publishedAt ?? new Date().toISOString(),
          isOwner: Boolean(i.authorDetails?.isChatOwner),
          isModerator: Boolean(i.authorDetails?.isChatModerator),
        })),
      nextPageToken: data.nextPageToken ?? null,
      // Floor at 2s: YouTube occasionally returns 0 on an idle chat, and
      // honouring that literally is a hot loop against the quota.
      pollingIntervalMillis: Math.max(2_000, data.pollingIntervalMillis ?? 5_000),
    };
  }

  /** Recent top-level comments on a video, newest first. */
  async videoComments(videoId: string, limit = 100): Promise<CommentThreadItem[]> {
    const data = await this.request<{
      items?: Array<{
        snippet?: {
          topLevelComment?: {
            id: string;
            snippet?: {
              textOriginal?: string;
              textDisplay?: string;
              publishedAt?: string;
              authorDisplayName?: string;
              authorChannelUrl?: string;
              authorChannelId?: { value?: string };
              videoId?: string;
            };
          };
        };
      }>;
    }>('/commentThreads', {
      part: 'snippet',
      videoId,
      order: 'time',
      maxResults: String(Math.min(100, limit)),
      textFormat: 'plainText',
    });

    return (data.items ?? [])
      .map((i) => i.snippet?.topLevelComment)
      .filter((c): c is NonNullable<typeof c> => Boolean(c?.snippet?.textOriginal ?? c?.snippet?.textDisplay))
      .map((c) => ({
        id: c.id,
        authorChannelId: c.snippet?.authorChannelId?.value ?? null,
        authorDisplayName: c.snippet?.authorDisplayName ?? 'unknown',
        authorChannelUrl: c.snippet?.authorChannelUrl ?? null,
        text: c.snippet?.textOriginal ?? c.snippet?.textDisplay ?? '',
        publishedAt: c.snippet?.publishedAt ?? new Date().toISOString(),
        videoId: c.snippet?.videoId ?? videoId,
        parentId: null,
      }));
  }

  // -------------------------------------------------------------------------
  // Writing — only ever called by the orchestrator, after a human approves
  // -------------------------------------------------------------------------

  /** Posts a message to a live chat. Returns the new message's platform id. */
  async postLiveChatMessage(liveChatId: string, text: string): Promise<string> {
    const data = await this.request<{ id?: string }>(
      '/liveChatMessages',
      { part: 'snippet' },
      {
        method: 'POST',
        body: JSON.stringify({
          snippet: {
            liveChatId,
            type: 'textMessageEvent',
            textMessageDetails: { messageText: text },
          },
        }),
      },
    );
    if (!data.id) throw new YouTubeApiError('live chat post returned no id', 502, null, true);
    return data.id;
  }

  /** Replies to a video comment. Returns the new comment's platform id. */
  async replyToComment(parentCommentId: string, text: string): Promise<string> {
    const data = await this.request<{ id?: string }>(
      '/comments',
      { part: 'snippet' },
      {
        method: 'POST',
        body: JSON.stringify({ snippet: { parentId: parentCommentId, textOriginal: text } }),
      },
    );
    if (!data.id) throw new YouTubeApiError('comment reply returned no id', 502, null, true);
    return data.id;
  }
}

/** Extracts a video id from any of the URL shapes YouTube hands out. */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
    const v = url.searchParams.get('v');
    if (v) return v;
    const match = url.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]{11})/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
