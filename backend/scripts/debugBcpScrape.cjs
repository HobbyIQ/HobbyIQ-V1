const https = require("https");
const cheerio = require("cheerio");
const URL = process.env.BCP_URL || "https://baseballcardpedia.com/index.php/1998_SPx_Finite";
function fetch(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error("too many redirects"));
    const req = https.get(url, { headers: { "User-Agent": "HobbyIQ/1.0" } }, (res) => {
      if ([301,302,307,308].includes(res.statusCode)) return resolve(fetch(new URL(res.headers.location, url).toString(), depth+1));
      let d = ""; res.on("data", c => d+=c); res.on("end", () => resolve(d));
    });
    req.on("error", reject);
  });
}
async function main() {
  const html = await fetch(URL);
  const $ = cheerio.load(html);
  const $body = $(".mw-parser-output").first();
  // Look at ul index 1 and 2 (should be Youth Movement / Power Explosion / etc)
  const uls = $body.children("ul");
  console.log(`total top-level <ul>: ${uls.length}`);
  uls.slice(0, 5).each((i, ul) => {
    console.log(`\n--- <ul> index ${i}: ${$(ul).children("li").length} li ---`);
    console.log(`RAW: ${$.html(ul).slice(0, 800)}`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });
