// netlify/functions/feed.js
// Proxy RSS: scarica il feed della fonte richiesta, normalizza l'encoding in UTF-8
// e lo restituisce con CORS aperto. Uso: /.netlify/functions/feed?src=ansa

const FEEDS = {
  open: "https://www.open.online/feed/",
  internazionale: "https://www.internazionale.it/sitemaps/rss.xml",
  ansa: "https://www.ansa.it/sito/ansait_rss.xml",
  adnkronos: "https://www.adnkronos.com/RSS_Ultimora.xml",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const src = (event.queryStringParameters || {}).src;
  const url = FEEDS[src];
  if (!url) {
    return { statusCode: 400, headers: CORS, body: `Fonte sconosciuta: ${src}` };
  }

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NotizieTelevideo/1.0)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return { statusCode: 502, headers: CORS, body: `HTTP ${r.status} da ${src}` };
    }

    // Alcuni feed italiani sono ancora ISO-8859-1: decodifico secondo il prologo XML
    const buf = Buffer.from(await r.arrayBuffer());
    const head = buf.subarray(0, 200).toString("latin1");
    const m = head.match(/encoding=["']([\w-]+)["']/i);
    const enc = (m ? m[1] : "utf-8").toLowerCase();

    let xml;
    try {
      xml = new TextDecoder(enc).decode(buf);
    } catch {
      xml = buf.toString("utf8");
    }
    xml = xml
      .replace(/^\uFEFF/, "")
      .replace(/(<\?xml[^>]*encoding=["'])[\w-]+(["'])/i, "$1utf-8$2");

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=120",
      },
      body: xml,
    };
  } catch (e) {
    return { statusCode: 504, headers: CORS, body: `Errore su ${src}: ${e.message}` };
  }
};
