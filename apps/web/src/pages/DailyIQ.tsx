import React, { useEffect, useState } from "react";
import { fetchDailyIQBrief } from "../api/dailyiq";
import type { DailyIQBrief } from "../types/dailyiq";
import DailyIQPlayerCard from "../components/DailyIQPlayerCard";
import SectionHeader from "../components/SectionHeader";
import Card from "../components/Card";
import LoadingBlock from "../components/LoadingBlock";
import ErrorBlock from "../components/ErrorBlock";
import EmptyState from "../components/EmptyState";
import "./DailyIQ.css";

const DailyIQ: React.FC = () => {
  const [brief, setBrief] = useState<DailyIQBrief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchDailyIQBrief()
      .then(setBrief)
      .catch(e => setError(e.message || "Unknown error"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="dailyiq-page" style={{ width: "100%", maxWidth: 700, margin: "0 auto", padding: "2.5rem 1rem 3rem 1rem" }}>
      <SectionHeader>DailyIQ</SectionHeader>
      {loading && <LoadingBlock>Loading daily brief...</LoadingBlock>}
      {error && <ErrorBlock>{error}</ErrorBlock>}
      {!loading && !error && !brief && <EmptyState>No brief available.</EmptyState>}
      {brief && (
        <Card className="dailyiq-brief" style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
          <div className="dailyiq-date">{brief.briefDate}</div>
          <section>
            <SectionHeader sub>Verified Top Prospect Performances</SectionHeader>
            <h3 style={{ color: '#4fff4f', marginBottom: 8, marginTop: 18 }}>Hitters</h3>
            {brief.verifiedTopProspectPerformances.hitters.length === 0 && <EmptyState>No hitters today.</EmptyState>}
            {brief.verifiedTopProspectPerformances.hitters.map((entry, i) => (
              <DailyIQPlayerCard key={"hitter-" + i} entry={entry} />
            ))}
            <h3 style={{ color: '#4fff4f', marginBottom: 8, marginTop: 18 }}>Pitchers</h3>
            {brief.verifiedTopProspectPerformances.pitchers.length === 0 && <EmptyState>No pitchers today.</EmptyState>}
            {brief.verifiedTopProspectPerformances.pitchers.map((entry, i) => (
              <DailyIQPlayerCard key={"pitcher-" + i} entry={entry} />
            ))}
          </section>
          <section>
            <SectionHeader sub>Prospect Watch</SectionHeader>
            {brief.prospectWatch.length === 0 && <EmptyState>No prospect watch entries.</EmptyState>}
            {brief.prospectWatch.map((entry, i) => (
              <DailyIQPlayerCard key={"watch-" + i} entry={entry} />
            ))}
          </section>
          <section>
            <SectionHeader sub>PerformanceIQ — Hobby Movers</SectionHeader>
            {brief.hobbyMovers.length === 0 && <EmptyState>No hobby movers today.</EmptyState>}
            {brief.hobbyMovers.map((entry, i) => (
              <DailyIQPlayerCard key={"mover-" + i} entry={entry} />
            ))}
          </section>
          <section>
            <SectionHeader sub>Multi-Appearance Tracker</SectionHeader>
            {brief.multiAppearanceTracker.length === 0 && <EmptyState>No multi-appearance entries.</EmptyState>}
            {brief.multiAppearanceTracker.map((entry, i) => (
              <DailyIQPlayerCard key={"multi-" + i} entry={entry} />
            ))}
          </section>
          {brief.warnings.length > 0 && (
            <div className="dailyiq-warnings">{brief.warnings.join(" · ")}</div>
          )}
          {brief.nextActions.length > 0 && (
            <div className="dailyiq-next-actions">Next: {brief.nextActions.join(" · ")}</div>
          )}
        </Card>
      )}
    </div>
  );
};

export default DailyIQ;
