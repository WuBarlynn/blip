/**
 * Summary + per-site history builders.
 *
 * Produce byte-shape-compatible `SiteHistory` and `Summary` documents (see
 * @blip/shared) from the D1 `points` table + the cached SSL/domain/status in
 * `state`, so the existing dashboard renders unchanged.
 */

import {
  overallStatus,
  type BrandConfig,
  type GroupSummary,
  type Incident,
  type HistoryPoint,
  type DailyRollup,
  type SiteHistory,
  type SiteSummary,
  type Status,
  type Summary,
  type SummaryTotals,
} from "@blip/shared";
import type { ResolvedConfig, ResolvedSite } from "./config-types.js";
import type { WorkerState } from "./state.js";
import { dailyRollups, pointsSince } from "./store.js";
import { iso, MS_PER_DAY } from "./time.js";

const HISTORY_DAYS = 7;
const ROLLUP_DAYS = 90;

function pointTimestamp(point: HistoryPoint): number {
  return Date.parse(point.t);
}

/**
 * Refresh a cached site history by appending only points collected since its
 * newest entry. A missing cache (or a cache made stale by an altered clock) is
 * rebuilt from D1, while normal ticks read only the new ten-minute window.
 */
export async function refreshSiteHistory(
  db: D1Database,
  site: ResolvedSite,
  previous: SiteHistory | null,
  now: number = Date.now(),
): Promise<SiteHistory> {
  const rawSince = now - HISTORY_DAYS * MS_PER_DAY;
  const existing = previous?.id === site.id ? previous : null;
  const newest = existing?.points.at(-1);
  const newestAt = newest ? pointTimestamp(newest) : Number.NaN;
  const canAppend = Number.isFinite(newestAt) && newestAt >= rawSince && newestAt <= now;
  const points = canAppend
    ? [
        ...existing!.points.filter((point) => pointTimestamp(point) >= rawSince),
        ...(await pointsSince(db, site.id, newestAt + 1)),
      ]
    : await pointsSince(db, site.id, rawSince);

  if (!existing || !canAppend) {
    return { id: site.id, points, daily: await dailyRollups(db, site.id, ROLLUP_DAYS) };
  }

  const today = new Date(now).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${today}T00:00:00.000Z`);
  const todayPoints = points.filter((point) => pointTimestamp(point) >= dayStart);
  const todayRollup = dailyRollup(today, todayPoints);
  const oldestDay = new Date(now - ROLLUP_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
  const daily = existing.daily.filter((rollup) => rollup.d >= oldestDay && rollup.d !== today);
  if (todayRollup) daily.push(todayRollup);

  return { id: site.id, points, daily };
}

function dailyRollup(day: string, points: HistoryPoint[]): DailyRollup | null {
  if (points.length === 0) return null;
  let up = 0;
  let down = 0;
  let degraded = 0;
  let msSum = 0;
  let msCount = 0;
  for (const point of points) {
    if (point.s === "up") up += 1;
    else if (point.s === "down") down += 1;
    else degraded += 1;
    if (point.ms !== null) {
      msSum += point.ms;
      msCount += 1;
    }
  }
  const total = points.length;
  return {
    d: day,
    up,
    down,
    degraded,
    total,
    uptime: (up + degraded * 0.5) / total,
    avgMs: msCount > 0 ? Math.round(msSum / msCount) : null,
  };
}

interface SiteStatsResult {
  uptime24h: number;
  uptime7d: number;
  uptime30d: number;
  uptime90d: number;
  avgResponse24h: number | null;
  spark: Status[];
}

function statsForPoints(points: HistoryPoint[]): { uptime: number; avgMs: number | null } {
  if (points.length === 0) return { uptime: 1, avgMs: null };
  let weight = 0;
  let msSum = 0;
  let msCount = 0;
  for (const point of points) {
    weight += point.s === "up" ? 1 : point.s === "degraded" ? 0.5 : 0;
    if (point.ms !== null) {
      msSum += point.ms;
      msCount += 1;
    }
  }
  return { uptime: weight / points.length, avgMs: msCount > 0 ? Math.round(msSum / msCount) : null };
}

function uptimeForRollups(rollups: DailyRollup[]): number {
  const total = rollups.reduce((sum, rollup) => sum + rollup.total, 0);
  return total === 0 ? 1 : rollups.reduce((sum, rollup) => sum + rollup.uptime * rollup.total, 0) / total;
}

function siteStatsFromHistory(history: SiteHistory, now: number): SiteStatsResult {
  const since24h = now - MS_PER_DAY;
  const since7d = now - HISTORY_DAYS * MS_PER_DAY;
  const p24h = history.points.filter((point) => pointTimestamp(point) >= since24h);
  const p7d = history.points.filter((point) => pointTimestamp(point) >= since7d);
  const day30 = new Date(now - 30 * MS_PER_DAY).toISOString().slice(0, 10);
  const day90 = new Date(now - ROLLUP_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
  return {
    uptime24h: statsForPoints(p24h).uptime,
    uptime7d: statsForPoints(p7d).uptime,
    uptime30d: uptimeForRollups(history.daily.filter((rollup) => rollup.d >= day30)),
    uptime90d: uptimeForRollups(history.daily.filter((rollup) => rollup.d >= day90)),
    avgResponse24h: statsForPoints(p24h).avgMs,
    spark: history.points.slice(-45).map((point) => point.s),
  };
}

function buildSiteSummary(
  site: ResolvedSite,
  state: WorkerState,
  now: number,
  history: SiteHistory | undefined,
): SiteSummary {
  const ss = state.sites[site.id];
  const stats = site.paused
    ? { uptime24h: 1, uptime7d: 1, uptime30d: 1, uptime90d: 1, avgResponse24h: null, spark: [] as Status[] }
    : history
      ? siteStatsFromHistory(history, now)
      : { uptime24h: 1, uptime7d: 1, uptime30d: 1, uptime90d: 1, avgResponse24h: null, spark: [] as Status[] };

  const status: Status = site.paused ? "up" : ss?.lastStatus ?? "down";

  const summary: SiteSummary = {
    id: site.id,
    name: site.name,
    url: site.url,
    public: site.public,
    status,
    responseTime: ss?.responseTime ?? null,
    lastChecked: ss?.lastChecked ?? iso(now),
    uptime24h: stats.uptime24h,
    uptime7d: stats.uptime7d,
    uptime30d: stats.uptime30d,
    uptime90d: stats.uptime90d,
    avgResponse24h: stats.avgResponse24h,
    spark: stats.spark,
  };

  if (site.group) summary.group = site.group;
  if (site.description) summary.description = site.description;
  if (site.tags) summary.tags = site.tags;
  if (site.paused) summary.paused = true;
  if (ss?.httpStatus !== undefined) summary.httpStatus = ss.httpStatus;
  if (ss?.error && ss.error !== "paused") summary.error = ss.error;
  if (ss?.ssl) summary.ssl = ss.ssl;
  if (ss?.domain) summary.domain = ss.domain;

  return summary;
}

export async function buildSummary(
  _db: D1Database,
  config: ResolvedConfig,
  state: WorkerState,
  incidents: Incident[],
  histories: ReadonlyMap<string, SiteHistory> = new Map(),
  now: number = Date.now(),
): Promise<Summary> {
  const siteSummaries: SiteSummary[] = [];
  for (const site of config.sites) {
    siteSummaries.push(buildSiteSummary(site, state, now, histories.get(site.id)));
  }

  // ---- totals (paused sites excluded from up/down/degraded tallies) ----
  const totals: SummaryTotals = {
    sites: siteSummaries.length,
    up: 0,
    down: 0,
    degraded: 0,
    paused: 0,
    uptime: 0,
  };
  let uptimeSum = 0;
  let uptimeCount = 0;
  for (const s of siteSummaries) {
    if (s.paused) {
      totals.paused += 1;
      continue;
    }
    if (s.status === "up") totals.up += 1;
    else if (s.status === "down") totals.down += 1;
    else totals.degraded += 1;
    uptimeSum += s.uptime24h;
    uptimeCount += 1;
  }
  totals.uptime = uptimeCount > 0 ? uptimeSum / uptimeCount : 1;

  // ---- groups ----
  const summaryById = new Map(siteSummaries.map((s) => [s.id, s]));
  const groups: GroupSummary[] = config.groups.map((g) => {
    const memberIds = config.sites.filter((s) => s.group === g.id).map((s) => s.id);
    const statuses = memberIds
      .map((id) => summaryById.get(id))
      .filter((s): s is SiteSummary => s !== undefined && !s.paused)
      .map((s) => s.status);
    const gs: GroupSummary = {
      id: g.id,
      name: g.name,
      status: overallStatus(statuses),
      siteIds: memberIds,
    };
    if (g.description) gs.description = g.description;
    if (g.icon) gs.icon = g.icon;
    return gs;
  });

  const overall = overallStatus(siteSummaries.filter((s) => !s.paused).map((s) => s.status));
  const brand: BrandConfig = config.brand ?? {};

  return {
    generatedAt: iso(now),
    brand,
    overall,
    totals,
    groups,
    sites: siteSummaries,
    incidents,
  };
}
