




import SearchChat from "./components/SearchChat";
import PricingSection from "./components/PricingSection";
import CompIQ from "./pages/CompIQ";
import PlayerIQ from "./pages/PlayerIQ";
import DailyIQ from "./pages/DailyIQ";
import AppShell from "./components/AppShell";
import Card from "./components/Card";
import SectionHeader from "./components/SectionHeader";
import { useState } from "react";
import IntakePage from "./pages/IntakePage";

function MissingApiUrlError() {
  return (
    <div style={{ color: 'red', padding: 24, fontWeight: 600, fontSize: 18, textAlign: 'center' }}>
      Error: <b>VITE_API_BASE_URL</b> is not set.<br />
      Set <b>VITE_API_BASE_URL</b> in your frontend environment configuration (.env, .env.production, or deployment settings).<br />
      The app cannot connect to the backend API.
    </div>
  );
}

  const [page, setPage] = useState<'home' | 'compiq' | 'playeriq' | 'portfolioiq' | 'dailyiq' | 'settings' | 'intake'>('compiq');
  if (!import.meta.env.VITE_API_BASE_URL) {
    return <MissingApiUrlError />;
  }
  return (
    <AppShell page={page} setPage={setPage}>
      {page === 'home' && <PricingSection />}
      {page === 'compiq' && <CompIQ />}
      {page === 'playeriq' && <PlayerIQ />}
      {page === 'portfolioiq' && (
        <Card style={{ marginTop: 32, width: "100%", maxWidth: 540, textAlign: "center" }}>
          <SectionHeader sub>PortfolioIQ</SectionHeader>
          <div style={{ color: '#7fff7f', fontSize: '1.1em', margin: '1.5em 0' }}>PortfolioIQ coming soon…</div>
        </Card>
      )}
      {page === 'intake' && <IntakePage />}
      {page === 'dailyiq' && <DailyIQ />}
      {page === 'settings' && (
        <Card style={{ marginTop: 32, width: "100%", maxWidth: 540, textAlign: "center" }}>
          <SectionHeader sub>Settings / Account</SectionHeader>
          <div style={{ color: '#aaffaa', fontSize: '1.1em', margin: '1.5em 0' }}>Settings/Account coming soon…</div>
        </Card>
      )}
      {page === 'search' && <><PricingSection /><SearchChat /></>}
    </AppShell>
  );
}

export default App;
