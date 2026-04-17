import { useState, useEffect, useRef } from "react";
import { API_BASE_URL } from "../api";

const SEVERITY_COLORS = {
  high: "#e53935",
  warning: "#fbc02d",
  info: "#1976d2"
};


export default function Notifications() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const lastAlertIdsRef = useRef<Set<string>>(new Set());
  const notifiedIdsRef = useRef<Set<string>>(new Set());
  const pollingRef = useRef<any>(null);

  // Request browser notification permission on mount
  useEffect(() => {
    if (window.Notification && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Fetch alerts and handle new high-severity notifications
  // Throttle polling if user has >100 alerts
  const fetchAlerts = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/alerts`);
      const data = await res.json();
      const newAlerts = data.alerts || [];
      setAlerts(newAlerts);
      setUnread(newAlerts.filter((a: any) => !a.read).length);

      // Detect new alerts
      const prevIds = lastAlertIdsRef.current;
      const newHighSeverity = newAlerts.filter(
        (a: any) =>
          a.severity === "high" &&
          !a.read &&
          !prevIds.has(a.id) &&
          !notifiedIdsRef.current.has(a.id)
      );
      // Trigger browser notification for new high-severity alerts
      if (window.Notification && Notification.permission === "granted") {
        newHighSeverity.forEach((a: any) => {
          new Notification(a.title || "HobbyIQ Alert", {
            body: a.message,
            icon: "/favicon.svg"
          });
          notifiedIdsRef.current.add(a.id);
        });
      }
      // Update last seen alert ids
      lastAlertIdsRef.current = new Set(newAlerts.map((a: any) => a.id));

      // If user has >100 alerts, set a flag to slow polling
      if (newAlerts.length > 100) {
        (window as any).__hobbyiq_alerts_poll_slow = true;
      } else {
        (window as any).__hobbyiq_alerts_poll_slow = false;
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchAlerts();
    // Poll every 10–30 seconds, or 60s if user has too many alerts
    function schedulePoll() {
      let interval;
      if ((window as any).__hobbyiq_alerts_poll_slow) {
        interval = 60000; // 60s
      } else {
        interval = 10000 + Math.floor(Math.random() * 20000); // 10–30s
      }
      pollingRef.current = setTimeout(async () => {
        await fetchAlerts();
        schedulePoll();
      }, interval);
    }
    schedulePoll();
    return () => pollingRef.current && clearTimeout(pollingRef.current);
  }, []);

  const handleBellClick = () => setOpen((v) => !v);
  const handleAlertClick = async (alertId: string) => {
    setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, read: true } : a));
    setUnread((prev) => Math.max(0, prev - 1));
    try { await fetch(`${API_BASE_URL}/api/alerts/${alertId}/read`, { method: "POST" }); } catch {}
  };

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        aria-label="Notifications"
        onClick={handleBellClick}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          position: "relative",
          padding: 0,
          margin: 0
        }}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M14 25c1.7 0 3-1.3 3-3h-6c0 1.7 1.3 3 3 3Zm8-6v-5c0-4.1-2.7-7.4-7-8V5a1 1 0 1 0-2 0v1c-4.3.6-7 3.9-7 8v5l-2 2v1h20v-1l-2-2Z" fill="#1976d2"/>
        </svg>
        {unread > 0 && (
          <span style={{
            position: "absolute",
            top: 2,
            right: 2,
            background: "#e53935",
            color: "#fff",
            borderRadius: "50%",
            fontSize: 12,
            fontWeight: 700,
            padding: "2px 6px",
            minWidth: 18,
            textAlign: "center"
          }}>{unread}</span>
        )}
      </button>
      {open && (
        <div style={{
          position: "absolute",
          right: 0,
          top: 36,
          minWidth: 320,
          maxWidth: 400,
          background: "#fff",
          border: "1.5px solid #e3eafc",
          borderRadius: 10,
          boxShadow: "0 4px 24px #0002",
          zIndex: 1000,
          padding: 0
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #eee", fontWeight: 700, color: "#1976d2", fontSize: 17 }}>Notifications</div>
          {alerts.length === 0 && (
            <div style={{ padding: 18, color: "#888", fontSize: 15 }}>No alerts</div>
          )}
          {alerts.map((a) => (
            <div
              key={a.id}
              onClick={() => handleAlertClick(a.id)}
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid #f4f4f4",
                background: a.read ? "#f7f7fa" : "#fff",
                cursor: "pointer",
                display: "flex",
                alignItems: "flex-start",
                gap: 12
              }}
            >
              <div style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                marginTop: 4,
                background: SEVERITY_COLORS[(a.severity as keyof typeof SEVERITY_COLORS)] || "#1976d2"
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: SEVERITY_COLORS[(a.severity as keyof typeof SEVERITY_COLORS)] || "#1976d2", fontSize: 15 }}>{a.title}</div>
                <div style={{ color: "#444", fontSize: 15, margin: "2px 0 2px 0" }}>{a.message}</div>
                <div style={{ color: "#888", fontSize: 13 }}>{new Date(a.timestamp).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
