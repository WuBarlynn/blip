import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  ShieldCheck,
  Globe,
  Clock,
  Gauge,
} from "lucide-react";
import type { HistoryPoint, SiteSummary } from "@blip/shared";
import { useSummary, useHistory } from "@/lib/data";
import { useAuth, siteInScope } from "@/lib/auth";
import { useBrand } from "@/components/BrandProvider";
import { StatusBadge } from "@/components/StatusBadge";
import { UptimeBar } from "@/components/UptimeBar";
import { ResponseChart } from "@/components/charts/ResponseChart";
import { UptimeChart } from "@/components/charts/UptimeChart";
import { EmptyState, ErrorState } from "@/components/States";
import { IncidentRow } from "@/components/IncidentRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  responseMs,
  uptimePct,
  uptimeColor,
  siteDisplayStatus,
  dateTime,
  relativeTime,
  expiryChip,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

type Window = "24h" | "7d" | "30d";

function StatPill({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5">
      <span className="text-muted-foreground">{icon}</span>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("text-sm font-semibold tabular-nums", tone)}>{value}</p>
      </div>
    </div>
  );
}

function ExpiryCard({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  rows: { label: string; value: React.ReactNode }[] | null;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <span className="text-muted-foreground">{icon}</span>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows ? (
          <dl className="space-y-2.5 text-sm">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="text-right font-medium">{r.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Not monitored for this site.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Slice the raw history points into an approximate trailing window. */
function pointsInWindow(points: HistoryPoint[], window: Window): HistoryPoint[] {
  const now = Date.now();
  const spanMs =
    window === "24h" ? 24 * 3600e3 : window === "7d" ? 7 * 86400e3 : 30 * 86400e3;
  const cutoff = now - spanMs;
  const filtered = points.filter((p) => {
    const t = new Date(p.t).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  // If raw points don't reach back far enough (7d/30d), fall back to all points.
  return filtered.length > 1 ? filtered : points;
}

export default function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: summary, loading: summaryLoading } = useSummary();
  const { data: history, loading: historyLoading, error: historyError, reload } = useHistory(id);
  const auth = useAuth();
  const text = t();
  const [window, setWindow] = useState<Window>("24h");

  useBrand(summary?.brand);

  const site: SiteSummary | undefined = useMemo(
    () => summary?.sites.find((s) => s.id === id),
    [summary, id],
  );

  const incidents = useMemo(
    () => (summary?.incidents ?? []).filter((i) => i.siteId === id),
    [summary, id],
  );

  if (summaryLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }

  if (!site) {
    return (
      <div className="space-y-6">
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft className="size-4" /> {text.back}
          </Link>
        </Button>
        <EmptyState title={text.siteNotFound} hint={text.siteNotFoundHint} />
      </div>
    );
  }

  if (!siteInScope(auth.scope, site)) {
    return (
      <div className="space-y-6">
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft className="size-4" /> {text.back}
          </Link>
        </Button>
        <EmptyState
          title={text.siteAccessDenied}
          hint={text.siteAccessDeniedHint}
        />
      </div>
    );
  }

  const ds = siteDisplayStatus(site);
  const windowedPoints = history ? pointsInWindow(history.points, window) : [];

  const sslChip = site.ssl ? expiryChip(site.ssl.daysRemaining, site.ssl.expiringSoon) : null;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to="/">
          <ArrowLeft className="size-4" /> {text.overview}
        </Link>
      </Button>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{site.name}</h1>
            <StatusBadge status={ds} />
          </div>
          <a
            href={site.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
          >
            {site.url}
            <ExternalLink className="size-3.5" />
          </a>
          {site.error && (
            <p className="mt-2 max-w-xl rounded-md bg-down-soft px-3 py-1.5 text-sm text-down">
              {site.error}
            </p>
          )}
        </div>
      </div>

      {/* Stat pills */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatPill
          icon={<Clock className="size-4" />}
          label={text.siteResponseTime}
          value={responseMs(site.responseTime)}
        />
        <StatPill
          icon={<Gauge className="size-4" />}
          label={text.uptime24h}
          value={uptimePct(site.uptime24h)}
          tone={uptimeColor(site.uptime24h)}
        />
        <StatPill
          icon={<Gauge className="size-4" />}
          label={text.uptime7d}
          value={uptimePct(site.uptime7d)}
          tone={uptimeColor(site.uptime7d)}
        />
        <StatPill
          icon={<Gauge className="size-4" />}
          label={text.uptime30d}
          value={uptimePct(site.uptime30d)}
          tone={uptimeColor(site.uptime30d)}
        />
        <StatPill
          icon={<Gauge className="size-4" />}
          label={text.uptime90d}
          value={uptimePct(site.uptime90d)}
          tone={uptimeColor(site.uptime90d)}
        />
      </div>

      {/* 90-day strip */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>{text.last90Days}</CardTitle>
        </CardHeader>
        <CardContent>
          <UptimeBar
            daily={history?.daily}
            spark={site.spark}
            sparkTimes={site.sparkTimes}
            days={90}
            showLegend
            dateOnly
          />
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="response">
        <TabsList>
          <TabsTrigger value="response">{text.siteResponseTime}</TabsTrigger>
          <TabsTrigger value="uptime">{text.uptime}</TabsTrigger>
          <TabsTrigger value="ssl">{text.sslDomain}</TabsTrigger>
          <TabsTrigger value="incidents">
            {text.incidents}
            {incidents.length > 0 && (
              <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px]">
                {incidents.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="response">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>{text.siteResponseTime}</CardTitle>
              <Select value={window} onValueChange={(v) => setWindow(v as Window)}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">{text.last24h}</SelectItem>
                  <SelectItem value="7d">{text.last7days}</SelectItem>
                  <SelectItem value="30d">{text.last30days}</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              {historyLoading ? (
                <Skeleton className="h-[260px] w-full" />
              ) : historyError && !history ? (
                <ErrorState message={historyError.message} onRetry={reload} />
              ) : (
                <ResponseChart points={windowedPoints} daily={window !== "24h"} />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="uptime">
          <Card>
            <CardHeader>
              <CardTitle>{text.dailyUptime}</CardTitle>
            </CardHeader>
            <CardContent>
              {historyLoading ? (
                <Skeleton className="h-[260px] w-full" />
              ) : (
                <UptimeChart daily={history?.daily ?? []} />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ssl">
          <div className="grid gap-4 sm:grid-cols-2">
            <ExpiryCard
              title={text.tlsCertificate}
              icon={<ShieldCheck className="size-4" />}
              rows={
                site.ssl
                  ? [
                      {
                        label: text.expires,
                        value: dateTime(site.ssl.validTo),
                      },
                      {
                        label: text.remaining,
                        value: (
                          <span className={cn("rounded-full px-2 py-0.5", sslChip?.tone)}>
                            {sslChip?.label}
                          </span>
                        ),
                      },
                      ...(site.ssl.issuer ? [{ label: text.issuer, value: site.ssl.issuer }] : []),
                      ...(site.ssl.subject ? [{ label: text.subject, value: site.ssl.subject }] : []),
                    ]
                  : null
              }
            />
            <ExpiryCard
              title={text.domainRegistration}
              icon={<Globe className="size-4" />}
              rows={
                site.domain
                  ? [
                      { label: text.expires, value: dateTime(site.domain.expiresAt) },
                      {
                        label: text.remaining,
                        value: text.daysRemaining(site.domain.daysRemaining),
                      },
                      ...(site.domain.registrar
                        ? [{ label: text.registrar, value: site.domain.registrar }]
                        : []),
                    ]
                  : null
              }
            />
          </div>
        </TabsContent>

        <TabsContent value="incidents">
          {incidents.length === 0 ? (
            <EmptyState title={text.noIncidentsRecorded} hint={text.noIncidentsHealthy} />
          ) : (
            <div className="space-y-3">
              {incidents.map((inc) => (
                <IncidentRow key={inc.id} incident={inc} hideSite />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <p className="text-xs text-muted-foreground">
        {text.lastChecked} {dateTime(site.lastChecked)} · {relativeTime(site.lastChecked)}
      </p>
    </div>
  );
}
