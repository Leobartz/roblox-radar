// Papanoobhy Radar — coletor de dados do Roblox
// Roda a cada 15 minutos no GitHub Actions. Não precisa de nenhuma dependência (só Node 20+).
//
// Uso:  node collector/collect.mjs            -> coleta de verdade
//       node collector/collect.mjs --mock     -> gera dados falsos pra testar o site sem internet
//
// Saída (pasta data/):
//   latest.json          -> todos os jogos vistos nesta rodada + métricas calculadas
//   platform.json        -> série histórica do total de jogadores online (dos jogos rastreados)
//   history/<universe>.json -> histórico por jogo (a cada 15 min nos últimos 14 dias + por dia pra sempre)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const HIST_DIR = path.join(DATA_DIR, 'history');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'my_games.json'), 'utf8'));
const MOCK = process.argv.includes('--mock');

const HOUR = 3600 * 1000;
const SAMPLE_INTERVAL = 15 * 60 * 1000;
const DAY = 24 * HOUR;
const KEEP_DETAILED_DAYS = 14;

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
  const listed = new Map(); // universeId -> listas, dispositivos, posições e contagem atual
  for (const device of DEVICES) {
    for (const sortId of SORTS) {
      const url = `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=radar&sortId=${sortId}&device=${device}&country=all`;
      const r = await fetchJSON(url);
      const games = r?.games || [];
      log(`sort ${sortId} (${device}): ${games.length} jogos`);
      games.forEach((g, idx) => {
        if (g.isSponsored) return;
        const e = listed.get(g.universeId) || { lists: new Set(), shelves: new Set(), ranks: {}, deviceRanks: {}, playerCount: 0, up: 0, dn: 0 };
        e.lists.add(sortId);
        e.shelves.add(`${device}:${sortId}`);
        e.deviceRanks[device] ||= {};
        e.deviceRanks[device][sortId] = idx + 1;
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

function pushPoint(hist, ts, playing, visits, favs, shelfBreadth = 0, bestRank = null) {
  // evita duplicar se o workflow rodar duas vezes no mesmo bloco de 15 minutos
  const last = hist.h[hist.h.length - 1];
  const row = [ts, playing, visits, favs, shelfBreadth, bestRank];
  if (last && ts === last[0]) hist.h[hist.h.length - 1] = row;
  else hist.h.push(row);

  // compacta pontos velhos em resumo diário
  const cutoff = ts - KEEP_DETAILED_DAYS * DAY;
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
function metrics(hist, now, platform) {
  const h = hist.h;
  const inWindow = (from, to) => h.filter(p => p[0] >= from && p[0] < to);
  const avg = pts => pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null;
  const peak = pts => pts.length ? Math.max(...pts.map(p => p[1])) : null;
  const coveredAvg = (pts, windowMs, minCoverage = 0.6) => {
    if (pts.length < 3 || pts[pts.length - 1][0] - pts[0][0] < windowMs * minCoverage) return null;
    return avg(pts);
  };
  const pct = (a, b) => (a != null && b != null && b > 0) ? Math.round((a - b) / b * 1000) / 10 : null;
  const windowPair = ms => {
    const current = inWindow(now - ms, now + SAMPLE_INTERVAL);
    const previous = inWindow(now - 2 * ms, now - ms);
    return { current, previous, currentAvg: coveredAvg(current, ms), previousAvg: coveredAvg(previous, ms) };
  };

  const w1 = windowPair(HOUR);
  const w6 = windowPair(6 * HOUR);
  const w24 = windowPair(DAY);
  const w7 = windowPair(7 * DAY);
  const last24 = w24.current;
  const last7 = w7.current;

  const latest = h[h.length - 1];
  const before = h[h.length - 2];
  const adjacent = latest && before && latest[0] - before[0] <= SAMPLE_INTERVAL * 2;
  const g15 = adjacent ? pct(latest[1], before[1]) : null;
  const gain15 = adjacent ? latest[1] - before[1] : null;
  const g1 = pct(w1.currentAvg, w1.previousAvg);
  const g6 = pct(w6.currentAvg, w6.previousAvg);
  const gain1 = w1.currentAvg != null && w1.previousAvg != null ? Math.round(w1.currentAvg - w1.previousAvg) : null;
  const gain6 = w6.currentAvg != null && w6.previousAvg != null ? Math.round(w6.currentAvg - w6.previousAvg) : null;

  const recent = h.filter(p => p[0] >= now - 2 * HOUR).slice(-5);
  const regularRecent = recent.length >= 4 && recent.every((p, i) => i === 0 || p[0] - recent[i - 1][0] <= SAMPLE_INTERVAL * 2);
  const persistence = regularRecent
    ? Math.round(recent.slice(1).filter((p, i) => p[1] > recent[i][1]).length / (recent.length - 1) * 100)
    : null;

  const platformByTime = new Map((platform?.h || []).map(p => [p[0], p[1]]));
  const shareAvg = (pts, windowMs) => {
    const shares = pts.map(p => {
      const total = platformByTime.get(p[0]);
      return total > 0 ? p[1] / total * 100 : null;
    }).filter(v => v != null);
    if (pts.length < 3 || pts[pts.length - 1][0] - pts[0][0] < windowMs * 0.6 || shares.length < pts.length * 0.6) return null;
    return shares.reduce((s, v) => s + v, 0) / shares.length;
  };
  const share = platformByTime.get(now) > 0 && latest ? latest[1] / platformByTime.get(now) * 100 : null;
  const shareG1 = pct(shareAvg(w1.current, HOUR), shareAvg(w1.previous, HOUR));
  const shareG6 = pct(shareAvg(w6.current, 6 * HOUR), shareAvg(w6.previous, 6 * HOUR));

  // visitas ganhas: diferença entre o ponto mais antigo dentro da janela e o mais novo
  const visitsGained = (ms) => {
    const pts = inWindow(now - ms, now + SAMPLE_INTERVAL);
    if (pts.length < 2) return null;
    const span = pts[pts.length - 1][0] - pts[0][0];
    if (span < ms * 0.6) return null; // ainda não temos dados suficientes
    return Math.max(0, pts[pts.length - 1][2] - pts[0][2]);
  };
  const visits24 = visitsGained(DAY);
  const visits7 = visitsGained(7 * DAY);
  const favs24 = (() => { const pts = inWindow(now - DAY, now + SAMPLE_INTERVAL); return pts.length >= 2 ? pts[pts.length - 1][3] - pts[0][3] : null; })();

  return {
    avg24: avg(last24) != null ? Math.round(avg(last24)) : null,
    peak24: peak(last24),
    peak7: peak(last7),
    g15, gain15, g1, gain1, g6, gain6, persistence,
    share: share == null ? null : Math.round(share * 10000) / 10000,
    shareG1, shareG6,
    g24: pct(w24.currentAvg, w24.previousAvg),    // crescimento % (média 24h vs 24h anteriores)
    g7: pct(w7.currentAvg, w7.previousAvg),       // crescimento % (média 7d vs 7d anteriores)
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
    const ranks = { [SORTS[i % SORTS.length]]: i + 1 };
    const shelves = new Set([...lists].map(s => `computer:${s}`));
    listed.set(u, { lists, shelves, ranks, deviceRanks: { computer: ranks }, playerCount: playing, up: 1000, dn: 100, rootPlaceId: 5000 + i, name });
    details.set(u, { id: u, rootPlaceId: 5000 + i, name, creator: { id: i === 4 ? 1 : 99, name: i === 4 ? 'Papanoobhy' : `Studio ${i}`, type: 'Group', hasVerifiedBadge: i % 3 === 0 }, playing, visits: Math.floor(playing * ageDays * 40 * (0.5 + rnd())), maxPlayers: 8 + (i % 30), created: new Date(now - ageDays * DAY).toISOString(), updated: new Date(now - rnd() * 10 * DAY).toISOString(), genre_l1: genres[i % genres.length], genre_l2: '', favoritedCount: Math.floor(playing * 30 * rnd()) });
    votes.set(u, { upVotes: Math.floor(playing * 20 * rnd()) + 100, downVotes: Math.floor(playing * 2 * rnd()) + 10 });
    icons.set(u, '');
    // histórico falso (15 dias a cada 15 minutos)
    const hist = { u, h: [], d: [] };
    const trend = (rnd() - 0.4) * 0.05;
    const samplesPerDay = DAY / SAMPLE_INTERVAL;
    for (let t = 15 * samplesPerDay; t >= 1; t--) {
      const ts = now - t * SAMPLE_INTERVAL; const dayCycle = 1 + 0.35 * Math.sin((ts / HOUR) % 24 / 24 * Math.PI * 2);
      const p = Math.max(0, Math.round(playing * dayCycle * (1 + trend * (15 * samplesPerDay - t) / samplesPerDay) * (0.9 + rnd() * 0.2)));
      const v = details.get(u).visits - Math.round(playing * 10 * t);
      pushPoint(hist, ts, p, v, Math.round(details.get(u).favoritedCount - t), shelves.size, i + 1);
    }
    writeJSON(path.join(HIST_DIR, `${u}.json`), hist);
  }
  return { listed, details, votes, icons, mine: [1004] };
}

// ---------- principal ----------
async function main() {
  const now = Date.now();
  const nowRounded = Math.floor(now / SAMPLE_INTERVAL) * SAMPLE_INTERVAL;
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
  const validDetails = [...details].filter(([, d]) => d && !d.isContentRestricted && d.name && d.name !== '[TITLE UNAVAILABLE]');
  const platformCCU = validDetails.reduce((sum, [u, d]) => sum + (listed.get(u)?.lists?.has('top-playing-now') ? (d.playing || 0) : 0), 0);

  // série da plataforma; precisa estar atualizada antes das métricas de participação de mercado
  const platform = readJSON(path.join(DATA_DIR, 'platform.json'), { h: [] });
  const lastP = platform.h[platform.h.length - 1];
  if (lastP && nowRounded === lastP[0]) platform.h[platform.h.length - 1] = [nowRounded, platformCCU, validDetails.length];
  else platform.h.push([nowRounded, platformCCU, validDetails.length]);
  platform.h = platform.h.filter(p => p[0] > nowRounded - 400 * DAY);
  writeJSON(path.join(DATA_DIR, 'platform.json'), platform);

  const meta = readJSON(path.join(DATA_DIR, 'meta.json'), { runs: 0, firstRun: nowRounded });
  for (const [u, d] of validDetails) {
    const l = listed.get(u);
    const hist = loadHistory(u);
    const previous = hist.h[hist.h.length - 1];
    const existed = hist.h.length > 0 || hist.d.length > 0;
    const shelfBreadth = l?.shelves?.size || 0;
    const allRanks = Object.values(l?.deviceRanks || {}).flatMap(r => Object.values(r));
    const bestRank = allRanks.length ? Math.min(...allRanks) : null;
    const previousBreadth = previous?.length >= 6 ? (previous[4] || 0) : null;
    const previousRank = previous?.length >= 6 ? previous[5] : null;
    pushPoint(hist, nowRounded, d.playing || 0, d.visits || 0, d.favoritedCount || 0, shelfBreadth, bestRank);
    const m = metrics(hist, nowRounded, platform);
    const shelfNewEvent = !MOCK && meta.runs >= 8 && shelfBreadth > 0
      && (!existed || (previous && nowRounded - previous[0] > 6 * HOUR) || previousBreadth === 0);
    const inferredNewAt = !MOCK && meta.runs >= 8 && m.firstSeen > meta.firstRun ? m.firstSeen : null;
    if (shelfNewEvent) hist.shelfNewAt = nowRounded;
    else if (hist.shelfNewAt == null && inferredNewAt != null) hist.shelfNewAt = inferredNewAt;
    const shelfNewAt = hist.shelfNewAt ?? null;
    const shelfNew = shelfNewAt != null && shelfNewAt <= nowRounded && nowRounded - shelfNewAt <= DAY;
    writeJSON(path.join(HIST_DIR, `${u}.json`), hist);
    const v = votes.get(u) || {};
    const ageDays = Math.max(0, Math.round((now - Date.parse(d.created)) / DAY));
    const shelfDelta = previousBreadth == null ? null : shelfBreadth - previousBreadth;
    const rankDelta = previousRank != null && bestRank != null ? previousRank - bestRank : null;
    const likeRatio = (v.upVotes ?? l?.up ?? 0) + (v.downVotes ?? l?.dn ?? 0) > 0
      ? (v.upVotes ?? l?.up ?? 0) / ((v.upVotes ?? l?.up ?? 0) + (v.downVotes ?? l?.dn ?? 0)) * 100
      : null;
    const clamp01 = n => Math.max(0, Math.min(1, n));
    const explosionReady = m.g1 != null && m.g1 >= 10 && m.gain1 >= 500 && (d.playing || 0) >= 1000 && (m.persistence ?? 0) >= 75;
    const accelerationScore = clamp01((m.g1 || 0) / 100);
    const shareScore = clamp01(Math.max(m.shareG1 || 0, m.shareG6 || 0) / 100);
    const persistenceScore = clamp01((m.persistence || 0) / 100);
    const shelfScore = clamp01((shelfNew ? 1 : 0) + Math.max(0, shelfDelta || 0) / 3 + Math.max(0, rankDelta || 0) / 20);
    const qualityScore = likeRatio == null ? 0.5 : clamp01((likeRatio - 70) / 25);
    const explosionScore = explosionReady ? Math.round(100 * (0.35 * accelerationScore + 0.25 * shareScore + 0.20 * persistenceScore + 0.10 * shelfScore + 0.10 * qualityScore)) : null;
    games.push({
      u, p: d.rootPlaceId, name: d.name.trim(),
      creator: d.creator?.name || '?', creatorId: d.creator?.id, creatorType: d.creator?.type, verified: !!d.creator?.hasVerifiedBadge,
      icon: icons.get(u) || '',
      playing: d.playing || 0, visits: d.visits || 0, favs: d.favoritedCount || 0,
      up: v.upVotes ?? l?.up ?? 0, dn: v.downVotes ?? l?.dn ?? 0,
      maxPlayers: d.maxPlayers, created: d.created, updated: d.updated,
      genre: d.genre_l1 || d.genre || '', genre2: d.genre_l2 || '',
      ageDays, lists: l ? [...l.lists] : [], ranks: l?.ranks || {},
      devices: Object.keys(l?.deviceRanks || {}), deviceRanks: l?.deviceRanks || {},
      shelfBreadth, bestRank, shelfNew, shelfNewAt, shelfDelta, rankDelta, explosionScore,
      mine: mineSet.has(u),
      ...m,
    });
  }
  games.sort((a, b) => b.playing - a.playing);

  const cadencePoints = platform.h.filter(p => p[0] >= nowRounded - 2 * HOUR);
  const cadenceGaps = cadencePoints.slice(1).map((p, i) => p[0] - cadencePoints[i][0]);
  const cadence = {
    samples2h: cadencePoints.length,
    targetSamples2h: 9,
    maxGapMinutes: cadenceGaps.length ? Math.round(Math.max(...cadenceGaps) / 60000) : null,
    explosionReady: games.some(g => g.g1 != null && g.gain1 != null && g.persistence != null),
  };

  meta.runs++; meta.lastRun = nowRounded;
  writeJSON(path.join(DATA_DIR, 'meta.json'), meta);

  writeJSON(path.join(DATA_DIR, 'latest.json'), {
    updatedAt: nowRounded, runs: meta.runs, firstRun: meta.firstRun, mock: MOCK,
    sortLabels: SORT_LABEL, platformCCU, cadence, games,
  });
  log(`pronto: ${games.length} jogos, CCU total ${platformCCU}`);
}

main().catch(e => { console.error(e); process.exit(1); });
