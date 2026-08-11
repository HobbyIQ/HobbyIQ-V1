const https = require("https");
const cheerio = require("cheerio");
const URL = process.env.BCP_URL || "https://baseballcardpedia.com/index.php/1968_Topps";
function fetch(url, depth = 0) {
  return new Promise((res, rej) => {
    if (depth > 3) return rej(new Error("too many redirects"));
    const req = https.get(url, { headers: { "User-Agent": "HobbyIQ/1.0" } }, (r) => {
      if ([301,302,307,308].includes(r.statusCode)) return res(fetch(new URL(r.headers.location, url).toString(), depth+1));
      let d = ""; r.on("data", c => d+=c); r.on("end", () => res(d));
    });
    req.on("error", rej);
  });
}
async function main() {
  const html = await fetch(URL);
  const $ = cheerio.load(html);
  const $body = $(".mw-parser-output").first();
  console.log(`.mw-parser-output has ${$body.children().length} direct children`);
  // Show first 30 children to identify structure
  $body.children().slice(0, 30).each((i, el) => {
    const tag = el.tagName || el.name;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const cls = $(el).attr("class") || "";
    console.log(`  ${i} <${tag}${cls?" class='"+cls.slice(0,60)+"'":""}> ${text.slice(0, 200)}`);
  });
  console.log(`\ntop-level <ul> count: ${$body.children("ul").length}`);
  console.log(`top-level <table> count: ${$body.children("table").length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
