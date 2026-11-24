// netlify/functions/feed.js
// Proxy RSS: scarica il feed della fonte richiesta, normalizza l'encoding in UTF-8
// e lo restituisce con CORS aperto. Uso: /.netlify/functions/feed?src=ansa
// Ogni fonte ha uno o più URL: si usa il primo che risponde con un feed valido.

const gnews = (q) =>
  "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=it&gl=IT&ceid=IT:it";
const bing = (q) =>
  "https://www.bing.com/news/search?format=rss&setlang=it-IT&cc=IT&q=" + encodeURIComponent(q);

const FEEDS = {
  open: ["https://www.open.online/feed/"],
  internazionale: ["https://www.internazionale.it/sitemaps/rss.xml"],
  ansa: ["https://www.ansa.it/sito/ansait_rss.xml"],
  adnkronos: ["https://www.adnkronos.com/RSS_Ultimora.xml"],

  // Viareggio: feed diretto se esiste, altrimenti Google News filtrato sulla testata
  nazione_vg: [
    "https://www.lanazione.it/viareggio/rss",
    gnews("site:lanazione.it inurl:viareggio when:7d"),
    bing("site:lanazione.it Viareggio"),
  ],
  tirreno_vg: [
    { pagina: "https://www.iltirreno.it/versilia", sezione: "/versilia/", nome: "Il Tirreno Versilia" },
    gnews("site:iltirreno.it (Viareggio OR Versilia) when:7d"),
    gnews("Il Tirreno Viareggio"),
    bing("iltirreno.it Viareggio"),
  ],
  versiliatoday: [
    "https://www.versiliatoday.it/feed/",
    gnews("site:versiliatoday.it when:7d"),
    bing("site:versiliatoday.it"),
  ],
};

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function scarica(url, ms) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "it-IT,it;q=0.9",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  // Alcuni feed italiani sono ancora ISO-8859-1: decodifico secondo il prologo XML
  const buf = Buffer.from(await r.arrayBuffer());
  const head = buf.subarray(0, 200).toString("latin1");
  const m = head.match(/encoding=["']([\w-]+)["']/i);
  const enc = (m ? m[1] : "utf-8").toLowerCase();
  let xml;
  try { xml = new TextDecoder(enc).decode(buf); } catch { xml = buf.toString("utf8"); }
  xml = xml.replace(/^(<\?xml[^>]*?)encoding=["'][\w-]+["']/i, '$1encoding="utf-8"');

  // Una pagina HTML con 200 non è un feed
  if (!/<(item|entry)[\s>]/i.test(xml)) throw new Error("non è un feed");
  return xml;
}

// Il Tirreno non ha un RSS di sezione: ricavo gli articoli dalla pagina HTML.
// Gli URL degli articoli sono del tipo /versilia/cronaca/2026/11/24/news/titolo-1.123
async function daPagina({ pagina, sezione, nome }, ms) {
  const r = await fetch(pagina, {
    headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9", Accept: "text/html" },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} pagina`);
  const html = await r.text();
  const base = new URL(pagina).origin;
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const decod = (t) => t
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;|&rsquo;/g, "’").replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

  const visti = new Map();
  const re = /<a\b[^>]*href=["']([^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1];
    if (href.startsWith("/")) href = base + href;
    if (!href.startsWith(base) || !href.includes(sezione)) continue;
    const d = href.match(/\/(\d{4})\/(\d{2})\/(\d{2})\/news\//);
    if (!d) continue;
    const titolo = decod(m[2]);
    if (titolo.length < 15) continue; // salta link-immagine e "leggi"
    if (!visti.has(href) || visti.get(href).titolo.length < titolo.length) {
      visti.set(href, { titolo, data: new Date(`${d[1]}-${d[2]}-${d[3]}T12:00:00Z`) });
    }
  }
  if (!visti.size) throw new Error("nessun articolo nella pagina");

  const items = [...visti].map(([link, v]) =>
    `<item><title>${esc(v.titolo)}</title><link>${esc(link)}</link><pubDate>${v.data.toUTCString()}</pubDate></item>`);
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>${esc(nome)}</title>${items.join("")}</channel></rss>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const src = (event.queryStringParameters || {}).src;
  const urls = FEEDS[src];
  if (!urls) return { statusCode: 400, headers: CORS, body: `Fonte sconosciuta: ${src}` };

  // Tutti gli URL partono insieme (niente attese in cascata oltre i 10 s di Netlify);
  // vince il primo valido nell'ordine di FEEDS, cioè il feed diretto se funziona.
  const tentativi = urls.map((u) => (typeof u === "string" ? scarica(u, 8000) : daPagina(u, 8000)).then((xml) => ({ xml }), (e) => ({ e: e.message })));
  const errori = [];
  for (const t of tentativi) {
    const r = await t;
    if (r.xml) {
      return {
        statusCode: 200,
        headers: {
          ...CORS,
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "public, max-age=120, s-maxage=120",
        },
        body: r.xml,
      };
    }
    errori.push(r.e);
  }
  return { statusCode: 502, headers: CORS, body: `${src} non raggiungibile (${errori.join("; ")})` };
};
