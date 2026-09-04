// Control run: the SAME measurements against the pre-fix build, selecting the
// fixer by its visible text (the pre-fix markup carries no data-testid).
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://127.0.0.1:3113";
const PORTFOLIO = {success:true,userId:"u_test",items:[{id:"h_missing_1",playerName:"Ken Griffey Jr.",cardNumber:"1",quantity:1,fairMarketValue:null,totalCostBasis:100,purchasePrice:100,photos:[]}],summary:{totalValue:0,totalCost:100,totalGainLoss:-100,totalGainLossPct:-100,cardCount:1,observedValue:0,estimatedValue:0,estimatedCount:0,pendingCount:0,observedPct:0},valuation:{repricing:false,oldestValuationAt:null,oldestValuationAgeMs:null}};
const b = await chromium.launch();
const out=[];
for (const [name,vp] of [["mobile-390",{width:390,height:844}],["desktop-1280",{width:1280,height:900}]]) {
  const ctx = await b.newContext({ viewport: vp });
  const p = await ctx.newPage();
  const errs=[];
  p.on("console", m => { if(m.type()==="error"||m.type()==="warning") errs.push(m.text()); });
  p.on("pageerror", e => errs.push("PAGEERROR: "+e.message));
  await ctx.addInitScript(() => window.localStorage.setItem("hobbyiq_session_id","test-session"));
  await p.route("**/api/**", r => r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({success:true,items:[],data:[],results:[],points:[],count:0})}));
  await p.route("**/api/auth/session", r => r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({success:true,user:{id:"u_test",email:"t@e.com",name:"T"}})}));
  await p.route("**/api/portfolioiq/**", r => r.fulfill({status:500,contentType:"application/json",body:"{}"}));
  await p.route("**/api/portfolio/reprice/**", r => r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({accepted:false,status:"throttled",throttled:true,running:false})}));
  await p.route("**/api/portfolio/value-history", r => r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({success:true,asOf:new Date().toISOString(),totalDisplayable:0,observedValue:0,estimatedValue:0,points:[]})}));
  await p.route("**/api/portfolio/", r => r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(PORTFOLIO)}));
  await p.goto(`${BASE}/app/portfolio`, { waitUntil:"networkidle" });
  const fixer = p.locator('a:has-text("Fix identity"):visible').first();
  await fixer.waitFor({state:"visible", timeout:15000});
  await fixer.scrollIntoViewIfNeeded();
  const nested = await p.$$eval("a a", els => els.length);
  const box = await fixer.boundingBox();
  const hit = await p.evaluate(([x,y]) => {
    const el=document.elementFromPoint(x,y); const a=el?.closest("a");
    return {href:a?.getAttribute("href")??null, text:(a?.textContent??"").trim().slice(0,40)};
  }, [box.x+box.width/2, box.y+box.height/2]);
  const hydration = errs.filter(t=>/hydrat|validateDOMNesting|cannot be a descendant|cannot contain a nested|In HTML, <a> cannot/i.test(t));
  out.push({viewport:name, nestedAnchors:nested, hydrationErrors:hydration.map(h=>h.slice(0,180)), tapAtFixerCentreHits:hit, fixerHeightPx:Math.round(box.height)});
  await ctx.close();
}
await b.close();
console.log(JSON.stringify(out,null,2));
