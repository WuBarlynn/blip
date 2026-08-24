import { useMemo } from "react";
import type { DailyRollup, Status } from "@blip/shared";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dateOnly, dateTime, uptimePct } from "@/lib/format";
import { t } from "@/lib/i18n";

/** One bar in the strip: a day's worth of status, or "no data". */
interface Bucket {
  key: string;
  status: Status | "empty";
  uptime: number | null;
  label: string;
}

const STATUS_COLOR: Record<Status | "empty", string> = {
  up: "bg-up",
  degraded: "bg-degraded",
  down: "bg-down",
  empty: "bg-border",
};

function dailyToBucket(day: DailyRollup): Bucket {
  let status: Status = "up";
  if (day.total === 0) {
    return { key: day.d, status: "up", uptime: 1, label: day.d };
  }
  if (day.down > 0 && day.uptime < 0.5) status = "down";
  else if (day.down > 0 || day.degraded > 0 || day.uptime < 1) status = "degraded";
  return { key: day.d, status, uptime: day.uptime, label: day.d };
}

interface UptimeBarProps {
  /** Daily rollups (oldest → newest). The last `days` are shown. */
  daily?: DailyRollup[];
  /** Fallback recent status buckets (oldest → newest) when no rollups exist. */
  spark?: Status[];
  /** Timestamps aligned with `spark` for the fallback tooltip. */
  sparkTimes?: string[];
  /** Number of bars to render (right-aligned, padded with empties). */
  days?: number;
  /** Bar height. */
  className?: string;
  /** Show the date range caption below the strip. */
  showLegend?: boolean;
  /** Detailed pages show daily rollups without a clock time. */
  dateOnly?: boolean;
}

/**
 * Statuspage / Upptime-style uptime strip: thin bars colored by daily status,
 * each with a hover tooltip showing the date + uptime %. Right-aligned to
 * "today"; missing history is padded with neutral "no data" bars.
 */
export function UptimeBar({
  daily,
  spark,
  sparkTimes,
  days = 90,
  className,
  showLegend = false,
  dateOnly: showDateOnly = false,
}: UptimeBarProps) {
  const text = t();
  const buckets = useMemo<Bucket[]>(() => {
    let source: Bucket[];
    if (daily && daily.length > 0) {
      source = daily.slice(-days).map(dailyToBucket);
    } else if (spark && spark.length > 0) {
      const start = Math.max(0, spark.length - days);
      source = spark.slice(start).map((s, i) => ({
        key: `s${start + i}`,
        status: s,
        uptime: s === "up" ? 1 : s === "degraded" ? 0.5 : 0,
        label: sparkTimes?.[start + i] ?? "",
      }));
    } else {
      source = [];
    }
    // Left-pad with empties so the strip always has `days` bars.
    const pad = Math.max(0, days - source.length);
    const empties: Bucket[] = Array.from({ length: pad }, (_, i) => ({
      key: `e${i}`,
      status: "empty",
      uptime: null,
      label: "",
    }));
    return [...empties, ...source];
  }, [daily, spark, sparkTimes, days]);

  const hasEarlierData = buckets.some((bucket) => bucket.status === "empty");

  return (
    <div className="w-full">
      <TooltipProvider delayDuration={80}>
        <div className={cn("flex h-8 w-full items-stretch gap-[2px]", className)}>
          {buckets.map((b) => (
            <Tooltip key={b.key}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "h-full min-w-[2px] flex-1 rounded-[2px] transition-opacity hover:opacity-70",
                    STATUS_COLOR[b.status],
                  )}
                  aria-label={b.label ? `${b.label}: ${uptimePct(b.uptime)} ${text.uptime}` : text.noData}
                />
              </TooltipTrigger>
              <TooltipContent>
                {b.status === "empty" ? (
                  <span className="text-muted-foreground">{text.noData}</span>
                ) : (
                  <div className="space-y-0.5 text-center">
                    {b.label && <div className="font-medium">{showDateOnly ? dateOnly(b.label) : dateTime(b.label)}</div>}
                    <div className="text-muted-foreground">{uptimePct(b.uptime)} {text.uptime}</div>
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
      {showLegend && buckets.some((bucket) => bucket.label) && (
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{hasEarlierData ? text.earlier : text.daysAgo(days)}</span>
          <span>{text.today}</span>
        </div>
      )}
    </div>
  );
}
