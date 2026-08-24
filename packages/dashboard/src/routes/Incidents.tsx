import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import type { Incident } from "@blip/shared";
import { useIncidents, useSummary } from "@/lib/data";
import { useAuth, siteInScope } from "@/lib/auth";
import { useBrand } from "@/components/BrandProvider";
import { PageHeader } from "@/components/PageHeader";
import { IncidentRow } from "@/components/IncidentRow";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/States";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLayoutSearch } from "@/components/AppLayout";
import { t } from "@/lib/i18n";

type Filter = "all" | "open" | "resolved";

export default function Incidents() {
  const { data, error, loading, reload } = useIncidents();
  const { data: summary } = useSummary();
  const auth = useAuth();
  const search = useLayoutSearch();
  const [filter, setFilter] = useState<Filter>("all");
  const text = t();

  useBrand(summary?.brand);

  // Build a scope predicate from the summary's site list.
  const inScope = useMemo(() => {
    if (!summary) return () => true;
    const byId = new Map(summary.sites.map((s) => [s.id, s]));
    return (inc: Incident) => {
      const site = byId.get(inc.siteId);
      // Unknown site → show only when unrestricted.
      if (!site) return auth.scope == null || auth.scope === "all";
      return siteInScope(auth.scope, site);
    };
  }, [summary, auth.scope]);

  const incidents = useMemo(() => {
    const list = (data ?? []).filter(inScope);
    const q = search.trim().toLowerCase();
    return list.filter((i) => {
      if (filter !== "all" && i.state !== filter) return false;
      if (!q) return true;
      return (
        i.title.toLowerCase().includes(q) ||
        i.siteName.toLowerCase().includes(q) ||
        (i.detail ?? "").toLowerCase().includes(q)
      );
    });
  }, [data, inScope, filter, search]);

  const openCount = useMemo(
    () => (data ?? []).filter(inScope).filter((i) => i.state === "open").length,
    [data, inScope],
  );

  return (
    <div>
      <PageHeader
        title={text.incidents}
        description={text.incidentDescription}
        actions={
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <TabsList>
              <TabsTrigger value="all">{text.all}</TabsTrigger>
              <TabsTrigger value="open">
                {text.open}{openCount > 0 ? ` (${openCount})` : ""}
              </TabsTrigger>
              <TabsTrigger value="resolved">{text.resolved}</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {loading ? (
        <TableSkeleton rows={5} />
      ) : error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : incidents.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="size-5 text-up" />}
          title={
            filter === "open"
              ? text.noOpenIncidents
              : search
                ? text.noIncidentsMatch
                : text.noIncidentsRecorded
          }
          hint={text.incidentEmptyHint}
        />
      ) : (
        <div className="space-y-3">
          {incidents.map((inc) => (
            <IncidentRow key={inc.id} incident={inc} />
          ))}
        </div>
      )}
    </div>
  );
}
