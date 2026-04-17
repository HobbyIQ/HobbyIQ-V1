import { useEffect, useState } from "react";
import { API_BASE_URL } from "../api";

type Alert = {
  id: string;
  type: string;
  message: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
};

const severityColors: Record<Alert["severity"], string> = {
  CRITICAL: "#ff4d4f", // red
  WARNING: "#faad14",  // yellow
  INFO: "#1890ff",     // blue
};

const severityLabels: Record<Alert["severity"], string> = {
  CRITICAL: "High",
  WARNING: "Moderate",
  INFO: "Info",
};

export default function AlertsList() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/alerts`)
      .then((res) => res.json())
      .then((data) => setAlerts(data))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>Loading alerts...</div>;
  if (!alerts.length) return <div>No alerts.</div>;

  return (
    <div style={{ maxWidth: 500, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <h2>Alerts</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {alerts.map((alert) => (
          <li
            key={alert.id}
            style={{
              border: `1px solid ${severityColors[alert.severity]}`,
              background: "#fff",
              borderRadius: 6,
              marginBottom: 16,
              padding: "12px 16px",
              boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <span
              style={{
                color: severityColors[alert.severity],
                fontWeight: 600,
                fontSize: 16,
                marginBottom: 4,
              }}
            >
              {severityLabels[alert.severity]}
            </span>
            <span style={{ fontWeight: 500 }}>{alert.type}</span>
            <span style={{ color: "#333", marginTop: 4 }}>{alert.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
