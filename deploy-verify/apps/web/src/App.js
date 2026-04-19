"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = require("react");
function MissingApiUrlError() {
    return (<div style={{ color: 'red', padding: 24, fontWeight: 600, fontSize: 18, textAlign: 'center' }}>
      Error: <b>VITE_API_BASE_URL</b> is not set.<br />
      Set <b>VITE_API_BASE_URL</b> in your frontend environment configuration (.env, .env.production, or deployment settings).<br />
      The app cannot connect to the backend API.
    </div>);
}
const [page, setPage] = (0, react_1.useState)('compiq');
if (!import.meta.env.VITE_API_BASE_URL) {
    return <MissingApiUrlError />;
}
return (<AppShell_1.default page={page} setPage={setPage}>
      {page === 'home' && <PricingSection_1.default />}
      {page === 'compiq' && <CompIQ_1.default />}
      {page === 'playeriq' && <PlayerIQ_1.default />}
      {page === 'portfolioiq' && (<Card_1.default style={{ marginTop: 32, width: "100%", maxWidth: 540, textAlign: "center" }}>
          <SectionHeader_1.default sub>PortfolioIQ</SectionHeader_1.default>
          <div style={{ color: '#7fff7f', fontSize: '1.1em', margin: '1.5em 0' }}>PortfolioIQ coming soon…</div>
        </Card_1.default>)}
      {page === 'intake' && <IntakePage_1.default />}
      {page === 'dailyiq' && <DailyIQ_1.default />}
      {page === 'settings' && (<Card_1.default style={{ marginTop: 32, width: "100%", maxWidth: 540, textAlign: "center" }}>
          <SectionHeader_1.default sub>Settings / Account</SectionHeader_1.default>
          <div style={{ color: '#aaffaa', fontSize: '1.1em', margin: '1.5em 0' }}>Settings/Account coming soon…</div>
        </Card_1.default>)}
      {page === 'search' && <><PricingSection_1.default /><SearchChat_1.default /></>}
    </AppShell_1.default>);
exports.default = App;
