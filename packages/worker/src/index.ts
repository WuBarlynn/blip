/**
 * Blip Worker entry point.
 *
 *   scheduled(): runs every cron tick — probes each site, appends raw points to
 *     D1, refreshes the slow SSL/domain probes infrequently, reconciles
 *     incidents, and precomputes the dashboard blobs (summary/history/incidents)
 *     into the kv table.
 *
 *   fetch(): serves /data/*.json from the precomputed blobs and everything else
 *     from the static dashboard assets (SPA fallback handled by assets config).
 */

import type { Incident, SiteHistory, Summary } from "@blip/shared";
import { CONFIG } from "./config.js";
import {
  clearCookie,
  filterIncidents,
  filterSummary,
  getSession,
  historyAllowed,
  jsonAuth,
  loginResponse,
  matchPrincipal,
  meBody,
  scopeFor,
  type Scope,
} from "./auth.js";
import {
  checkDomain,
  checkHttp,
  checkSsl,
  checkTcp,
  parseHostPort,
  type CheckResult,
} from "./checks.js";
import type { Env } from "./env.js";
import { reconcile, type SiteResult } from "./incidents.js";
import { dispatchNotifications, napcatText, type NotifyEvent } from "./notify.js";
import { EMPTY_STATE, siteStateFor, type WorkerState } from "./state.js";
import { appendPoint, getKv, prunePoints, setKv } from "./store.js";
import { buildSummary, refreshSiteHistory } from "./summary.js";
import { iso, MS_PER_DAY, MS_PER_HOUR } from "./time.js";

const POINTS_RETENTION_MS = 90 * MS_PER_DAY;
const DEFAULT_SSL_REFRESH_HOURS = 6;

// ---------------------------------------------------------------------------
// scheduled
// ---------------------------------------------------------------------------

/**
 * Resolve `${ENV_VAR}` references inside a site's request headers against the
 * Worker env (secrets). gen-config embeds header values literally, so secret
 * refs like the Cloudflare Access service-token must be substituted at runtime.
 * Returns the site unchanged when it has no headers; missing vars resolve to "".
 */
function resolveSiteHeaders<T extends { headers?: Record<string, string> }>(site: T, env: Env): T {
  if (!site.headers) return site;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(site.headers)) {
    headers[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => {
      const val = env[name];
      return typeof val === "string" ? val : "";
    });
  }
  return { ...site, headers };
}

async function runChecks(env: Env, now: number): Promise<void> {
  const db = env.DB;
  const config = CONFIG;

  const refreshHours = Number(env.SSL_REFRESH_HOURS);
  const sslRefreshMs =
    (Number.isFinite(refreshHours) && refreshHours > 0 ? refreshHours : DEFAULT_SSL_REFRESH_HOURS) *
    MS_PER_HOUR;

  // 1. Load cross-run state.
  const loaded = await getKv<WorkerState>(db, "state");
  const state: WorkerState = loaded
    ? {
        version: loaded.version ?? 1,
        sites: loaded.sites ?? {},
        alerts: loaded.alerts ?? {},
        ...(loaded.updatedAt ? { updatedAt: loaded.updatedAt } : {}),
      }
    : { ...EMPTY_STATE, sites: {}, alerts: {} };

  const results = new Map<string, SiteResult>();

  // 2. Probe each site. Wrap each in try/catch so one bad site never aborts the tick.
  for (const site of config.sites) {
    if (site.paused) continue;
    try {
      const ss = siteStateFor(state, site.id);

      // --- primary availability probe ---
      let result: CheckResult;
      if (site.type === "tcp") {
        const { host, port } = parseHostPort(site.url, site.port, 80);
        result = await checkTcp(host, port, site.timeoutMs ?? config.defaults.timeoutMs);
      } else {
        result = await checkHttp(resolveSiteHeaders(site, env), config.defaults);
      }

      // Append the raw point.
      await appendPoint(db, site.id, {
        t: now,
        s: result.status,
        ms: result.responseTime,
        c: result.httpStatus,
        e: result.status === "up" ? undefined : result.error,
      });

      // Record latest snapshot into state (the summary reads from here).
      ss.lastChecked = iso(now);
      ss.responseTime = result.responseTime;
      if (result.httpStatus !== undefined) ss.httpStatus = result.httpStatus;
      else delete ss.httpStatus;
      if (result.error) ss.error = result.error;
      else delete ss.error;

      // --- slow probes: refresh only on an infrequent cadence, else reuse cache ---
      if (site.ssl) {
        const due = (ss.sslRefreshedAt ?? 0) + sslRefreshMs <= now;
        if (due) {
          const host = parseHostPort(site.url, undefined, 443).host;
          const ssl = await checkSsl(host, site.sslWarnDays ?? config.defaults.sslWarnDays);
          if (ssl) {
            ss.ssl = ssl;
            ss.sslRefreshedAt = now;
          }
        }
      } else {
        delete ss.ssl;
      }

      if (site.domain) {
        const due = (ss.domainRefreshedAt ?? 0) + sslRefreshMs <= now;
        if (due) {
          const domain = await checkDomain(
            site.url,
            site.domainWarnDays ?? config.defaults.domainWarnDays,
          );
          if (domain) {
            ss.domain = domain;
            ss.domainRefreshedAt = now;
          }
        }
      } else {
        delete ss.domain;
      }

      results.set(site.id, {
        status: result.status,
        error: result.error,
        ssl: ss.ssl,
        domain: ss.domain,
      });
    } catch (err) {
      // Defensive: record a synthetic down point so the site doesn't silently stall.
      const message = (err as Error).message || "Check crashed";
      try {
        await appendPoint(db, site.id, { t: now, s: "down", ms: null, e: message });
        const ss = siteStateFor(state, site.id);
        ss.lastChecked = iso(now);
        ss.responseTime = null;
        ss.error = message;
        results.set(site.id, { status: "down", error: message, ssl: ss.ssl, domain: ss.domain });
      } catch {
        // give up on this site for this tick
      }
    }
  }

  // 3. Prune raw points older than 90 days.
  await prunePoints(db, now - POINTS_RETENTION_MS);

  // 4. Reconcile incidents (also derives the notification events).
  const prevIncidents = (await getKv<Incident[]>(db, "incidents")) ?? [];
  const { incidents, state: nextState, events } = reconcile(prevIncidents, {
    prevState: state,
    results,
    sites: [...config.sites],
    now,
  });
  await setKv(db, "incidents", incidents);

  // 4b. Send notifications for this tick's transitions. Mutates nextState.alerts
  // for de-dup; never throws (each channel send is caught), so a failing channel
  // can't abort the blob writes below.
  const sent = await dispatchNotifications(events, config.channels, nextState, env, now);
  if (sent > 0) console.log(`notify: sent ${sent} alert(s) across ${events.length} event(s)`);

  // 5. Incrementally refresh history blobs, then derive summary statistics from
  // those in-memory histories instead of re-scanning D1's overlapping windows.
  const histories = new Map<string, SiteHistory>();
  for (const site of config.sites) {
    const previous = await getKv<SiteHistory>(db, `blob:history:${site.id}`);
    const history = await refreshSiteHistory(db, site, previous, now);
    histories.set(site.id, history);
    await setKv(db, `blob:history:${site.id}`, history);
  }
  const summary = await buildSummary(db, config, nextState, incidents, histories, now);
  await setKv(db, "blob:summary", summary);
  await setKv(db, "blob:incidents", incidents);

  // 6. Persist state.
  nextState.updatedAt = iso(now);
  await setKv(db, "state", nextState);
}

// ---------------------------------------------------------------------------
// fetch (/data API + static assets)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

async function serveData(path: string, env: Env, scope: Scope): Promise<Response | null> {
  const db = env.DB;
  const summary = await getKv<Summary>(db, "blob:summary");

  if (path === "/data/summary.json") {
    // Empty object 200 keeps the dashboard happy before the first cron tick.
    if (!summary) return jsonResponse({});
    return jsonResponse(filterSummary(summary, scope));
  }

  if (path === "/data/incidents.json") {
    const incidents = (await getKv<Incident[]>(db, "blob:incidents")) ?? [];
    if (!summary) return jsonResponse(scope === "all" ? incidents : []);
    return jsonResponse(filterIncidents(incidents, summary, scope));
  }

  const historyMatch = /^\/data\/history\/([^/]+)\.json$/.exec(path);
  if (historyMatch) {
    const id = decodeURIComponent(historyMatch[1]!);
    if (summary && !historyAllowed(id, summary, scope)) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
    const raw = await getKv<unknown>(db, `blob:history:${id}`);
    if (raw) return jsonResponse(raw);
    // Unknown id → empty history (same shape) rather than a 404 so the SPA renders.
    return jsonResponse({ id, points: [], daily: [] });
  }

  if (path === "/data/permissions.json") {
    // No permissions model in the Worker mode — dashboard tolerates 404.
    return jsonResponse({ error: "not found" }, 404);
  }

  return null;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Never throw out of scheduled — wrap the whole run.
    ctx.waitUntil(
      runChecks(env, Date.now()).catch((err) => {
        console.error("scheduled run failed:", (err as Error).message);
      }),
    );
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const access = CONFIG.access;

    // --- auth endpoints ---
    if (path === "/auth/me") {
      const session = await getSession(request, env);
      return jsonAuth(meBody(session, access.publicStatusPage, access.publicDashboard));
    }
    if (path === "/auth/login") {
      if (request.method !== "POST") return jsonAuth({ error: "method not allowed" }, 405);
      let password = "";
      try {
        const body = (await request.json()) as { password?: string };
        password = typeof body.password === "string" ? body.password : "";
      } catch {
        // empty password → 401 below
      }
      const principal = password ? matchPrincipal(password, env, access) : null;
      if (!principal) {
        return jsonAuth(
          { authenticated: false, error: "invalid password", publicStatusPage: access.publicStatusPage },
          401,
        );
      }
      return loginResponse(principal, env);
    }
    if (path === "/auth/logout") {
      const res = jsonAuth({ authenticated: false });
      res.headers.append("set-cookie", clearCookie());
      return res;
    }

    // --- NapCat OneBot HTTP event callback ---
    if (path === "/bot/napcat") {
      if (request.method !== "POST") return jsonAuth({ error: "method not allowed" }, 405);
      const token = env.NAPCAT_EVENT_TOKEN;
      const body = await request.text();
      const authorization = request.headers.get("authorization");
      const provided =
        authorization?.replace(/^Bearer\s+/i, "") ??
        request.headers.get("x-self-token") ??
        request.headers.get("access-token");
      const signature = request.headers.get("x-signature");
      let signatureMatches = false;
      if (token && signature?.startsWith("sha1=")) {
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(token),
          { name: "HMAC", hash: "SHA-1" },
          false,
          ["sign"],
        );
        const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
        const expected = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        signatureMatches = signature.slice(5) === expected;
      }
      if (!token || (provided !== token && !signatureMatches)) {
        return jsonAuth({ error: "unauthorized" }, 401);
      }
      let event: { post_type?: string; message_type?: string; group_id?: number; raw_message?: string };
      try {
        event = JSON.parse(body) as typeof event;
      } catch {
        return jsonAuth({ error: "invalid JSON" }, 400);
      }
      const groupId = String(env.NAPCAT_GROUP_ID ?? "");
      if (
        event.post_type !== "message" ||
        event.message_type !== "group" ||
        String(event.group_id) !== groupId ||
        event.raw_message?.trim() !== "状态"
      ) {
        return jsonAuth({ ok: true });
      }
      const summary = await getKv<Summary>(env.DB, "blob:summary");
      const site = summary?.sites.find((candidate) => candidate.id === "xgs");
      const apiUrl = env.NAPCAT_API_URL;
      const apiToken = env.NAPCAT_ACCESS_TOKEN;
      if (!site || !apiUrl || !apiToken) return jsonAuth({ error: "server misconfigured" }, 500);
      const statusEvent: NotifyEvent = {
        type: site.status === "up" ? "up" : "down",
        siteId: site.id,
        siteName: site.name,
        url: site.url,
        group: site.group,
        status: site.status,
        detail: site.error,
        at: new Date().toISOString(),
      };
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ group_id: Number(groupId), message: napcatText(statusEvent) }),
      });
      if (!res.ok) return jsonAuth({ error: "NapCat request failed" }, 502);
      return jsonAuth({ ok: true });
    }

    // --- data API (RBAC-filtered) ---
    if (path.startsWith("/data/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "*",
          },
        });
      }
      const session = await getSession(request, env);
      // Anonymous access (public scope) is allowed when either a public status
      // page or a public read-only dashboard is enabled.
      if (!session && !access.publicStatusPage && !access.publicDashboard) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      const scope = scopeFor(session, access);
      const res = await serveData(path, env, scope);
      if (res) return res;
      return jsonResponse({ error: "not found" }, 404);
    }

    // Everything else → static dashboard (SPA fallback from assets config).
    return env.ASSETS.fetch(request);
  },
};
