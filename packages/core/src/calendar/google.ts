import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BusyInterval } from './types.js';

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiryEpochMs: number;
  email: string | null;
  scope: string;
}

export interface GoogleEventWrite {
  calendarId: string;
  eventId?: string;
  sendUpdates: 'none' | 'all' | 'externalOnly';
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
  attendees: Array<{ email: string; displayName?: string }>;
  colorId?: string;
  status?: 'confirmed' | 'cancelled';
  privateProps?: Record<string, string>;
}

export interface GoogleEventResult {
  id: string;
  htmlLink: string | null;
  summary: string;
  start: Date;
  end: Date;
  colorId?: string;
}

export interface GoogleCalendarPort {
  connected(): Promise<boolean>;
  accountEmail(): Promise<string | null>;
  listCalendars(): Promise<Array<{ id: string; summary: string; primary: boolean }>>;
  freeBusy(calendarIds: string[], start: Date, end: Date): Promise<BusyInterval[]>;
  listEvents(calendarId: string, start: Date, end: Date): Promise<GoogleEventResult[]>;
  createEvent(input: GoogleEventWrite): Promise<GoogleEventResult>;
  patchEvent(input: GoogleEventWrite & { eventId: string }): Promise<void>;
  deleteEvent(calendarId: string, eventId: string, sendUpdates: 'none' | 'all'): Promise<void>;
}

export interface GoogleOauthEnv {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function readGoogleOauthEnv(env: NodeJS.ProcessEnv = process.env): GoogleOauthEnv | null {
  const clientId = env.APEX_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.APEX_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.APEX_GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function calendarBookingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.APEX_GOOGLE_OAUTH_CLIENT_ID?.trim() && env.APEX_GOOGLE_OAUTH_CLIENT_SECRET?.trim());
}

export function buildGoogleAuthUrl(state: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const oauth = readGoogleOauthEnv(env);
  if (!oauth) return null;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', oauth.clientId);
  url.searchParams.set('redirect_uri', oauth.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export function signOauthState(secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ exp: now + 10 * 60_000, nonce: randomNonce() })).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyOauthState(state: string, secret: string, now = Date.now()): boolean {
  const [body, mac] = state.split('.');
  if (!body || !mac) return false;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  if (!timingSafeEqual(left, right)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: number };
    return typeof parsed.exp === 'number' && parsed.exp > now;
  } catch {
    return false;
  }
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2);
}

type FetchLike = typeof fetch;

export async function exchangeGoogleCode(code: string, fetchImpl: FetchLike, env: NodeJS.ProcessEnv = process.env): Promise<GoogleTokens> {
  const oauth = readGoogleOauthEnv(env);
  if (!oauth) throw new Error('Google OAuth is not configured');
  const body = new URLSearchParams({
    code,
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    redirect_uri: oauth.redirectUri,
    grant_type: 'authorization_code',
  });
  return parseTokenResponse(await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }), null);
}

export class HttpGoogleCalendar implements GoogleCalendarPort {
  constructor(private readonly deps: {
    fetch: FetchLike;
    loadTokens: () => Promise<GoogleTokens | null>;
    saveTokens: (tokens: GoogleTokens) => Promise<void>;
    now?: () => Date;
    env?: NodeJS.ProcessEnv;
  }) {}

  async connected(): Promise<boolean> {
    return Boolean(await this.deps.loadTokens());
  }

  async accountEmail(): Promise<string | null> {
    return (await this.deps.loadTokens())?.email ?? null;
  }

  async listCalendars(): Promise<Array<{ id: string; summary: string; primary: boolean }>> {
    const data = await this.get('/users/me/calendarList') as { items?: Array<{ id?: string; summary?: string; primary?: boolean }> };
    return (data.items ?? []).map((item) => ({
      id: item.id ?? '',
      summary: item.summary ?? item.id ?? '',
      primary: Boolean(item.primary),
    })).filter((item) => item.id);
  }

  async freeBusy(calendarIds: string[], start: Date, end: Date): Promise<BusyInterval[]> {
    const data = await this.send('/freeBusy', {
      method: 'POST',
      body: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        items: calendarIds.map((id) => ({ id })),
      },
    }) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> };
    const intervals: BusyInterval[] = [];
    for (const [id, calendar] of Object.entries(data.calendars ?? {})) {
      for (const busy of calendar.busy ?? []) {
        intervals.push({ start: new Date(busy.start), end: new Date(busy.end), source: id });
      }
    }
    return intervals;
  }

  async listEvents(calendarId: string, start: Date, end: Date): Promise<GoogleEventResult[]> {
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    const data = await this.get(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`) as {
      items?: Array<{ id?: string; summary?: string; htmlLink?: string; colorId?: string; status?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }>;
    };
    return (data.items ?? []).filter((item) => item.status !== 'cancelled' && item.id).map((item) => ({
      id: item.id!,
      htmlLink: item.htmlLink ?? null,
      summary: item.summary ?? '(no title)',
      start: new Date(item.start?.dateTime ?? item.start?.date ?? 0),
      end: new Date(item.end?.dateTime ?? item.end?.date ?? 0),
      colorId: item.colorId,
    }));
  }

  async createEvent(input: GoogleEventWrite): Promise<GoogleEventResult> {
    const data = await this.send(
      `/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=${input.sendUpdates}`,
      { method: 'POST', body: eventBody(input) },
    ) as { id?: string; htmlLink?: string; summary?: string };
    if (!data.id) throw new Error('Google Calendar did not return an event id');
    return {
      id: data.id,
      htmlLink: data.htmlLink ?? null,
      summary: data.summary ?? input.summary,
      start: input.start,
      end: input.end,
      colorId: input.colorId,
    };
  }

  async patchEvent(input: GoogleEventWrite & { eventId: string }): Promise<void> {
    await this.send(
      `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}?sendUpdates=${input.sendUpdates}`,
      { method: 'PATCH', body: eventBody(input) },
    );
  }

  async deleteEvent(calendarId: string, eventId: string, sendUpdates: 'none' | 'all'): Promise<void> {
    await this.send(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
      { method: 'DELETE' },
    );
  }

  private async get(path: string): Promise<unknown> {
    return this.send(path, { method: 'GET' });
  }

  private async send(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const token = await this.freshToken();
    const response = await this.deps.fetch(`https://www.googleapis.com/calendar/v3${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (init.method === 'DELETE' && (response.status === 204 || response.status === 200)) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof (data as { error?: { message?: string } }).error?.message === 'string'
        ? (data as { error: { message: string } }).error.message
        : `Google Calendar returned ${response.status}`;
      throw new Error(message);
    }
    return data;
  }

  private async freshToken(): Promise<string> {
    const tokens = await this.deps.loadTokens();
    if (!tokens) throw new Error('Google Calendar is not connected');
    const now = (this.deps.now ?? (() => new Date()))().getTime();
    if (tokens.expiryEpochMs - 60_000 > now) return tokens.accessToken;
    const oauth = readGoogleOauthEnv(this.deps.env);
    if (!oauth) throw new Error('Google OAuth is not configured');
    const refreshed = await parseTokenResponse(await this.deps.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
      }),
    }), tokens.refreshToken, tokens.email);
    await this.deps.saveTokens(refreshed);
    return refreshed.accessToken;
  }
}

async function parseTokenResponse(response: Response, refreshToken: string | null, email: string | null = null): Promise<GoogleTokens> {
  const data = await response.json().catch(() => ({})) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error || `Google token exchange returned ${response.status}`);
  }
  const nextRefresh = data.refresh_token ?? refreshToken;
  if (!nextRefresh) throw new Error('Google did not return a refresh token');
  return {
    accessToken: data.access_token,
    refreshToken: nextRefresh,
    expiryEpochMs: Date.now() + (data.expires_in ?? 3600) * 1000,
    email,
    scope: data.scope ?? GOOGLE_CALENDAR_SCOPES.join(' '),
  };
}

function eventBody(input: GoogleEventWrite): Record<string, unknown> {
  return {
    summary: input.summary,
    description: input.description,
    status: input.status ?? 'confirmed',
    start: { dateTime: input.start.toISOString(), timeZone: input.timeZone },
    end: { dateTime: input.end.toISOString(), timeZone: input.timeZone },
    attendees: input.attendees.map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName,
    })),
    colorId: input.colorId,
    extendedProperties: input.privateProps ? { private: input.privateProps } : undefined,
  };
}

export async function readGoogleAccountEmail(accessToken: string, fetchImpl: FetchLike): Promise<string | null> {
  const response = await fetchImpl('https://www.googleapis.com/calendar/v3/calendars/primary', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({})) as { id?: string };
  return data.id ?? null;
}
