import type { OverallStatus } from "@blip/shared";
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { OVERALL_DISPLAY_STATUS } from "@/lib/format";
import { relativeTime } from "@/lib/format";
import { t } from "@/lib/i18n";

const TONE: Record<OverallStatus, { wrap: string; icon: string }> = {
  operational: {
    wrap: "border-up/30 bg-up-soft",
    icon: "text-up",
  },
  degraded: {
    wrap: "border-degraded/30 bg-degraded-soft",
    icon: "text-degraded",
  },
  partial_outage: {
    wrap: "border-degraded/30 bg-degraded-soft",
    icon: "text-degraded",
  },
  major_outage: {
    wrap: "border-down/30 bg-down-soft",
    icon: "text-down",
  },
};

function OverallIcon({ status, className }: { status: OverallStatus; className?: string }) {
  const ds = OVERALL_DISPLAY_STATUS[status];
  if (ds === "up") return <CheckCircle2 className={className} />;
  if (ds === "down") return <XCircle className={className} />;
  return <AlertTriangle className={className} />;
}

interface OverallBannerProps {
  status: OverallStatus;
  generatedAt?: string;
  /** Larger hero variant for the public status page. */
  hero?: boolean;
  className?: string;
}

/** The big "all systems operational" banner. */
export function OverallBanner({ status, generatedAt, hero = false, className }: OverallBannerProps) {
  const tone = TONE[status];
  const text = t();
  const label = status === "operational" ? text.allSystemsOperational : status === "degraded" ? text.degraded : status === "partial_outage" ? text.partialOutage : text.majorOutage;
  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-xl border",
        hero ? "px-6 py-6 sm:px-8 sm:py-8" : "px-5 py-4",
        tone.wrap,
        className,
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-background/70",
          hero ? "size-14" : "size-10",
          tone.icon,
        )}
      >
        <OverallIcon status={status} className={hero ? "size-7" : "size-5"} />
      </div>
      <div className="min-w-0">
        <p className={cn("font-semibold tracking-tight", hero ? "text-2xl" : "text-lg")}>
          {label}
        </p>
        {generatedAt && (
          <p className="text-sm text-muted-foreground">{text.updated} {relativeTime(generatedAt)}</p>
        )}
      </div>
    </div>
  );
}
