// Valorant Mağaza / Gece Pazarı / Skinlerim — backend
// Şifre ASLA alınmaz. Kullanıcı Riot'un kendi giriş sayfasında giriş yapar,
// dönen URL'deki access_token buraya yapıştırılır. Token sadece bellekte tutulur.
const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SKIN_LEVEL_TYPE = "e7c63390-eda7-46e0-bb7a-a6abdacd2433"; // skin level item type
const VP = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"; // Valorant Points currency id
const sessions = new Map(); // sid -> { token, ent, puuid, shard, exp }

const LOGIN_URL =
  "https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in" +
  "&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid";

// ---- valorant-api.com önbelleği (skin adı/görsel) ----
let cache = { skinByLevel: new Map(), version: null, offers: null, at: 0 };
async function loadStatic() {
  if (Date.now() - cache.at < 3600e3 && cache.skinByLevel.size) return cache;
  const [skins, ver] = await Promise.all([
    fetch("https://valorant-api.com/v1/weapons/skins").then((r) => r.json()),
    fetch("https://valorant-api.com/v1/version").then((r) => r.json()),
  ]);
  const map = new Map();
  for (const s of skins.data) {
    const info = { name: s.displayName, icon: s.displayIcon || s.levels?.[0]?.displayIcon, tier: s.contentTierUuid };
    for (const l of s.levels) map.set(l.uuid, { ...info, icon: l.displayIcon || info.icon });
  }
  cache = { skinByLevel: map, version: ver.data.riotClientVersion, offers: cache.offers, at: Date.now() };
  return cache;
}

function riotHeaders(s, version) {
  return {
    Authorization: `Bearer ${s.token}`,
    "X-Riot-Entitlements-JWT": s.ent,
    "X-Riot-ClientPlatform": Buffer.from(
      JSON.stringify({ platformType: "PC", platformOS: "Windows", platformOSVersion: "10.0.19042.1.256.64bit", platformChipset: "Unknown" })
    ).toString("base64"),
    "X-Riot-ClientVersion": version,
  };
}
const pd = (s) => `https://pd.${s.shard}.a.pvp.net`;

function auth(req, res, next) {
  const s = sessions.get(req.headers["x-session"]);
  if (!s || s.exp < Date.now()) return res.status(401).json({ error: "Oturum süresi doldu, tekrar giriş yap." });
  req.s = s;
  next();
}

app.get("/api/login-url", (_req, res) => res.json({ url: LOGIN_URL }));

// Kullanıcı Riot girişinden sonra yönlendiği URL'yi yapıştırır
app.post("/api/login", async (req, res) => {
  try {
    const { url, shard = "eu" } = req.body;
    if (!["eu", "na", "ap", "kr"].includes(shard)) return res.status(400).json({ error: "Geçersiz bölge." });
    const m = /access_token=([^&]+)/.exec(String(url || ""));
    if (!m) return res.status(400).json({ error: "URL içinde access_token bulunamadı." });
    const token = m[1];

    const entR = await fetch("https://entitlements.auth.riotgames.com/api/token/v1", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!entR.ok) return res.status(401).json({ error: "Token geçersiz veya süresi dolmuş." });
    const ent = (await entR.json()).entitlements_token;

    const ui = await fetch("https://auth.riotgames.com/userinfo", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const sid = crypto.randomBytes(24).toString("hex");
    sessions.set(sid, { token, ent, puuid: ui.sub, shard, exp: Date.now() + 55 * 60e3 });
    const name = ui.acct ? `${ui.acct.game_name}#${ui.acct.tag_line}` : "Oyuncu";
    res.json({ sid, name });
  } catch (e) {
    res.status(500).json({ error: "Giriş başarısız: " + e.message });
  }
});

app.post("/api/logout", (req, res) => {
  sessions.delete(req.headers["x-session"]);
  res.json({ ok: true });
});

async function getOffers(s, version) {
  if (cache.offers && Date.now() - cache.at < 3600e3) return cache.offers;
  const r = await fetch(`${pd(s)}/store/v1/offers/`, { headers: riotHeaders(s, version) }).then((r) => r.json());
  const m = new Map();
  for (const o of r.Offers || []) m.set(o.OfferID, o.Cost?.[VP]);
  cache.offers = m;
  return m;
}

// Günlük mağaza + gece pazarı
app.get("/api/store", auth, async (req, res) => {
  try {
    const { skinByLevel, version } = await loadStatic();
    const h = riotHeaders(req.s, version);
    const sf = await fetch(`${pd(req.s)}/store/v3/storefront/${req.s.puuid}`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "{}" });
    if (!sf.ok) return res.status(sf.status).json({ error: "Mağaza alınamadı (" + sf.status + ")." });
    const data = await sf.json();
    const prices = await getOffers(req.s, version);

    const daily = (data.SkinsPanelLayout?.SingleItemStoreOffers || []).map((o) => {
      const id = o.Rewards[0].ItemID;
      return { id, ...(skinByLevel.get(id) || { name: "Bilinmeyen skin" }), price: o.Cost?.[VP] ?? prices.get(o.OfferID) };
    });

    const night = data.BonusStore
      ? data.BonusStore.BonusStoreOffers.map((b) => {
          const id = b.Offer.Rewards[0].ItemID;
          return {
            id, ...(skinByLevel.get(id) || { name: "Bilinmeyen skin" }),
            price: b.Offer.Cost?.[VP], discountPrice: b.DiscountCosts?.[VP], percent: b.DiscountPercent,
          };
        })
      : null;

    res.json({
      daily, dailyRemaining: data.SkinsPanelLayout?.SingleItemOffersRemainingDurationInSeconds,
      night, nightRemaining: data.BonusStore?.BonusStoreRemainingDurationInSeconds,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sahip olunan skinler
app.get("/api/skins", auth, async (req, res) => {
  try {
    const { skinByLevel, version } = await loadStatic();
    const r = await fetch(`${pd(req.s)}/store/v1/entitlements/${req.s.puuid}/${SKIN_LEVEL_TYPE}`, { headers: riotHeaders(req.s, version) });
    if (!r.ok) return res.status(r.status).json({ error: "Skinler alınamadı (" + r.status + ")." });
    const { Entitlements = [] } = await r.json();
    const seen = new Set();
    const skins = [];
    for (const e of Entitlements) {
      const s = skinByLevel.get(e.ItemID);
      if (!s || seen.has(s.name)) continue;
      seen.add(s.name);
      skins.push(s);
    }
    skins.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ count: skins.length, skins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

setInterval(() => { for (const [k, v] of sessions) if (v.exp < Date.now()) sessions.delete(k); }, 60e3);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
