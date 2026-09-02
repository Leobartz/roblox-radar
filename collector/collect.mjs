// Papanoobhy Radar — coletor de dados do Roblox
// Roda de hora em hora no GitHub Actions. Não precisa de nenhuma dependência (só Node 20+).
//
// Uso:  node collector/collect.mjs            -> coleta de verdade
//       node collector/collect.mjs --mock     -> gera dados falsos pra testar o site sem internet
//
// Saída (pasta data/):
//   latest.json          -> todos os jogos vistos nesta rodada + métricas calculadas
//   platform.json        -> série histórica do total de jogadores online (dos jogos rastreados)
//   history/<universe>.json -> histórico por jogo (por hora nos últimos 14 dias + por dia pra sempre)

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_DIR = path.join(ROOT, 'data');
const HIST_DIR = path.join(DATA_DIR, 'history');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'my_games.json'), 'utf8'));
const MOCK = process.argv.includes('--mock');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const KEEP_HOURLY_DAYS = 14;

const SORTS = ['top-playing-now', 'up-and-coming', 'top-trending', 'top-revisited', 'fun-with-friends'];
const DEVICES = ['computer', 'high_end_phone', 'console'];

const SORT_LABEL = {
  'top-playing-now': 'Mais jogados',
  'up-and-coming': 'Em ascensão (Roblox)',
  'top-trending': 'Tendência',
  'top-revisited': 'Mais revisitados',
  'fun-with-friends': 'Com amigos',
};

// ---------- utilidades ----------
function log(...a) { console.log(new Date().toISOString(), ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJSON(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function fetchJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8', 'User-Agent': 'PapanoobhyRadar/1.0' } });
      if (r.status === 429) { log('rate limit, esperando...'); await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) { log('FALHOU', url, String(e)); return null; }
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}

// ---------- descoberta de jogos (as prateleiras da home do Roblox) ----------
async function discover() {
  const listed = new Map(); // universeId -> { lists:Set, playerCount, up, dn, rootPlaceId, name }
  for (const device of DEVICES) {
    for (const sortId of SORTS) {
      const url = `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=radar&sortId=${sortId}&device=${device}&country=all`;
      const r = await fetchJSON(url);
      const games = r?.games || [];
      log(`sort ${sortId} (${device}): ${games.length} jogos`);
      games.forEach((g, idx) => {
        if (g.isSponsored) return;
        const e = listed.get(g.universeId) || { lists: new Set(), ranks: {}, playerCount: 0, up: 0, dn: 0 };
        e.lists.add(sortId);
        if (device === 'computer') e.ranks[sortId] = idx + 1;
        e.playerCount = Math.max(e.playerCount, g.playerCount || 0);
        e.up = g.totalUpVotes || e.up; e.dn = g.totalDownVotes || e.dn;
        e.rootPlaceId = g.rootPlaceId; e.name = (g.name || '').trim();
        listed.set(g.universeId, e);
      });
      await sleep(300);
    }
  }
  return listed;
}

// ---------- meus jogos (config) ----------
function parseGameRef(ref) {
  if (typeof ref === 'number') return { placeId: ref };
  const s = String(ref).trim();
  const m = s.match(/games\/(\d+)/);
  if (m) return { placeId: Number(m[1]) };
  if (/^u:?(\d+)$/i.test(s)) return { universeId: Number(s.replace(/^u:?/i, '')) };
  if (/^\d+$/.test(s)) return { placeId: Number(s) };
  return null;
}

async function resolveMyGames() {
  const universes = new Set();
  for (const ref of CONFIG.jogos || []) {
    const p = parseGameRef(ref);
    if (!p) continue;
    if (p.universeId) { universes.add(p.universeId); continue; }
    const r = await fetchJSON(`https://apis.roblox.com/universes/v1/places/${p.placeId}/universe`);
    if (r?.universeId) universes.add(r.universeId);
  }
  for (const uid of CONFIG.usuarios || []) {
    let cursor = '';
    do {
      const r = await fetchJSON(`https://games.roblox.com/v2/users/${uid}/games?limit=50&sortOrder=Asc&cursor=${cursor}`);
      (r?.data || []).forEach(g => universes.add(g.id));
      cursor = r?.nextPageCursor || '';
    } while (cursor);
  }
  for (const gid of CONFIG.grupos || []) {
    let cursor = '';
    do {
      const r = await fetchJSON(`https://games.roblox.com/v2/groups/${gid}/games?limit=50&accessFilter=Public&sortOrder=Asc&cursor=${cursor}`);
      (r?.data || []).forEach(g => universes.add(g.id));
      cursor = r?.nextPageCursor || '';
    } while (cursor);
  }
  return [...universes];
}

// ---------- detalhes ----------
async function fetchDetails(ids) {
  const out = new Map();
  for (const c of chunk(ids, 50)) {
    const r = await fetchJSON(`https://games.roblox.com/v1/games?universeIds=${c.join(',')}`);
    (r?.data || []).forEach(d => { if (d.id) out.set(d.id, d); });
    await sleep(250);
  }
  return out;
}
async function fetchVotes(ids) {
  const out = new Map();
  for (const c of chunk(ids, 100)) {
    const r = await fetchJSON(`https://games.roblox.com/v1/games/votes?universeIds=${c.join(',')}`);
    (r?.data || []).forEach(v => out.set(v.id, v));
    await sleep(250);
  }
  return out;
}
async function fetchIcons(ids) {
  const out = new Map();
  for (const c of chunk(ids, 100)) {
    const r = await fetchJSON(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${c.join(',')}&size=150x150&format=Png&isCircular=false`);
    (r?.data || []).forEach(t => { if (t.imageUrl) out.set(t.targetId, t.imageUrl); });
    await sleep(250);
  }
  return out;
}

// ---------- histórico ----------
function loadHistory(u) { return readJSON(path.join(HIST_DIR, `${u}.json`), { u, h: [], d: [] }); }

function pushPoint(hist, ts, playing, visits, favs) {
  // evita duplicar se rodar duas vezes na mesma hora
  const last = hist.h[hist.h.length - 1];
  if (last && ts - last[0] < 20 * 60 * 1000) hist.h[hist.h.length - 1] = [ts, playing, visits, favs];
  else hist.h.push([ts, playing, visits, favs]);

  // compacta pontos velhos em resumo diário
  const cutoff = ts - KEEP_HOURLY_DAYS * DAY;
  const old = hist.h.filter(p => p[0] < cutoff);
  if (old.length) {
    hist.h = hist.h.filter(p => p[0] >= cutoff);
    const byDay = new Map();
    for (const p of old) {
      const day = new Date(p[0]).toISOString().slice(0, 10);
      const b = byDay.get(day) || { peak: 0, sum: 0, n: 0, visits: 0 };
      b.peak = Math.max(b.peak, p[1]); b.sum += p[1]; b.n++; b.visits = p[2];
      byDay.set(day, b);
    }
    for (const [day, b] of byDay) {
      const i = hist.d.findIndex(x => x[0] === day);
      const row = [day, b.peak, Math.round(b.sum / b.n), b.visits];
      if (i >= 0) hist.d[i] = row; else hist.d.push(row);
    }
    hist.d.sort((a, b) => a[0] < b[0] ? -1 : 1);
  }
}

// métricas a partir do histórico
function metrics(hist, now) {
  const h = hist.h;
  const inWindow = (from, to) => h.filter(p => p[0] >= from && p[0] < to);
  const avg = pts => pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null;
  const peak = pts => pts.length ? Math.max(...pts.map(p => p[1])) : null;
  const last24 = inWindow(now - DAY, now + HOUR);
  const prev24 = inWindow(now - 2 * DAY, now - DAY);
  const last7 = inWindow(now - 7 * DAY, now + HOUR);
  const prev7 = inWindow(now - 14 * DAY, now - 7 * DAY);
  const pct = (a, b) => (a != null && b != null && b > 0) ? Math.round((a - b) / b * 1000) / 10 : null;

  // visitas ganhas: diferença entre o ponto mais antigo dentro da janela e o mais novo
  const visitsGained = (ms) => {
    const pts = inWindow(now - ms, now + HOUR);
    if (pts.length < 2) return null;
    const span = pts[pts.length - 1][0] - pts[0][0];
    if (span < ms * 0.6) return null; // ainda não temos dados suficientes
    return Math.max(0, pts[pts.length - 1][2] - pts[0][2]);
  };
  const visits24 = visitsGained(DAY);
  const visits7 = visitsGained(7 * DAY);
  const favs24 = (() => { const pts = inWindow(now - DAY, now + HOUR); return pts.length >= 2 ? pts[pts.length - 1][3] - pts[0][3] : null; })();

  return {
    avg24: avg(last24) != null ? Math.round(avg(last24)) : null,
    peak24: peak(last24),
    peak7: peak(last7),
    g24: pct(avg(last24), avg(prev24)),           // crescimento % (média 24h vs 24h anteriores)
    g7: pct(avg(last7), avg(prev7)),              // crescimento % (média 7d vs 7d anteriores)
    visits24, visits7, favs24,
    samples: h.length,
    firstSeen: h.length ? h[0][0] : (hist.d.length ? Date.parse(hist.d[0][0]) : null),
  };
}

// ---------- mock (dados falsos pra teste) ----------
function mockData(now) {
  const genres = ['Simulation', 'RPG', 'Survival', 'Roleplay & Avatar Sim', 'Action', 'Obby & Platformer', 'Shooter', 'Sports & Racing'];
  const names = ['Roube um Ovo', 'Blox Fruits', 'Brookhaven RP', 'Adopt Me!', 'Hungry Floppas', 'Cresça um Jardim', 'DOORS', 'Fisch', 'Forsaken', 'Pule por Animais!', 'Futebol Proibido', 'Simulador de Gato Gordo', 'Yoshi Tycoon', 'Sapos Loucos', 'Pesque-o!', 'Torre do Inferno', 'RIVALES', 'Dandy World', 'Dress to Impress', 'Evade'];
  const listed = new Map(); const details = new Map(); const votes = new Map(); const icons = new Map();
  let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 120; i++) {
    const u = 1000 + i;
    const name = names[i % names.length] + (i >= names.length ? ` ${Math.floor(i / names.length) + 1}` : '');
    const ageDays = Math.floor(rnd() * 900) + 2;
    const playing = Math.floor(Math.pow(rnd(), 3) * 300000) + 50;
    const lists = new Set([SORTS[i % SORTS.length]]); if (i < 15) lists.add('top-playing-now'); if (ageDays < 40) lists.add('up-and-coming');
    listed.set(u, { lists, ranks: { [SORTS[i % SORTS.length]]: i + 1 }, playerCount: playing, up: 1000, dn: 100, rootPlaceId: 5000 + i, name });
    details.set(u, { id: u, rootPlaceId: 5000 + i, name, creator: { id: i === 4 ? 1 : 99, name: i === 4 ? 'Papanoobhy' : `Studio ${i}`, type: 'Group', hasVerifiedBadge: i % 3 === 0 }, playing, visits: Math.floor(playing * ageDays * 40 * (0.5 + rnd())), maxPlayers: 8 + (i % 30), created: new Date(now - ageDays * DAY).toISOString(), updated: new Date(now - rnd() * 10 * DAY).toISOString(), genre_l1: genres[i % genres.length], genre_l2: '', favoritedCount: Math.floor(playing * 30 * rnd()) });
    votes.set(u, { upVotes: Math.floor(playing * 20 * rnd()) + 100, downVotes: Math.floor(playing * 2 * rnd()) + 10 });
    icons.set(u, '');
    // histórico falso (15 dias por hora)
    const hist = { u, h: [], d: [] };
    const trend = (rnd() - 0.4) * 0.05;
    for (let t = 15 * 24; t >= 1; t--) {
      const ts = now - t * HOUR; const dayCycle = 1 + 0.35 * Math.sin((ts / HOUR) % 24 / 24 * Math.PI * 2);
      const p = Math.max(0, Math.round(playing * dayCycle * (1 + trend * (15 * 24 - t) / 24) * (0.9 + rnd() * 0.2)));
      const v = details.get(u).visits - Math.round(playing * 40 * t);
      pushPoint(hist, ts, p, v, Math.round(details.get(u).favoritedCount - t * 3));
    }
    writeJSON(path.join(HIST_DIR, `${u}.json`), hist);
  }
  return { listed, details, votes, icons, mine: [1004] };
}

// ---------- principal ----------
async function main() {
  const now = Date.now();
  const nowRounded = Math.round(now / HOUR) * HOUR;
  fs.mkdirSync(HIST_DIR, { recursive: true });

  let listed, details, votes, icons, mine;
  if (MOCK) {
    ({ listed, details, votes, icons, mine } = mockData(nowRounded));
  } else {
    listed = await discover();
    mine = await resolveMyGames();
    log(`descobertos ${listed.size} jogos nas prateleiras, ${mine.length} meus jogos`);
    const ids = [...new Set([...listed.keys(), ...mine])];
    details = await fetchDetails(ids);
    votes = await fetchVotes(ids);
    icons = await fetchIcons(ids);
  }

  const mineSet = new Set(mine);
  const games = [];
  let platformCCU = 0;
  for (const [u, d] of details) {
    if (!d || d.isContentRestricted || !d.name || d.name === '[TITLE UNAVAILABLE]') continue;
    const l = listed.get(u);
    const hist = loadHistory(u);
    pushPoint(hist, nowRounded, d.playing || 0, d.visits || 0, d.favoritedCount || 0);
    writeJSON(path.join(HIST_DIR, `${u}.json`), hist);
    const m = metrics(hist, nowRounded);
    const v = votes.get(u) || {};
    const ageDays = Math.max(0, Math.round((now - Date.parse(d.created)) / DAY));
    if (l?.lists?.has('top-playing-now')) platformCCU += d.playing || 0;
    games.push({
      u, p: d.rootPlaceId, name: d.name.trim(),
      creator: d.creator?.name || '?', creatorId: d.creator?.id, creatorType: d.creator?.type, verified: !!d.creator?.hasVerifiedBadge,
      icon: icons.get(u) || '',
      playing: d.playing || 0, visits: d.visits || 0, favs: d.favoritedCount || 0,
      up: v.upVotes ?? l?.up ?? 0, dn: v.downVotes ?? l?.dn ?? 0,
      maxPlayers: d.maxPlayers, created: d.created, updated: d.updated,
      genre: d.genre_l1 || d.genre || '', genre2: d.genre_l2 || '',
      ageDays, lists: l ? [...l.lists] : [], ranks: l?.ranks || {},
      mine: mineSet.has(u),
      ...m,
    });
  }
  games.sort((a, b) => b.playing - a.playing);

  // série da plataforma
  const platform = readJSON(path.join(DATA_DIR, 'platform.json'), { h: [] });
  const lastP = platform.h[platform.h.length - 1];
  if (lastP && nowRounded - lastP[0] < 20 * 60 * 1000) platform.h[platform.h.length - 1] = [nowRounded, platformCCU, games.length];
  else platform.h.push([nowRounded, platformCCU, games.length]);
  platform.h = platform.h.filter(p => p[0] > nowRounded - 400 * DAY);
  writeJSON(path.join(DATA_DIR, 'platform.json'), platform);

  const meta = readJSON(path.join(DATA_DIR, 'meta.json'), { runs: 0, firstRun: nowRounded });
  meta.runs++; meta.lastRun = nowRounded;
  writeJSON(path.join(DATA_DIR, 'meta.json'), meta);

  writeJSON(path.join(DATA_DIR, 'latest.json'), {
    updatedAt: nowRounded, runs: meta.runs, firstRun: meta.firstRun, mock: MOCK,
    sortLabels: SORT_LABEL, platformCCU, games,
  });
  log(`pronto: ${games.length} jogos, CCU total ${platformCCU}`);
}

main().catch(e => { console.error(e); process.exit(1); });
