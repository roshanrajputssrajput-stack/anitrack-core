// AniTrack v12 — Full featured with MAL sync, watch sessions, quick rating,
// rewatch history, and resume-to-timestamp.

const STORAGE_KEY = 'anitrack_v3_entries';
const PENDING_RESUME_KEY = 'anitrack_pending_resume';
const SETTINGS_KEY = 'anitrack_settings';
const THEME_KEY = 'anitrack_theme';
const FILE_SIGNATURE = 'ANITRACK_V3_BACKUP';
const JIKAN_BASE = 'https://api.jikan.moe/v4';
const MAL_API = 'https://api.myanimelist.net/v2';

// ─── JIKAN API ───────────────────────────────────────────────
const jikanCache = {};

// Builds a few fallback search strings from a messy auto-detected title,
// so a failed exact match doesn't mean "give up" — it means "try smarter".
function buildTitleCandidates(title) {
  const out = [title];
  let clean = title.replace(/[_]+/g,' ').replace(/\s+/g,' ').trim();
  if (clean !== title) out.push(clean);
  // strip season/part/cour/dub-sub noise words and trailing numbers
  const stripped = clean
    .replace(/\b(dub|sub|dubbed|subbed)\b/gi,'')
    .replace(/\b(season|part|cour)\s*\d*/gi,'')
    .replace(/\bS\d+\b/gi,'')
    .replace(/\s+/g,' ').trim();
  if (stripped && stripped !== clean) out.push(stripped);
  // first 5 words only — franchise/root title, drops long subtitle noise
  const words = clean.split(' ');
  if (words.length > 5) out.push(words.slice(0,5).join(' '));
  return [...new Set(out.filter(Boolean))];
}

async function jikanQuery(q) {
  const res = await fetch(`${JIKAN_BASE}/anime?q=${encodeURIComponent(q)}&limit=1&sfw=false`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.data && data.data[0] ? data.data[0] : null;
}

async function jikanFullDetails(malId) {
  const res = await fetch(`${JIKAN_BASE}/anime/${malId}`);
  if (!res.ok) return null;
  const a = (await res.json()).data;
  if (!a) return null;
  return {
    malId: a.mal_id,
    title: a.title_english || a.title,
    coverImage: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
    totalEps: a.episodes || null,
    malScore: a.score,
    genres: (a.genres||[]).map(g=>g.name),
    studio: a.studios?.[0]?.name || '',
    airingStatus: a.status,
    duration: a.duration,
    synopsis: a.synopsis ? a.synopsis.slice(0,200)+'...' : '',
    broadcastDay: a.broadcast?.day || null,
    broadcastTime: a.broadcast?.time || null,
    broadcastTimezone: a.broadcast?.timezone || null
  };
}

// Shared confidence gate for every place that auto-links a malId without
// the user picking from a list (searchJikan's auto-save path, and
// resyncOldAnime's bulk linking). Requires either a very high score
// (near-exact match) or a clear margin over the runner-up — a same-or-
// similar score against a second candidate means the query was ambiguous
// (e.g. a franchise word matching several entries), and auto-linking one
// of them risks attaching progress to the wrong show. Manual linking via
// the Link modal is exempt — the user is explicitly choosing there.
function isConfidentMatch(results) {
  const top = results[0], second = results[1];
  if (!top || top._score < 0.6) return false;
  if (second && top._score < 0.9 && (top._score - second._score) < 0.12) return false;
  return true;
}

// This is the auto-search that runs on every manual "Save This Episode" —
// it used to trust Jikan's raw first result with zero confidence check
// (single source, no scoring). Now it uses the same confident Jikan+AniList
// matcher as the Link modal / bulk resync, then pulls full details by malId
// once it actually knows which anime it is.
async function searchJikan(title) {
  const key = title.toLowerCase().trim();
  if (jikanCache[key]) return jikanCache[key];

  const candidates = buildTitleCandidates(title);
  let match = null;
  for (const q of candidates) {
    const { results } = await searchAnimeMulti(q, 5);
    if (isConfidentMatch(results)) { match = results[0]; break; }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!match) return null;

  const result = await jikanFullDetails(match.malId);
  if (!result) return null;
  jikanCache[key] = result;
  return result;
}

async function _unused_searchJikan_old(title) {
  const key = title.toLowerCase().trim();
  if (jikanCache[key]) return jikanCache[key];
  const candidates = buildTitleCandidates(title);
  let a = null;
  for (const q of candidates) {
    try {
      await new Promise(r => setTimeout(r, 450)); // rate limit
      a = await jikanQuery(q);
      if (a) break;
    } catch(e) { console.log('Jikan error:', e.message); }
  }
  if (!a) return null;
  const result = {
    malId: a.mal_id,
    title: a.title_english || a.title,
    coverImage: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
    totalEps: a.episodes || null,
    malScore: a.score,
    genres: (a.genres||[]).map(g=>g.name),
    studio: a.studios?.[0]?.name || '',
    airingStatus: a.status,
    duration: a.duration,
    synopsis: a.synopsis ? a.synopsis.slice(0,200)+'...' : '',
    broadcastDay: a.broadcast?.day || null,
    broadcastTime: a.broadcast?.time || null,
    broadcastTimezone: a.broadcast?.timezone || null
  };
  jikanCache[key] = result;
  return result;
}
function parseEpDuration(durationStr) {
  if (!durationStr) return 24;
  const m = durationStr.match(/(\d+)\s*min/);
  return m ? parseInt(m[1]) : 24;
}


// ─── STORAGE ─────────────────────────────────────────────────
async function getEntries() { return new Promise(r=>chrome.storage.local.get(STORAGE_KEY,d=>r(d[STORAGE_KEY]||[]))); }
async function saveEntries(e) { return new Promise(r=>chrome.storage.local.set({[STORAGE_KEY]:e},r)); }

const MANGA_STORAGE_KEY = 'anitrack_manga_entries';
async function getMangaEntries() { return new Promise(r=>chrome.storage.local.get(MANGA_STORAGE_KEY,d=>r(d[MANGA_STORAGE_KEY]||[]))); }
async function saveMangaEntries(e) { return new Promise(r=>chrome.storage.local.set({[MANGA_STORAGE_KEY]:e},r)); }

function mangaRow(e, index) {
  const row = document.createElement('div');
  row.className = 'anime-card';
  if (libraryHasAnimatedOnce === false) row.style.animationDelay = `${Math.min(index * 25, 300)}ms`;
  else row.style.animation = 'none';
  row.style.gridTemplateColumns = '1fr auto';
  const statusIcon = { reading: '📖', completed: '✅', dropped: '🚫' }[e.status] || '📖';
  row.innerHTML = `
    <div style="min-width:0">
      <div style="font-size:13px;font-weight:700;color:var(--text-primary)">${escapeHtml(e.title)}</div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">Chapter ${escapeHtml(e.chapter)} · ${escapeHtml(e.hostname||'')}</div>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      <button class="btn-icon manga-status" data-id="${e.id}" title="Cycle status: Reading → Completed → Dropped">${statusIcon}</button>
      <button class="btn-icon manga-open" data-url="${escapeHtml(e.url)}">▶</button>
      <button class="btn-icon manga-delete" data-id="${e.id}">🗑</button>
    </div>`;
  row.querySelector('.manga-open').addEventListener('click', ev => chrome.tabs.create({ url: ev.currentTarget.dataset.url }));
  row.querySelector('.manga-delete').addEventListener('click', async ev => {
    const id = ev.currentTarget.dataset.id; // capture BEFORE await — currentTarget is nulled by the browser once dispatch finishes
    const updated = (await getMangaEntries()).filter(m => m.id !== id);
    await saveMangaEntries(updated);
    renderManga();
  });
  row.querySelector('.manga-status').addEventListener('click', async ev => {
    const id = ev.currentTarget.dataset.id; // same fix — capture before the await below
    const cycle = { reading: 'completed', completed: 'dropped', dropped: 'reading' };
    const all = await getMangaEntries();
    const m = all.find(x => x.id === id);
    if (m) { m.status = cycle[m.status] || 'reading'; await saveMangaEntries(all); renderManga(); }
  });
  return row;
}

function mangaSection(title, entries) {
  if (!entries.length) return null;
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '10px';
  wrap.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.05em;padding:8px 10px 4px">${title} (${entries.length})</div>`;
  entries.forEach((e,i) => wrap.appendChild(mangaRow(e,i)));
  return wrap;
}

async function renderManga() {
  const entries = await getMangaEntries();
  const container = document.getElementById('manga-list');
  container.innerHTML = '';
  if (!entries.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📖</div><p>No manga tracked yet.</p><p class="empty-sub">Reading a whitelisted manga site auto-detects it here — separately from anime.</p></div>';
    return;
  }
  entries.sort((a,b) => (b.savedAt||0) - (a.savedAt||0));
  const reading = entries.filter(e => e.status === 'reading' || !e.status);
  const completed = entries.filter(e => e.status === 'completed');
  const dropped = entries.filter(e => e.status === 'dropped');
  [
    mangaSection('📖 Reading', reading),
    mangaSection('✅ Completed', completed),
    mangaSection('🚫 Dropped', dropped)
  ].filter(Boolean).forEach(s => container.appendChild(s));
}

// One-click cleanup for entries that got duplicated (the actual root cause
// is fixed in background.js now, but this cleans up ones already created).
// Groups by malId when present, otherwise normalized title. Keeps the best
// candidate per group — prefers one with a malId+image, then highest
// episode progress, then most recently saved — and removes the rest.
// Re-cleans titles that predate the Chapter/Episode-stripping fix (things
// like "Redo of Healer, Chapter 40" stored as the literal title, one entry
// per chapter). Extracts the real title + episode/chapter number from the
// old messy title text, so mergeDuplicateEntries can then actually
// recognize them as the same show and merge them.
function repairExtractEpisode(text) {
  if (!text) return null;
  const patterns = [
    /chapter\s*#?(\d{1,4}(?:\.\d+)?)/i,
    /episode\s*#?(\d{1,4}(?:\.\d+)?)/i,
    /\bep\.?\s*#?(\d{1,4}(?:\.\d+)?)\b/i
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return parseFloat(m[1]); }
  return null;
}
function repairCleanTitle(text) {
  if (!text) return text;
  return text
    .replace(/,?\s*chapter\s*#?\d{1,4}(?:\.\d+)?.*/i, '')
    .replace(/episode\s*#?\d{1,4}(?:\.\d+)?.*/i, '')
    .replace(/\bep\.?\s*#?\d{1,4}(?:\.\d+)?\b.*/i, '')
    .replace(/^[\s\-–—|,:.]+|[\s\-–—|,:.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
async function repairOldTitles() {
  const entries = await getEntries();
  let repaired = 0;
  entries.forEach(e => {
    const cleaned = repairCleanTitle(e.title);
    if (cleaned && cleaned !== e.title && cleaned.length >= 3) {
      const ep = repairExtractEpisode(e.title);
      e.title = cleaned;
      if (ep) e.episode = String(ep);
      repaired++;
    }
  });
  if (repaired) await saveEntries(entries);
  return repaired;
}

async function mergeDuplicateEntries() {
  const entries = await getEntries();
  const groups = new Map();
  entries.forEach(e => {
    // Season is now part of the identity key — a malId shared across
    // seasons (some MAL entries don't split by season) should NOT get
    // merged together, or Season 1's progress and Season 2's progress
    // would collapse into a single entry and one of them silently wins.
    const season = e.season || '1';
    const key = e.malId ? `mal_${e.malId}_s${season}` : `title_${e.title.toLowerCase().trim()}_s${season}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  });

  const kept = [];
  let removedCount = 0;
  groups.forEach(group => {
    if (group.length === 1) { kept.push(group[0]); return; }
    group.sort((a,b) => {
      if (!!b.malId - !!a.malId !== 0) return !!b.malId - !!a.malId; // has malId first
      if ((parseInt(b.episode)||0) - (parseInt(a.episode)||0) !== 0) return (parseInt(b.episode)||0) - (parseInt(a.episode)||0);
      return (b.savedAt||0) - (a.savedAt||0);
    });
    kept.push(group[0]);
    removedCount += group.length - 1;
  });

  await saveEntries(kept);
  return removedCount;
}
async function getSettings() { return new Promise(r=>chrome.storage.local.get(SETTINGS_KEY,d=>r(d[SETTINGS_KEY]||{autoBackup:true,introLength:1.5}))); }
async function saveSettings(s) { return new Promise(r=>chrome.storage.local.set({[SETTINGS_KEY]:s},r)); }
function generateId() { return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function parseTags(tags) { return Array.isArray(tags)?tags:(tags?tags.split(',').map(t=>t.trim()).filter(Boolean):[]); }

// ─── MAL API ─────────────────────────────────────────────────
async function getMALToken() {
  return new Promise(r=>chrome.storage.local.get(['mal_access_token','mal_token_expiry'],d=>{
    if (!d.mal_access_token) { r(null); return; }
    if (d.mal_token_expiry && Date.now() > d.mal_token_expiry - 60000) {
      // Refresh happens in background.js and writes the NEW token to storage.
      // Re-read storage after refresh instead of reusing the stale token we
      // already know is expired — that was the actual sync bug.
      chrome.runtime.sendMessage({type:'MAL_REFRESH'}, res => {
        if (!res?.ok) { r(null); return; }
        chrome.storage.local.get(['mal_access_token'], fresh => r(fresh.mal_access_token || null));
      });
    } else { r(d.mal_access_token); }
  }));
}

async function malRequest(endpoint, method='GET', body=null) {
  const token = await getMALToken();
  if (!token) return null;
  try {
    const opts = {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    if (body) opts.body = new URLSearchParams(body);
    const res = await fetch(`${MAL_API}${endpoint}`, opts);
    if (res.ok) return res.json().catch(()=>null);
  } catch(e) { console.log('MAL error:', e.message); }
  return null;
}

async function malSyncEntry(entry) {
  if (!entry.malId) return;
  const token = await getMALToken();
  if (!token) return;
  try {
    const statusMap = {watching:'watching',completed:'completed',dropped:'dropped',plan:'plan_to_watch',hold:'on_hold'};
    const body = {
      status: statusMap[entry.status] || 'watching',
      num_watched_episodes: parseInt(entry.episode)||0
    };
    if (entry.userScore) body.score = entry.userScore;
    await fetch(`${MAL_API}/anime/${entry.malId}/my_list_status`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body)
    });
  } catch(e) { console.log('MAL sync error:', e.message); }
}

async function malGetProfile() {
  return malRequest('/users/@me');
}

// Multi-result Jikan search for manual MAL linking (separate from the
// single-best-match searchJikan used by auto-detect).
async function searchJikanMulti(title, limit=8) {
  try {
    const res = await fetch(`${JIKAN_BASE}/anime?q=${encodeURIComponent(title)}&limit=${limit}&sfw=false`);
    if (!res.ok) {
      console.log('searchJikanMulti: Jikan responded', res.status, res.statusText);
      return { results: [], error: `Jikan error ${res.status}` };
    }
    const data = await res.json();
    const results = (data.data||[]).map(a=>({
      malId:a.mal_id,
      title:a.title_english||a.title,
      altTitle:a.title,
      coverImage:a.images?.jpg?.image_url,
      totalEps:a.episodes||null,
      malScore:a.score,
      year:a.year||a.aired?.prop?.from?.year||'',
      source:'jikan'
    }));
    return { results, error: null };
  } catch(e) {
    console.log('searchJikanMulti error:', e.message);
    return { results: [], error: e.message };
  }
}

// AniList fallback/second source. AniList's GraphQL search is more forgiving
// with alternate titles/synonyms than Jikan, and returns idMal directly so
// results stay compatible with linkEntryToMAL (which needs a malId).
async function searchAniListMulti(title, limit=8) {
  const query = `
    query ($search: String, $perPage: Int) {
      Page(perPage: $perPage) {
        media(search: $search, type: ANIME) {
          idMal
          title { romaji english }
          coverImage { medium }
          episodes
          averageScore
          seasonYear
        }
      }
    }`;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { search: title, perPage: limit } })
    });
    if (!res.ok) {
      console.log('searchAniListMulti: AniList responded', res.status, res.statusText);
      return { results: [], error: `AniList error ${res.status}` };
    }
    const data = await res.json();
    const results = (data?.data?.Page?.media||[])
      .filter(a => a.idMal) // skip entries with no MAL mapping, we need malId downstream
      .map(a=>({
        malId:a.idMal,
        title:a.title.english||a.title.romaji,
        altTitle:a.title.romaji,
        coverImage:a.coverImage?.medium,
        totalEps:a.episodes||null,
        malScore:a.averageScore?a.averageScore/10:null,
        year:a.seasonYear||'',
        source:'anilist'
      }));
    return { results, error: null };
  } catch(e) {
    console.log('searchAniListMulti error:', e.message);
    return { results: [], error: e.message };
  }
}

// Character-level similarity — good for typos/minor spelling differences,
// bad for titles that differ in length (subtitles, alt translations).
function levenshteinSimilarity(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++) {
    for (let j=1;j<=n;j++) {
      dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j-1],dp[i-1][j],dp[i][j-1]);
    }
  }
  return 1 - dp[m][n]/Math.max(m,n);
}

// Word-overlap similarity — handles titles with an alt-translation or
// subtitle appended ("Girlfriend, Girlfriend" vs the JP romaji original)
// far better than raw character distance, since shared words score high
// regardless of extra length on either side.
function wordOverlapSimilarity(a, b) {
  const wordsA = new Set(a.split(/[\s,\-!?.:;'"()]+/).filter(w => w.length > 1));
  const wordsB = new Set(b.split(/[\s,\-!?.:;'"()]+/).filter(w => w.length > 1));
  if (!wordsA.size || !wordsB.size) return 0;
  let shared = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) shared++; });
  // Jaccard (shared / union). Dividing by the SHORTER title's word count
  // (the old behavior) meant a one-word query like "Naruto" scored a
  // perfect 1.0 against any title containing that word anywhere — e.g.
  // "Boruto: Naruto Next Generations", a completely different show.
  // Confirmed by direct testing: that pairing scored 0.9 overall and would
  // auto-link at the 0.55 threshold used elsewhere. Union-based scoring
  // makes a single shared word against a four-word title score low (1/4)
  // while still scoring near-duplicates (one extra word) highly.
  const union = wordsA.size + wordsB.size - shared;
  return union ? shared / union : 0;
}

// Combined score: takes the best of character-level and word-level
// similarity, plus a bonus if one title fully contains the other
// (common when one source has a longer official name).
// Strips accents/diacritics (é→e, ñ→n, etc.) so "Pokemon" and "Pokémon"
// compare as equal instead of silently failing to match.
function stripDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

function titleSimilarity(a, b) {
  a = stripDiacritics(a.toLowerCase().trim()); b = stripDiacritics(b.toLowerCase().trim());
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Containment bonus gated by length ratio — see wordOverlapSimilarity
  // comment. "Naruto" is technically contained in "Boruto: Naruto Next
  // Generations", but they're different shows; only grant the bonus when
  // the shorter string covers a meaningful fraction (60%+) of the longer
  // one, i.e. this is really "the same title plus a small suffix", not
  // "any substring anywhere". Score lowered from 0.9 to 0.85 as well —
  // still high enough to win against unrelated titles, but no longer high
  // enough to auto-clear the ambiguity guard in searchJikan/resyncOldAnime
  // on its own.
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if ((a.includes(b) || b.includes(a)) && lenRatio >= 0.6) return 0.85;
  return Math.max(levenshteinSimilarity(a, b), wordOverlapSimilarity(a, b));
}

// Combined search: queries Jikan + AniList in parallel, merges results,
// dedupes by malId, and sorts by title-similarity to the query so the best
// match surfaces first regardless of which source found it. If one source
// fails, the other still returns results instead of a dead end.
async function searchAnimeMulti(title, limit=8) {
  const [jikan, anilist] = await Promise.all([
    searchJikanMulti(title, limit),
    searchAniListMulti(title, limit)
  ]);

  const combined = [...jikan.results, ...anilist.results];
  const seen = new Set();
  const deduped = combined.filter(r => {
    if (seen.has(r.malId)) return false;
    seen.add(r.malId);
    return true;
  });

  deduped.forEach(r => r._score = titleSimilarity(title, r.title));
  deduped.sort((a,b) => b._score - a._score);

  const errors = [jikan.error, anilist.error].filter(Boolean);
  return {
    results: deduped.slice(0, limit),
    error: deduped.length ? null : (errors.join('; ') || null)
  };
}

// Attaches a malId to ONE specific local entry (by its unique id), then
// pushes the current status/progress to MAL right away.
//
// This used to match by title text across ALL entries — meaning if two
// local entries had drifted to the same title string (duplicate-title
// bugs elsewhere in detection), linking one from the Link modal would
// silently attach the chosen MAL match's cover/score/airing data to BOTH
// entries, even though only one of them was the one you actually clicked
// 🔗 on. That's the "editing wrong attachments" bug — fixed by keying
// strictly on entry id now.
async function linkEntryToMAL(entryId, malMatch) {
  const entries = await getEntries();
  const idx = entries.findIndex(e => e.id === entryId);
  if (idx === -1) return null;

  // Manual search results (searchJikanMulti) don't include broadcast/airing
  // info, so without this fetch, manually-linked anime would never get a
  // countdown or qualify for new-season checks. Grab the full record once.
  let full = null;
  try {
    await new Promise(r=>setTimeout(r,450));
    const res = await fetch(`${JIKAN_BASE}/anime/${malMatch.malId}`);
    if (res.ok) full = (await res.json()).data;
  } catch(e) { console.log('linkEntryToMAL full-fetch error:', e.message); }

  const e = entries[idx];
  e.malId = malMatch.malId;
  if (!e.coverImage) e.coverImage = malMatch.coverImage;
  if (!e.totalEpisodes && malMatch.totalEps) e.totalEpisodes = String(malMatch.totalEps);
  if (!e.malScore && malMatch.malScore) e.malScore = malMatch.malScore;
  if (full) {
    e.airingStatus = full.status;
    e.broadcastDay = full.broadcast?.day || null;
    e.broadcastTime = full.broadcast?.time || null;
    e.broadcastTimezone = full.broadcast?.timezone || null;
  }
  const touched = e;
  await saveEntries(entries);
  if (touched) await malSyncEntry(touched);
  return touched;
}

// Bulk "sync old anime" — for every local entry that never got linked to a
// MAL id (added before matching worked, or auto-match failed at the time),
// re-run the combined Jikan+AniList search and link+push if there's a
// confident match. Anything below the confidence bar is left alone rather
// than risking a wrong auto-link — those still show the manual 🔗 button.
async function resyncOldAnime(onProgress) {
  const entries = await getEntries();
  const unlinkedTitles = [...new Set(
    entries.filter(e => !e.malId).map(e => e.title.trim())
  )];

  let linked = 0, skipped = 0;

  for (let i = 0; i < unlinkedTitles.length; i++) {
    const title = unlinkedTitles[i];
    const searchQuery = sanitizeForSearch(title);
    onProgress?.(i + 1, unlinkedTitles.length, title);
    const { results } = await searchAnimeMulti(searchQuery, 3);
    const best = results[0];
    if (isConfidentMatch(results)) {
      await linkEntryToMAL(title, best);
      linked++;
    } else {
      skipped++;
    }
    await new Promise(r => setTimeout(r, 400)); // stay easy on both APIs
  }

  return { linked, skipped, total: unlinkedTitles.length };
}

async function malImportList() {
  const token = await getMALToken();
  if (!token) return [];
  try {
    let results = [], offset = 0;
    while (true) {
      const res = await fetch(`${MAL_API}/users/@me/animelist?fields=list_status,num_episodes&limit=100&offset=${offset}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!data.data || !data.data.length) break;
      results = results.concat(data.data);
      if (!data.paging?.next) break;
      offset += 100;
      await new Promise(r=>setTimeout(r,500));
    }
    return results;
  } catch(e) { return []; }
}

// ─── THEME ───────────────────────────────────────────────────
function loadTheme() {
  const t = localStorage.getItem(THEME_KEY)||'dark';
  if (t==='light') document.body.classList.add('light');
  const icon = t==='light'?'🌙':'☀️';
  document.getElementById('btn-theme').textContent = icon;
  const sb = document.getElementById('settings-theme-btn');
  if (sb) sb.textContent = icon;
}
function toggleTheme() {
  const l = document.body.classList.toggle('light');
  localStorage.setItem(THEME_KEY, l?'light':'dark');
  const icon = l?'🌙':'☀️';
  document.getElementById('btn-theme').textContent = icon;
  const sb = document.getElementById('settings-theme-btn');
  if (sb) sb.textContent = icon;
}

// ─── TOAST ───────────────────────────────────────────────────
function showToast(msg, type='') {
  const t=document.getElementById('toast');
  t.textContent=msg; t.className='toast'+(type?' '+type:'');
  clearTimeout(t._timer); t._timer=setTimeout(()=>t.classList.add('hidden'),2600);
}

// ─── UTILS ───────────────────────────────────────────────────
function formatDate(ts) {
  if (!ts) return '';
  const d=new Date(ts),now=new Date(),diff=now-d;
  if (diff<60000) return 'just now';
  if (diff<3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff<86400000) return `${Math.floor(diff/3600000)}h ago`;
  if (diff<604800000) return `${Math.floor(diff/86400000)}d ago`;
  return d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
function formatDateShort(ts) {
  if (!ts) return '';
  const d=new Date(ts);
  return d.toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'})+' at '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
function truncateUrl(url,max=50) { return url.length<=max?url:url.slice(0,max)+'…'; }
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function statusLabel(s) { return {watching:'Watching',completed:'Completed',dropped:'Dropped',plan:'Plan to Watch',hold:'On Hold'}[s]||s; }
function animeEmoji(title) {
  const map={'naruto':'🍃','bleach':'⚔️','one piece':'🏴‍☠️','dragon ball':'🔥','demon slayer':'🌸','jujutsu':'🔮','my hero':'💪','hunter x hunter':'🎯','fullmetal':'⚗️','death note':'📓','sword art':'🗡️','fairy tail':'🧙','tokyo ghoul':'👁️','chainsaw':'🪚','spy x family':'🎭','one punch':'👊','yozakura':'🌸','seihantai':'💕','attack on titan':'⚔️','vinland':'🪓'};
  const t=title.toLowerCase();
  for (const [k,v] of Object.entries(map)) if (t.includes(k)) return v;
  return ['🎌','⛩','🗾','🌸','⚡','🔥','🌙','✨','🎴','🏯'][Math.abs((title.charCodeAt(0)||0)%10)];
}

// ─── STARS RATING ────────────────────────────────────────────
function renderStars(rating, id, onRate) {
  const container = document.createElement('div');
  container.className = 'star-rating';
  for (let i=1; i<=10; i++) {
    const star = document.createElement('span');
    star.className = 'star' + (i <= (rating||0) ? ' filled' : '');
    star.textContent = '★';
    star.title = `Rate ${i}/10`;
    star.addEventListener('click', () => onRate(i));
    star.addEventListener('mouseover', () => {
      container.querySelectorAll('.star').forEach((s,idx) => s.classList.toggle('filled', idx<i));
    });
    container.addEventListener('mouseleave', () => {
      container.querySelectorAll('.star').forEach((s,idx) => s.classList.toggle('filled', idx<(rating||0)));
    });
    container.appendChild(star);
  }
  return container;
}

// ─── NEXT EPISODE COUNTDOWN ──────────────────────────────────
// Uses the broadcast day/time already returned by the Jikan lookup we do on
// save — no extra API call. Assumes JST (fixed UTC+9, no DST — true for Japan).
function getWeekdayNum(name) {
  if (!name) return null;
  const map={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};
  const clean=name.toLowerCase().trim().replace(/s$/,'');
  return clean in map ? map[clean] : null;
}
function computeNextEpisode(entry) {
  if (entry.airingStatus!=='Currently Airing') return null;

  // AniList gives a precomputed countdown timestamp directly — no day/time
  // reconstruction needed, and it stays accurate through irregular schedules
  // (delays, breaks) that Jikan's static broadcastDay/Time can't reflect.
  if (entry.nextAiringAt) {
    const targetUTC = new Date(entry.nextAiringAt * 1000);
    const daysLeft = Math.max(0, Math.ceil((entry.nextAiringAt*1000 - Date.now()) / 86400000));
    return {
      daysLeft,
      dateStr: targetUTC.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}),
      timeStr: targetUTC.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
    };
  }

  if (!entry.broadcastDay || !entry.broadcastTime) return null;
  const wd=getWeekdayNum(entry.broadcastDay);
  if (wd===null) return null;
  const parts=entry.broadcastTime.split(':').map(Number);
  const bh=parts[0], bm=parts[1]||0;
  if (isNaN(bh)) return null;

  const OFFSET_MIN=9*60; // JST fixed offset
  const nowUTC=Date.now();
  const nowJST=new Date(nowUTC+OFFSET_MIN*60000);
  const jstDay=nowJST.getUTCDay();
  const jstHour=nowJST.getUTCHours();
  const jstMin=nowJST.getUTCMinutes();

  let daysUntil=(wd-jstDay+7)%7;
  if (daysUntil===0 && (jstHour>bh || (jstHour===bh && jstMin>=bm))) daysUntil=7;

  const targetJST=new Date(Date.UTC(nowJST.getUTCFullYear(),nowJST.getUTCMonth(),nowJST.getUTCDate()+daysUntil,bh,bm,0));
  const targetUTC=new Date(targetJST.getTime()-OFFSET_MIN*60000);

  return {
    daysLeft:daysUntil,
    dateStr:targetUTC.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}),
    timeStr:targetUTC.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
  };
}

// ─── GROUP BY ANIME ──────────────────────────────────────────
function groupByAnime(entries) {
  const map=new Map();
  const sorted=[...entries].sort((a,b)=>b.savedAt-a.savedAt);
  for (const e of sorted) {
    const key=e.title.toLowerCase().trim();
    if (!map.has(key)) map.set(key,{...e,allEntries:[e]});
    else map.get(key).allEntries.push(e);
  }
  return [...map.values()];
}

// ─── FILTER/SORT ─────────────────────────────────────────────
const F={search:'',status:'all',sort:'recent'};
function applyFilters(entries) {
  let list=[...entries];
  if (F.search) { const q=F.search.toLowerCase(); list=list.filter(e=>e.title.toLowerCase().includes(q)||(e.tags||[]).join(' ').toLowerCase().includes(q)); }
  if (F.status!=='all') list=list.filter(e=>e.status===F.status);
  return list;
}
function sortGroups(groups) {
  if (F.sort==='title') return [...groups].sort((a,b)=>a.title.localeCompare(b.title));
  if (F.sort==='rating') return [...groups].sort((a,b)=>(b.userScore||0)-(a.userScore||0));
  if (F.sort==='progress') return [...groups].sort((a,b)=>(parseInt(b.episode)||0)-(parseInt(a.episode)||0));
  if (F.sort==='priority') return [...groups].sort((a,b)=>(a.priority==='high'?0:a.priority==='low'?2:1)-(b.priority==='high'?0:b.priority==='low'?2:1));
  if (F.sort==='pinned') return [...groups].sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0));
  return groups;
}

// ─── COMPLETION ──────────────────────────────────────────────
function showCompletionModal(anime) {
  const sessions=anime.allEntries.length;
  const rewatches=(anime.rewatchCount||0);
  document.getElementById('complete-body').innerHTML=`
    <div style="text-align:center;padding:16px 10px">
      <div style="font-size:52px;margin-bottom:10px">${animeEmoji(anime.title)}</div>
      <div style="font-size:18px;font-weight:800;margin-bottom:6px">${escapeHtml(anime.title)}</div>
      <div style="color:var(--text-secondary);font-size:12px;margin-bottom:14px">You finished this anime! 🎉</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="font-size:20px;font-weight:800;color:var(--accent)">${escapeHtml(String(anime.episode))}</div>
          <div style="font-size:10px;color:var(--text-secondary)">Episodes</div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="font-size:20px;font-weight:800;color:var(--accent)">${sessions}</div>
          <div style="font-size:10px;color:var(--text-secondary)">Sessions</div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="font-size:20px;font-weight:800;color:var(--accent)">${anime.timeWatchedMins?Math.round(anime.timeWatchedMins/60*10)/10+'h':'?'}</div>
          <div style="font-size:10px;color:var(--text-secondary)">Watched</div>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">Tap a star to rate — it'll save instantly and sync to MAL</div>
        <div id="completion-stars" style="justify-content:center;display:flex"></div>
      </div>
      <button class="btn-secondary btn-full" id="btn-skip-rating">Skip rating, just mark completed</button>
    </div>`;

  const finalizeCompletion = async (score) => {
    const entries=await getEntries();
    const idx=entries.findIndex(e=>e.id===anime.id); // by id, not by title text
    if (idx===-1) { document.getElementById('complete-modal').classList.add('hidden'); return; }
    entries[idx].status='completed';
    if (score) entries[idx].userScore=score;
    await saveEntries(entries);
    if (entries[idx].malId) await malSyncEntry(entries[idx]);
    document.getElementById('complete-modal').classList.add('hidden');
    renderAll();
    showToast(score?`${anime.title} completed & rated ${score}/10 ✓`:`${anime.title} completed! 🎉`,'success');
  };

  const starsEl = document.getElementById('completion-stars');
  const stars = renderStars(anime.userScore||0, 'completion', (score) => finalizeCompletion(score));
  starsEl.appendChild(stars);

  document.getElementById('complete-modal').classList.remove('hidden');
  document.getElementById('btn-skip-rating').addEventListener('click', () => finalizeCompletion(0));
}

// ─── EP NOTES MODAL ──────────────────────────────────────────
function openEpNotesModal(anime) {
  const notes=anime.allEntries.filter(e=>e.epNotes).sort((a,b)=>b.savedAt-a.savedAt);
  document.getElementById('epnotes-body').innerHTML=`
    <div style="font-weight:700;margin-bottom:12px">${escapeHtml(anime.title)}</div>
    ${notes.length?notes.map(e=>`
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="font-size:10px;font-weight:700;color:var(--accent)">Episode ${escapeHtml(String(e.episode))}</div>
        <div style="font-size:12px;margin-top:4px">${escapeHtml(e.epNotes)}</div>
        <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">${formatDateShort(e.savedAt)}</div>
      </div>`).join('')
    :'<div style="color:var(--text-secondary);font-size:12px">No episode notes yet.</div>'}`;
  document.getElementById('epnotes-modal').classList.remove('hidden');
}

// ─── RENDER LIBRARY ──────────────────────────────────────────
// Entries created via MAL import or "Add to Plan" never got broadcast day/
// time attached (only the auto-save path fetches that). Without this,
// countdown silently never shows for those anime. Backfill a few per render
// pass (rate-limit friendly) until everything currently-watching has it.
async function fetchAniListAiring(malId) {
  const query = `query ($id: Int) { Media(idMal: $id, type: ANIME) { status nextAiringEpisode { airingAt episode } } }`;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { id: malId } })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.Media || null;
  } catch(e) { console.log('fetchAniListAiring error:', e.message); return null; }
}

async function backfillBroadcastData(entries) {
  const needsBackfill = entries.filter(e => e.status==='watching' && e.malId && !e.broadcastDay && !e.nextAiringAt);
  if (!needsBackfill.length) return false;
  let changed = false;
  for (const e of needsBackfill.slice(0,5)) {
    try {
      await new Promise(r=>setTimeout(r,450));
      const res = await fetch(`${JIKAN_BASE}/anime/${e.malId}`);
      if (!res.ok) continue;
      const a = (await res.json()).data;
      if (!a) continue;
      e.airingStatus = a.status;
      e.broadcastDay = a.broadcast?.day || null;
      e.broadcastTime = a.broadcast?.time || null;
      e.broadcastTimezone = a.broadcast?.timezone || null;

      // Jikan often has no broadcast day/time even for currently-airing shows.
      // AniList's nextAiringEpisode gives a direct countdown timestamp instead
      // of relying on a fixed weekly schedule reconstruction.
      if (a.status === 'Currently Airing' && !e.broadcastDay) {
        const al = await fetchAniListAiring(e.malId);
        if (al?.nextAiringEpisode?.airingAt) {
          e.nextAiringAt = al.nextAiringEpisode.airingAt;
        }
      }
      changed = true;
    } catch(err) { console.log('backfill error:', err.message); }
  }
  if (changed) await saveEntries(entries);
  return changed;
}

let libraryHasAnimatedOnce = false;
async function renderLibrary() {
  const entries=await getEntries();
  const container=document.getElementById('library-list');
  container.innerHTML='';
  const filtered=applyFilters(entries);
  const groups=sortGroups(groupByAnime(filtered));

  if (!groups.length) {
    container.innerHTML=`<div class="empty-state"><div class="empty-icon">🎌</div><p>${F.search||F.status!=='all'?'No results.':'No anime tracked yet.'}</p><p class="empty-sub">Use the Add tab to get started.</p></div>`;
    // still worth backfilling in the background even on an empty filtered view
    backfillBroadcastDataBackground(entries);
    return;
  }

  let cardIndex = 0;
  for (const anime of groups) {
    const card=document.createElement('div');
    const cardClass=['anime-card',anime.pinned?'pinned':'',anime.priority==='high'?'priority-high':anime.priority==='low'?'priority-low':''].filter(Boolean).join(' ');
    card.className=cardClass;
    // Only animate on the first render — a background re-render (e.g. after
    // broadcast-data backfill completes silently) would otherwise replay
    // this animation and look like the whole list flickering.
    if (!libraryHasAnimatedOnce) {
      card.style.animationDelay = `${Math.min(cardIndex++ * 25, 300)}ms`;
    } else {
      card.style.animation = 'none';
    }

    const maxEp=Math.max(...anime.allEntries.map(e=>parseInt(e.episode)||0).filter(Boolean), 0)||null;
    const total=parseInt(anime.totalEpisodes)||0;
    const pct=total&&maxEp?Math.min((maxEp/total)*100,100):null;
    const isComplete=pct===100||anime.status==='completed';
    const rewatchCount=anime.totalRewatchViews||0;
    const rewatchTitle = rewatchCount>0 && anime.episodeHistory
      ? Object.entries(anime.episodeHistory).filter(([,r])=>r.count>1).map(([ep,r])=>`EP ${ep}: ${r.count}×`).join(', ')
      : '';
    const tags=(anime.tags||[]).slice(0,2);
    const genres=(anime.genres||[]).slice(0,2);

    // ─── LIVE EPISODE POSITION (media-player-style) ───────────────
    // episodePosSec/episodeDurationSec are written by background.js on
    // every VIDEO_PROGRESS message while actually watching — this data
    // existed already but was never surfaced on the main library card, so
    // there was no visible confirmation tracking was working at all.
    // Only shown for entries currently being watched with a confident,
    // fresh-enough position (matches the "Resume · mm:ss" mockup pattern).
    const fmtClock = sec => {
      sec = Math.max(0, Math.round(sec));
      const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
      return h>0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
    };
    const hasLivePosition = anime.status==='watching' && anime.episodePosSec && anime.episodeDurationSec && anime.episodePosSec < anime.episodeDurationSec - 5;
    const liveEpPct = hasLivePosition ? Math.min(100, Math.round((anime.episodePosSec/anime.episodeDurationSec)*100)) : 0;

    let paceText='';
    if (anime.status==='watching'&&total&&maxEp&&maxEp<total) {
      const sessions=anime.allEntries.length;
      const daysSince=(Date.now()-Math.min(...anime.allEntries.map(e=>e.savedAt)))/(86400000)||1;
      const epsPerDay=sessions/daysSince;
      const remaining=total-maxEp;
      if (epsPerDay>0) paceText=`📈 ${Math.ceil(remaining/epsPerDay)} days to finish`;
    }

    const nextEp = anime.status==='watching' ? computeNextEpisode(anime) : null;
    const nextEpText = nextEp ? `📅 Next Ep: ${nextEp.daysLeft===0?'Today':nextEp.daysLeft===1?'Tomorrow':`in ${nextEp.daysLeft} days`} · ${nextEp.dateStr} at ${nextEp.timeStr}` : '';

    card.innerHTML=`
      <div class="card-poster" style="${anime.coverImage?`background-image:url(${escapeHtml(anime.coverImage)});background-size:cover;background-position:center;font-size:0`:''}" >
        ${anime.coverImage?'':`<span style="font-size:24px">${animeEmoji(anime.title)}</span>`}
        ${anime.pinned?'<div class="pin-badge">📌</div>':''}
        ${isComplete?'<div class="completion-badge">✓</div>':''}
      </div>
      <div class="card-info">
        <div class="card-title">${escapeHtml(anime.title)}</div>
        <div class="card-meta">
          <span class="ep-badge">EP ${escapeHtml(String(anime.episode))}${total?` / ${total}`:''}</span>
          <span class="status-badge ${anime.status}">${statusLabel(anime.status)}</span>
          ${anime.type&&anime.type!=='sub'?`<span class="type-badge">${anime.type.toUpperCase()}</span>`:''}
          ${anime.season&&parseInt(anime.season)>1?`<span class="season-badge">S${escapeHtml(String(anime.season))}</span>`:''}
          ${rewatchCount>0?`<span class="rewatch-badge" title="${escapeHtml(rewatchTitle)}">🔄 ×${rewatchCount}</span>`:''}
          ${anime.malScore?`<span style="font-size:10px;color:var(--amber)">⭐${anime.malScore}</span>`:''}
        </div>
        ${hasLivePosition?`
        <div class="card-progress" style="margin-top:6px">
          <div class="progress-label" style="color:var(--accent);font-weight:600">▶ ${fmtClock(anime.episodePosSec)} / ${fmtClock(anime.episodeDurationSec)} · EP ${escapeHtml(String(anime.episode))}</div>
          <div class="progress-bar"><div class="progress-fill" style="width:${liveEpPct}%"></div></div>
        </div>`:''}
        ${pct!==null?`
        <div class="card-progress">
          <div class="progress-label">${maxEp} / ${total} eps · ${Math.round(pct)}%${anime.timeRemainingMins&&!isComplete?` · ~${Math.round(anime.timeRemainingMins/60*10)/10}h left`:''}</div>
          <div class="progress-bar"><div class="progress-fill${isComplete?' complete':''}" style="width:${pct}%"></div></div>
        </div>`:maxEp?`
        <div class="card-progress">
          <div class="progress-label">Up to EP ${maxEp}${anime.timeWatchedMins?` · ${Math.round(anime.timeWatchedMins/60*10)/10}h watched`:''}</div>
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(maxEp,100)}%"></div></div>
        </div>`:''}
        ${paceText?`<div class="watch-pace">${paceText}</div>`:''}
        ${nextEpText?`<div class="next-ep-info">${nextEpText}</div>`:''}
        ${genres.length?`<div class="card-tags">${genres.map(g=>`<span class="tag" style="color:var(--sky);background:rgba(96,165,250,0.1);border-color:rgba(96,165,250,0.2)">${escapeHtml(g)}</span>`).join('')}</div>`:''}
        ${tags.length?`<div class="card-tags">${tags.map(t=>`<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>`:''}
        <div id="stars-${anime.id}" class=""></div>
        <div class="card-date">${formatDate(anime.savedAt)}</div>
        ${anime.studio?`<div style="font-size:10px;color:var(--accent)">🎬 ${escapeHtml(anime.studio)}</div>`:''}
      </div>
      <div class="card-actions">
        <button class="btn-resume" data-url="${escapeHtml(anime.url)}">▶ Resume</button>
        <div class="card-icon-actions">
          <button class="btn-card-icon notes-btn" data-id="${anime.id}" title="Episode Notes">📝</button>
          <button class="btn-card-icon pin-btn ${anime.pinned?'pin-active':''}" data-id="${anime.id}">📌</button>
          ${!anime.malId?`<button class="btn-card-icon link-mal-btn" data-id="${anime.id}" data-title="${escapeHtml(anime.title)}" title="Link to MyAnimeList">🔗</button>`:''}
          <button class="btn-card-icon edit-btn" data-id="${anime.id}">✏</button>
          <button class="btn-card-icon del btn-delete" data-id="${anime.id}">🗑</button>
        </div>
      </div>`;

    const starsContainer = card.querySelector(`#stars-${anime.id}`);
    const stars = renderStars(anime.userScore, anime.id, async (score) => {
      const all=await getEntries();
      const idx=all.findIndex(e=>e.id===anime.id); // by unique id — not every entry sharing this title
      if (idx===-1) return;
      all[idx].userScore=score;
      await saveEntries(all);
      if (all[idx].malId) await malSyncEntry(all[idx]);
      showToast(`Rated ${score}/10 ⭐`,'success');
    });
    starsContainer.appendChild(stars);

    card.querySelector('.btn-resume').addEventListener('click',async ev=>{
      ev.stopPropagation();
      const targetUrl = ev.currentTarget.dataset.url;
      // Resume-to-timestamp: write the saved position where content.js on
      // the target page will look for it, THEN open the tab. Only bother
      // if the saved position is a meaningful mid-episode point — content.js
      // itself also validates this, but skipping the write entirely here
      // avoids leaving a stale pending-resume record for trivial positions.
      if (anime.episodePosSec && anime.episodeDurationSec &&
          anime.episodePosSec >= 10 && anime.episodePosSec <= anime.episodeDurationSec - 15) {
        await new Promise(r => chrome.storage.local.set({
          [PENDING_RESUME_KEY]: { url: targetUrl, positionSec: anime.episodePosSec, setAt: Date.now() }
        }, r));
      }
      chrome.tabs.create({url: targetUrl});
    });
    card.querySelector('.notes-btn').addEventListener('click',ev=>{ev.stopPropagation();openEpNotesModal(anime);});
    card.querySelector('.pin-btn').addEventListener('click',async ev=>{ev.stopPropagation();await togglePin(ev.currentTarget.dataset.id, !anime.pinned);});
    card.querySelector('.edit-btn').addEventListener('click',ev=>{ev.stopPropagation();openEditModal(ev.currentTarget.dataset.id);});
    card.querySelector('.link-mal-btn')?.addEventListener('click',ev=>{ev.stopPropagation();openLinkModal(ev.currentTarget.dataset.id, ev.currentTarget.dataset.title);});
    card.querySelector('.btn-delete').addEventListener('click',async ev=>{
      ev.stopPropagation();
      if (!confirm(`Remove "${anime.title}"?`)) return;
      const all=await getEntries();
      // Delete ONLY the specific entry this card represents — not every
      // entry sharing the same title text. Bulk-by-title deletion meant
      // clicking delete on one duplicate could silently wipe out a
      // different, unrelated entry that happened to have drifted to the
      // same title string.
      await saveEntries(all.filter(e=>e.id!==anime.id));
      renderAll(); showToast('Removed ✓','success');
    });
    container.appendChild(card);
  }
  libraryHasAnimatedOnce = true;

  // Cards are already visible at this point. Backfill missing broadcast
  // data quietly afterward — doesn't block or delay what the user sees.
  backfillBroadcastDataBackground(entries);
}

// Non-blocking wrapper: runs backfillBroadcastData without the popup
// waiting on it. If entries changed, do one quiet re-render — no
// recursive chaining, so it can't loop the way the old version could.
let backfillInFlight = false;
async function backfillBroadcastDataBackground(entries) {
  if (backfillInFlight) return; // avoid stacking overlapping runs
  backfillInFlight = true;
  try {
    const changed = await backfillBroadcastData(entries);
    if (changed && document.getElementById('tab-library')?.classList.contains('active')) {
      renderLibrary();
    }
  } finally {
    backfillInFlight = false;
  }
}

// ─── ORGANIZED VIEW ────────────────────────────────────────────
// Groups entries into clear sections instead of one long mixed list:
// Almost Done (2-3 eps left), Airing Now, Watching, On Hold, Completed.
// Kept intentionally lightweight (compact rows, not full cards) so it
// reads as an overview, not a duplicate of the Library tab.
// Shows seconds when under a minute — otherwise "even 1 min watched"
// entries (or 30-second drops) would just display as "0m".
function fmtWatchTime(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function organizedRow(e) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer';
  const img = e.coverImage
    ? `<img src="${e.coverImage}" style="width:32px;height:44px;object-fit:cover;border-radius:4px;flex-shrink:0">`
    : `<div style="width:32px;height:44px;border-radius:4px;background:var(--card-bg);flex-shrink:0"></div>`;
  const epText = e.totalEps ? `EP ${e.episode}/${e.totalEps}` : `EP ${e.episode}`;
  const rewatchBadge = e.rewatchCount > 0 ? ` <span style="color:var(--pink)">↻×${e.rewatchCount}</span>` : '';
  const progressText = e.episodeProgressPct != null ? ` · 🎬 ${e.episodeProgressPct}% of this ep` : '';
  const totalWatchText = e.watchTimeSec ? ` · ⏱ ${fmtWatchTime(e.watchTimeSec)} total` : '';
  row.innerHTML = `${img}
    <div style="min-width:0;flex:1">
      <div style="font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.title)}${rewatchBadge}</div>
      <div style="font-size:11px;color:var(--text-secondary)">${epText}${progressText}${totalWatchText}</div>
    </div>`;
  row.addEventListener('click', () => { if (e.url) chrome.tabs.create({ url: e.url }); });
  return row;
}

function organizedSection(title, entries) {
  if (!entries.length) return '';
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '18px';
  wrap.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.05em;padding:0 10px 6px">${title} (${entries.length})</div>`;
  entries.forEach(e => wrap.appendChild(organizedRow(e)));
  return wrap;
}

async function renderOrganized() {
  const entries = await getEntries();
  const container = document.getElementById('organized-list');
  container.innerHTML = '';

  // Quick timer summary right up top — today's watch time plus all-time
  // per-site breakdown. Full breakdown still lives in Settings.
  const { allTime, today } = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_SITE_TIME' }, res => resolve(res || { allTime:{}, today:{} }));
  });
  const fmt = sec => { const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; };
  const domains = Object.keys(allTime).sort((a,b) => (allTime[b].watching||0)-(allTime[a].watching||0));
  if (domains.length) {
    const todaySec = Object.values(today).reduce((s,t)=>s+(t.watching||0),0);
    const allTimeSec = domains.reduce((s,d)=>s+(allTime[d].watching||0),0);
    const timerBar = document.createElement('div');
    timerBar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;margin-bottom:14px;border:1px solid var(--border);border-radius:10px;font-size:12px;flex-wrap:wrap';
    timerBar.innerHTML = `<span style="font-weight:700;color:var(--accent)">⏱ ${fmt(todaySec)} today</span>` +
      `<span style="color:var(--text-secondary)">· ${fmt(allTimeSec)} all-time</span>` +
      domains.slice(0,2).map(d => `<span style="color:var(--text-secondary)">${escapeHtml(d)}: ${fmt(allTime[d].watching||0)}</span>`).join('');
    container.appendChild(timerBar);
  }

  const almostDone = entries.filter(e =>
    e.status === 'watching' && e.totalEps &&
    (e.totalEps - parseInt(e.episode || 0)) <= 3 && (e.totalEps - parseInt(e.episode || 0)) > 0
  );
  const almostDoneIds = new Set(almostDone.map(e => e.id));

  const airing = entries.filter(e =>
    e.status === 'watching' && e.airingStatus === 'Currently Airing' && !almostDoneIds.has(e.id)
  );
  const airingIds = new Set(airing.map(e => e.id));

  const watching = entries.filter(e =>
    e.status === 'watching' && !almostDoneIds.has(e.id) && !airingIds.has(e.id)
  );
  const hold = entries.filter(e => e.status === 'hold');
  const completed = entries.filter(e => e.status === 'completed');

  // "Even 1 min watched" — every dropped entry shows here regardless of
  // how little was invested, sorted least-watched-first so the ones you
  // barely tried are easy to spot separately from ones you gave a real shot.
  const dropped = entries.filter(e => e.status === 'dropped')
    .sort((a,b) => (a.watchTimeSec||0) - (b.watchTimeSec||0));

  const sections = [
    organizedSection('🔥 Almost Done', almostDone),
    organizedSection('📡 Airing Now', airing),
    organizedSection('👀 Watching', watching),
    organizedSection('⏸ On Hold', hold),
    organizedSection('✅ Completed', completed),
    organizedSection('🚫 Tried & Dropped', dropped)
  ].filter(Boolean);

  if (!sections.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:12px">Nothing tracked yet.</div>';
    return;
  }
  sections.forEach(s => container.appendChild(s));
}

// ─── RENDER HISTORY ──────────────────────────────────────────
async function renderHistory() {
  const entries=await getEntries();
  const container=document.getElementById('history-list');
  container.innerHTML='';
  let filtered=[...entries].sort((a,b)=>b.savedAt-a.savedAt);
  if (F.search) { const q=F.search.toLowerCase(); filtered=filtered.filter(e=>e.title.toLowerCase().includes(q)); }
  if (F.status!=='all') filtered=filtered.filter(e=>e.status===F.status);
  if (!filtered.length) { container.innerHTML=`<div class="empty-state"><div class="empty-icon">📜</div><p>No history yet.</p></div>`; return; }

  const byDate={};
  filtered.forEach(e=>{
    const day=new Date(e.savedAt).toDateString();
    if (!byDate[day]) byDate[day]=[];
    byDate[day].push(e);
  });

  for (const [day, dayEntries] of Object.entries(byDate)) {
    const isBinge=dayEntries.length>=3;
    const header=document.createElement('div');
    header.className='session-date-header';
    header.innerHTML=`${day}${isBinge?`<span class="binge-badge">🔥 BINGE x${dayEntries.length}</span>`:''}`;
    container.appendChild(header);

    dayEntries.forEach(e=>{
      const row=document.createElement('div');
      row.className='history-entry';
      row.innerHTML=`
        <div class="history-dot ${e.status}"></div>
        <div class="history-info">
          <div class="history-title">${escapeHtml(e.title)}${e.season&&parseInt(e.season)>1?` <span style="color:var(--pink);font-size:10px">S${e.season}</span>`:''}</div>
          <div class="history-url">${escapeHtml(truncateUrl(e.url))}</div>
          <div class="history-date">${formatDateShort(e.savedAt)}</div>
          ${e.epNotes?`<div style="font-size:10px;color:var(--amber);margin-top:2px">📝 ${escapeHtml(e.epNotes)}</div>`:''}
        </div>
        <div class="history-ep-badge">EP ${escapeHtml(String(e.episode))}</div>`;
      row.addEventListener('click',()=>chrome.tabs.create({url:e.url}));
      container.appendChild(row);
    });
  }
}

// ─── RENDER STATS ────────────────────────────────────────────
async function renderStats() {
  const entries=await getEntries();
  const container=document.getElementById('stats-grid');
  container.innerHTML='';
  const groups=groupByAnime(entries);
  const totalAnime=groups.length;
  const watching=groups.filter(g=>g.status==='watching').length;
  const completed=groups.filter(g=>g.status==='completed').length;
  const dropped=groups.filter(g=>g.status==='dropped').length;
  const plan=groups.filter(g=>g.status==='plan').length;
  const totalEps=entries.reduce((s,e)=>s+(parseInt(e.episode)||0),0);
  const totalMins=entries.reduce((s,e)=>s+(e.timeWatchedMins||0),0);
  const rated=groups.filter(g=>g.userScore);
  const avgScore=rated.length?Math.round(rated.reduce((s,g)=>s+(g.userScore||0),0)/rated.length*10)/10:0;
  const completionRate=totalAnime?(Math.round(completed/totalAnime*100)):0;

  const days=new Set(entries.map(e=>new Date(e.savedAt).toDateString()));
  let streak=0,checkDay=new Date();
  while(days.has(checkDay.toDateString())){streak++;checkDay.setDate(checkDay.getDate()-1);}
  let longest=0,cur=0;
  [...days].sort().forEach((d,i,arr)=>{
    if(i>0&&(new Date(d)-new Date(arr[i-1]))/86400000===1){cur++;longest=Math.max(longest,cur);}else cur=1;
  });

  const dayCount={};
  entries.forEach(e=>{const d=new Date(e.savedAt).toLocaleDateString('en',{weekday:'long'});dayCount[d]=(dayCount[d]||0)+1;});
  const bestDay=Object.entries(dayCount).sort((a,b)=>b[1]-a[1])[0]?.[0]||'—';

  const siteCounts={};
  entries.forEach(e=>{try{const h=new URL(e.url).hostname.replace('www.','');siteCounts[h]=(siteCounts[h]||0)+1;}catch(er){}});
  const topSites=Object.entries(siteCounts).sort((a,b)=>b[1]-a[1]).slice(0,4);
  const maxSite=topSites[0]?.[1]||1;

  const genreCounts={};
  groups.forEach(g=>(g.genres||[]).forEach(genre=>{genreCounts[genre]=(genreCounts[genre]||0)+1;}));
  const topGenres=Object.entries(genreCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const streakDots=Array.from({length:14},(_,i)=>{
    const d=new Date();d.setDate(d.getDate()-13+i);
    const isToday=i===13,active=days.has(d.toDateString());
    return `<div class="streak-dot ${isToday?'today':active?'active':''}" title="${d.toLocaleDateString()}"></div>`;
  }).join('');

  container.innerHTML=`
    <div class="stat-card accent-card">
      <div class="stat-label">Total Anime</div>
      <div class="stat-value">${totalAnime}</div>
      <div class="stat-sub">${entries.length} saves · ${completionRate}% completion rate</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Watch Time</div>
      <div class="stat-value">${Math.round(totalMins/60)}h</div>
      <div class="stat-sub">${totalEps} episodes total</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Status</div>
      <div class="stat-sub" style="margin-top:6px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--sky)">▶ Watching</span><span>${watching}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--jade)">✓ Completed</span><span>${completed}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--rose)">✕ Dropped</span><span>${dropped}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--amber)">☆ Plan</span><span>${plan}</span></div>
        </div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Insights</div>
      <div class="stat-sub" style="margin-top:6px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;justify-content:space-between"><span>Avg Score</span><span style="color:var(--amber)">${avgScore?`⭐${avgScore}`:'—'}</span></div>
          <div style="display:flex;justify-content:space-between"><span>Best Day</span><span style="color:var(--accent)">${bestDay}</span></div>
          <div style="display:flex;justify-content:space-between"><span>Longest Streak</span><span>${longest}d</span></div>
          <div style="display:flex;justify-content:space-between"><span>Sub/Dub</span><span>${entries.filter(e=>!e.type||e.type==='sub').length}/${entries.filter(e=>e.type==='dub').length}</span></div>
        </div>
      </div>
    </div>
    <div class="stat-card wide">
      <div class="stat-label">🔥 Streak — ${streak} day${streak!==1?'s':''} current · ${longest} day${longest!==1?'s':''} longest</div>
      <div class="streak-bar">${streakDots}</div>
      <div class="stat-sub" style="margin-top:4px">Green = today · Purple = active</div>
    </div>
    ${topGenres.length?`
    <div class="stat-card wide">
      <div class="stat-label">Top Genres</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        ${topGenres.map(([g,c])=>`<span class="tag" style="font-size:11px;padding:3px 10px">${escapeHtml(g)} <span style="opacity:0.6">${c}</span></span>`).join('')}
      </div>
    </div>`:''}
    <div class="stat-card wide">
      <div class="stat-label">Top Sites</div>
      <div class="site-bars">
        ${topSites.length?topSites.map(([site,count])=>`
          <div class="site-bar-row">
            <div class="site-bar-label">${escapeHtml(site)}</div>
            <div class="site-bar-track"><div class="site-bar-fill" style="width:${Math.round((count/maxSite)*100)}%"></div></div>
            <div class="site-bar-count">${count}</div>
          </div>`).join(''):'<div style="color:var(--text-secondary);font-size:11px">No data yet</div>'}
      </div>
    </div>
    <div class="stat-card wide">
      <div class="stat-label">🎲 What to Watch Next?</div>
      <div class="stat-sub" style="margin-bottom:8px">Random pick from Plan to Watch</div>
      <button class="stat-btn" id="btn-random-pick">Surprise Me!</button>
    </div>`;

  document.getElementById('btn-random-pick').addEventListener('click',()=>randomPick(entries));
}

// ─── RANDOM PICK ─────────────────────────────────────────────
function randomPick(entries) {
  const planList=groupByAnime(entries.filter(e=>e.status==='plan'));
  if (!planList.length) { showToast('No Plan to Watch entries!'); return; }
  const high=planList.filter(a=>a.priority==='high');
  const pick=high.length?high[Math.floor(Math.random()*high.length)]:planList[Math.floor(Math.random()*planList.length)];
  document.getElementById('pick-body').innerHTML=`
    <div style="text-align:center;padding:20px 10px">
      ${pick.coverImage?`<img src="${escapeHtml(pick.coverImage)}" style="width:100px;height:140px;object-fit:cover;border-radius:8px;margin-bottom:12px">`:`<div style="font-size:48px;margin-bottom:12px">${animeEmoji(pick.title)}</div>`}
      <div style="font-size:18px;font-weight:800;margin-bottom:6px">${escapeHtml(pick.title)}</div>
      ${pick.malScore?`<div style="color:var(--amber);margin-bottom:6px">⭐ ${pick.malScore} on MAL</div>`:''}
      ${pick.priority==='high'?'<div style="color:var(--rose);font-size:11px;margin-bottom:8px">🔴 High Priority</div>':''}
      <div style="color:var(--text-secondary);font-size:12px;margin-bottom:16px">From your Plan to Watch list</div>
      <button class="btn-primary btn-full" id="btn-start-pick">▶ Start Watching</button>
    </div>`;
  document.getElementById('pick-modal').classList.remove('hidden');
  document.getElementById('btn-start-pick').addEventListener('click',async()=>{
    const all=await getEntries();
    const idx=all.findIndex(e=>e.id===pick.id); // by id, not by title text
    if (idx!==-1) all[idx].status='watching';
    await saveEntries(all);
    document.getElementById('pick-modal').classList.add('hidden');
    renderAll();
    showToast(`Started: ${pick.title}!`,'success');
  });
}

// ─── TOGGLE PIN ──────────────────────────────────────────────
async function togglePin(id, targetPinnedState) {
  const entries=await getEntries();
  const idx=entries.findIndex(e=>e.id===id);
  if (idx!==-1) {
    // Mutate ONLY this specific entry by its unique id — not "every entry
    // whose title matches", which used to mean pinning one card could
    // silently pin/unpin a completely different duplicate entry that just
    // happened to share the same title text (see title-drift bugs).
    entries[idx].pinned = targetPinnedState;
    await saveEntries(entries);
    renderLibrary();
    showToast(targetPinnedState?'📌 Pinned!':'Unpinned','success');
  }
}

// ─── EDIT MODAL ──────────────────────────────────────────────
async function openEditModal(id) {
  const entries=await getEntries();
  const entry=entries.find(e=>e.id===id);
  if (!entry) return;
  document.getElementById('modal-title').value=entry.title;
  document.getElementById('modal-episode').value=entry.episode;
  document.getElementById('modal-total').value=entry.totalEpisodes||'';
  document.getElementById('modal-status').value=entry.status;
  document.getElementById('modal-priority').value=entry.priority||'normal';
  document.getElementById('modal-type').value=entry.type||'sub';
  document.getElementById('modal-season').value=entry.season||'';
  document.getElementById('modal-tags').value=(entry.tags||[]).join(', ');
  document.getElementById('modal-notes').value=entry.notes||'';
  document.getElementById('modal-entry-id').value=id;
  document.getElementById('edit-modal').classList.remove('hidden');
}

// ─── SAVE/UPDATE ENTRY ───────────────────────────────────────
// ─── REWATCH DETECTION (manual-save path) ────────────────────
// Identical logic to background.js's recordEpisodeWatch — kept as a
// separate copy because popup.js and background.js run in separate
// contexts (same pattern already used for the Jikan/AniList matcher in
// this codebase). Both auto-tracked (background.js, on real EPISODE_
// COMPLETE) and manually-saved (here, on "Save This Episode" / manual
// URL entry) episodes write to the same entry.episodeHistory /
// entry.totalRewatchViews fields, so the rewatch count can't drift
// depending on which path recorded a given watch.
function recordEpisodeWatch(entry, epKey) {
  if (!entry || !epKey) return { isRewatch: false, count: 1 };
  epKey = String(epKey);
  if (!entry.episodeHistory) entry.episodeHistory = {};
  const rec = entry.episodeHistory[epKey] || { count: 0, firstWatchedAt: Date.now(), lastWatchedAt: Date.now() };
  rec.count += 1;
  rec.lastWatchedAt = Date.now();
  entry.episodeHistory[epKey] = rec;
  entry.totalRewatchViews = Object.values(entry.episodeHistory).reduce((s, r) => s + Math.max(0, (r.count || 1) - 1), 0);
  const isRewatch = rec.count > 1;
  if (isRewatch) {
    chrome.notifications.create(`rewatch_${entry.id}_${epKey}_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '🔁 Rewatch detected!',
      message: `${entry.title} — Episode ${epKey}: this is watch #${rec.count}`,
      priority: 0
    });
  }
  return { isRewatch, count: rec.count };
}

async function saveOrUpdateEntry({title,episode,url,status,notes,epNotes,tags,totalEpisodes,priority,type,season}) {
  const entries=await getEntries();
  const key=title.toLowerCase().trim();
  const existingIdx=entries.findIndex(e=>e.title.toLowerCase().trim()===key);
  const tagList=parseTags(tags);
  const ts=Date.now();
  const settings=await getSettings();
  const introMins=parseFloat(settings.introLength)||0;

  const jikan=await searchJikan(title);
  const finalTotal=totalEpisodes||(jikan?.totalEps?String(jikan.totalEps):'');
  const isComplete=finalTotal&&parseInt(episode)>=parseInt(finalTotal);
  const epNum=parseInt(episode)||0;
  const totalNum=parseInt(finalTotal)||0;
  const epDuration=jikan?parseEpDuration(jikan.duration):24;
  const timeWatchedMins=Math.max(0,(epNum*epDuration)-(epNum*introMins));
  const timeRemainingMins=totalNum?Math.max(0,(totalNum-epNum)*epDuration):null;

  const jikanData=jikan?{
    malId:jikan.malId,coverImage:jikan.coverImage,
    malScore:jikan.malScore,genres:jikan.genres,
    studio:jikan.studio,airingStatus:jikan.airingStatus,
    synopsis:jikan.synopsis,epDuration,
    broadcastDay:jikan.broadcastDay,broadcastTime:jikan.broadcastTime,broadcastTimezone:jikan.broadcastTimezone
  }:{};

  if (existingIdx!==-1) {
    const prev=entries[existingIdx];
    const wasComplete=prev.status==='completed';
    const episodeActuallyChanged = episode && String(episode)!==String(prev.episode);
    entries[existingIdx]={
      ...prev,...jikanData,
      episode,url,
      status:isComplete&&!wasComplete?'completed':status,
      notes,epNotes:epNotes||'',tags:tagList,
      totalEpisodes:finalTotal,priority:priority||'normal',
      type:type||'sub',season:season||'',savedAt:ts,
      timeWatchedMins,timeRemainingMins
    };
    // Only record a watch when the episode number genuinely changed on
    // this save — re-saving the same episode (e.g. re-detecting mid-
    // playback) shouldn't count as a second view of it.
    if (episodeActuallyChanged) recordEpisodeWatch(entries[existingIdx], episode);
    await saveEntries(entries);
    await malSyncEntry(entries[existingIdx]);
    if (isComplete&&!wasComplete) {
      const groups=groupByAnime(entries);
      const ag=groups.find(g=>g.title.toLowerCase().trim()===key);
      if (ag) setTimeout(()=>showCompletionModal(ag),600);
    }
    return {updated:true};
  } else {
    const newEntry={
      id:generateId(),
      title:jikan?.title||title,episode,url,
      status:isComplete?'completed':status,
      notes:notes||'',epNotes:epNotes||'',tags:tagList,
      totalEpisodes:finalTotal,priority:priority||'normal',
      type:type||'sub',season:season||'',pinned:false,savedAt:ts,
      timeWatchedMins,timeRemainingMins,episodeHistory:{},totalRewatchViews:0,...jikanData
    };
    if (episode) recordEpisodeWatch(newEntry, episode);
    entries.push(newEntry);
    await saveEntries(entries);
    await malSyncEntry(newEntry);
    return {updated:false};
  }
}

// ─── BACKUP ──────────────────────────────────────────────────
async function autoBackup() {
  const settings=await getSettings();
  if (!settings.autoBackup) return;
  try {
    const entries=await getEntries();
    if (!entries.length) return;
    const backup={signature:FILE_SIGNATURE,version:6,exportedAt:new Date().toISOString(),count:entries.length,entries};
    const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    await chrome.downloads.download({url,filename:'ANITRACK_BACKUP.json',conflictAction:'overwrite',saveAs:false});
    URL.revokeObjectURL(url);
  } catch(e){console.log('Backup failed:',e.message);}
}

async function exportBackup() {
  const entries=await getEntries();
  const backup={signature:FILE_SIGNATURE,version:6,exportedAt:new Date().toISOString(),count:entries.length,entries};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=`ANITRACK_BACKUP_${new Date().toISOString().split('T')[0]}.json`;
  a.click();URL.revokeObjectURL(url);
  showToast('Backup exported ✓','success');
}

async function importBackup(file) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=async e=>{
      try {
        const data=JSON.parse(e.target.result);
        if (!data.signature||data.signature!==FILE_SIGNATURE) { reject(new Error('Not a valid AniTrack backup!')); return; }
        const existing=await getEntries();
        const ids=new Set(existing.map(e=>e.id));
        const merged=[...existing,...data.entries.filter(e=>!ids.has(e.id))];
        await saveEntries(merged);
        resolve({added:merged.length-existing.length,total:merged.length});
      } catch(err){reject(err);}
    };
    reader.readAsText(file);
  });
}

// ─── STORAGE INFO ────────────────────────────────────────────
async function updateStorageInfo() {
  const entries=await getEntries();
  const bytes=new TextEncoder().encode(JSON.stringify(entries)).length;
  const kb=Math.round(bytes/1024*10)/10;
  const el=document.getElementById('storage-info');
  if (el) el.textContent=`${entries.length} anime · ${kb} KB used`;
}

// ─── MAL UI ──────────────────────────────────────────────────
async function updateMALUI() {
  const data=await new Promise(r=>chrome.storage.local.get(['mal_access_token','mal_username'],r));
  const isConnected=!!data.mal_access_token;
  document.getElementById('mal-disconnected').classList.toggle('hidden',isConnected);
  document.getElementById('mal-connected').classList.toggle('hidden',!isConnected);
  document.getElementById('mal-loading').classList.add('hidden');
  const malBtn=document.getElementById('btn-mal-connect');
  if (isConnected) {
    malBtn.textContent='✅ MAL';
    malBtn.classList.add('connected');
    if (data.mal_username) document.getElementById('mal-username').textContent=data.mal_username;
    const actEl=document.getElementById('mal-actions');
    if (actEl) { actEl.style.display='flex'; actEl.classList.remove('hidden'); }
  } else {
    malBtn.textContent='🔗 MAL';
    malBtn.classList.remove('connected');
    const actEl=document.getElementById('mal-actions');
    if (actEl) { actEl.style.display='none'; actEl.classList.add('hidden'); }
  }
}

// Cleans up dirty stored titles before searching — strips a trailing
// " - SiteName" / " | SiteName" fragment (common leftover from earlier
// auto-detect runs) and stray punctuation at the edges.
function sanitizeForSearch(title) {
  if (!title) return '';
  let t = title.split(/\s*[|]\s*/)[0]; // drop " | Something" tail
  // If there's a trailing " - Word" fragment that looks like a short site
  // name (not part of a normal title), drop it. Heuristic: short single
  // word after the last " - ", no digits, not part of common title patterns.
  const dashParts = t.split(/\s+-\s+/);
  if (dashParts.length > 1) {
    const tail = dashParts[dashParts.length - 1];
    if (/^[A-Za-z]{3,20}$/.test(tail) && !/season|part|movie|ova|special/i.test(tail)) {
      t = dashParts.slice(0, -1).join(' - ');
    }
  }
  return t.replace(/^[\s\-–—|,:.]+|[\s\-–—|,:.]+$/g, '').replace(/\s+/g,' ').trim();
}

// ─── LINK TO MAL (manual match, for titles auto-detect couldn't find) ──
function openLinkModal(entryId, animeTitle) {
  const cleaned = sanitizeForSearch(animeTitle);
  document.getElementById('link-entry-id').value = entryId;
  document.getElementById('link-entry-title').value = animeTitle;
  document.getElementById('link-search-input').value = cleaned;
  document.getElementById('link-results').innerHTML = '';
  document.getElementById('link-modal').classList.remove('hidden');
  runLinkSearch();
}

async function runLinkSearch() {
  const query = document.getElementById('link-search-input').value.trim();
  const resultsEl = document.getElementById('link-results');
  if (!query) return;
  resultsEl.innerHTML = '<div style="font-size:11px;color:var(--text-secondary)">Searching…</div>';
  const { results, error } = await searchAnimeMulti(query);
  if (!results.length) {
    resultsEl.innerHTML = error
      ? `<div style="font-size:11px;color:var(--text-secondary)">Search failed: ${escapeHtml(error)}. Try again in a moment.</div>`
      : '<div style="font-size:11px;color:var(--text-secondary)">No matches. Try a different title (e.g. the Japanese romaji name).</div>';
    return;
  }
  resultsEl.innerHTML = '';
  results.forEach(r=>{
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;cursor:pointer;padding:6px;border-radius:8px;border:1px solid var(--border)';
    row.innerHTML = `
      ${r.coverImage?`<img src="${escapeHtml(r.coverImage)}" style="width:36px;height:50px;object-fit:cover;border-radius:4px;flex-shrink:0" />`:''}
      <div style="min-width:0">
        <div style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.title)}</div>
        <div style="font-size:10px;color:var(--text-secondary)">${r.year||''}${r.totalEps?` · ${r.totalEps} eps`:''}${r.malScore?` · ⭐${r.malScore}`:''}</div>
      </div>`;
    row.addEventListener('click', async ()=>{
      const entryId = document.getElementById('link-entry-id').value;
      await linkEntryToMAL(entryId, r);
      document.getElementById('link-modal').classList.add('hidden');
      renderAll();
      showToast(`Linked to "${r.title}" on MAL ✓`,'success');
    });
    resultsEl.appendChild(row);
  });
}

// ─── NEW SEASONS TAB ──────────────────────────────────────────
async function getNewSeasons() {
  return new Promise(r=>chrome.storage.local.get('anitrack_new_seasons', d=>r(d.anitrack_new_seasons||[])));
}
async function dismissNewSeason(sequelMalId) {
  const list=await getNewSeasons();
  const idx=list.findIndex(x=>x.sequelMalId===sequelMalId);
  if (idx!==-1) { list[idx].dismissed=true; await new Promise(r=>chrome.storage.local.set({anitrack_new_seasons:list},r)); }
}
async function renderNewSeasons() {
  const all=await getNewSeasons();
  const list=all.filter(s=>!s.dismissed).sort((a,b)=>b.foundAt-a.foundAt);
  const tabBtn=document.querySelector('[data-tab="newseasons"]');
  let badge=tabBtn?.querySelector('.tab-badge');
  if (tabBtn) {
    if (list.length) {
      if (!badge) { badge=document.createElement('span'); badge.className='tab-badge'; tabBtn.appendChild(badge); }
      badge.textContent=list.length;
    } else if (badge) { badge.remove(); }
  }

  const container=document.getElementById('newseasons-list');
  if (!container) return;
  container.innerHTML='';
  if (!list.length) {
    container.innerHTML=`<div class="empty-state"><div class="empty-icon">🆕</div><p>No new seasons yet.</p><p class="empty-sub">We check once a day for sequels/movies to anime you've completed.</p></div>`;
    return;
  }
  for (const s of list) {
    const card=document.createElement('div');
    card.className='anime-card';
    const label=s.type==='Movie'?'🎬 New Movie':'📺 New Season';
    card.innerHTML=`
      <div class="card-poster" style="${s.coverImage?`background-image:url(${escapeHtml(s.coverImage)});background-size:cover;background-position:center;font-size:0`:''}">
        ${s.coverImage?'':'<span style="font-size:24px">🎌</span>'}
      </div>
      <div class="card-info">
        <div class="card-title">${escapeHtml(s.sequelTitle)}</div>
        <div class="card-meta">
          <span class="status-badge watching">${label}</span>
          ${s.malScore?`<span style="font-size:10px;color:var(--amber)">⭐${s.malScore}</span>`:''}
        </div>
        <div class="card-date" style="margin-top:4px">Sequel to ${escapeHtml(s.sourceTitle)}</div>
      </div>
      <div class="card-actions">
        <button class="btn-resume" data-url="https://myanimelist.net/anime/${s.sequelMalId}">View on MAL</button>
        <div class="card-icon-actions">
          <button class="btn-card-icon add-plan-btn" data-id="${s.sequelMalId}" title="Add to Plan to Watch">➕</button>
          <button class="btn-card-icon del dismiss-btn" data-id="${s.sequelMalId}" title="Dismiss">🗑</button>
        </div>
      </div>`;
    card.querySelector('.btn-resume').addEventListener('click',ev=>{ev.stopPropagation();chrome.tabs.create({url:ev.currentTarget.dataset.url});});
    card.querySelector('.add-plan-btn').addEventListener('click', async ev=>{
      ev.stopPropagation();
      const entries=await getEntries();
      let bcDay=null,bcTime=null,bcTz=null;
      try {
        const res=await fetch(`${JIKAN_BASE}/anime/${s.sequelMalId}`);
        if (res.ok) { const a=(await res.json()).data; bcDay=a?.broadcast?.day||null; bcTime=a?.broadcast?.time||null; bcTz=a?.broadcast?.timezone||null; }
      } catch(e) { console.log('add-to-plan broadcast fetch error:', e.message); }
      entries.push({
        id:generateId(),malId:s.sequelMalId,title:s.sequelTitle,
        episode:'0',url:`https://myanimelist.net/anime/${s.sequelMalId}`,
        status:'plan',coverImage:s.coverImage,totalEpisodes:String(s.totalEps||''),
        tags:[],notes:'',epNotes:'',priority:'normal',type:'sub',
        season:'',pinned:false,savedAt:Date.now(),rewatchCount:0,
        malScore:s.malScore,airingStatus:s.airingStatus,
        broadcastDay:bcDay,broadcastTime:bcTime,broadcastTimezone:bcTz
      });
      await saveEntries(entries);
      await dismissNewSeason(s.sequelMalId);
      renderAll();
      showToast(`Added ${s.sequelTitle} to Plan to Watch ✓`,'success');
    });
    card.querySelector('.dismiss-btn').addEventListener('click', async ev=>{
      ev.stopPropagation();
      await dismissNewSeason(s.sequelMalId);
      renderNewSeasons();
      showToast('Dismissed','success');
    });
    container.appendChild(card);
  }
}

// ─── RENDER ALL ──────────────────────────────────────────────
async function renderAll() {
  await Promise.all([renderLibrary(),renderHistory(),renderStats(),renderNewSeasons()]);
  chrome.runtime.sendMessage({type:'UPDATE_BADGE'}).catch(()=>{});
}

// ─── INIT ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  updateMALUI();
  updateStorageInfo();

  const settings=await getSettings();
  const introEl=document.getElementById('intro-length');
  const backupEl=document.getElementById('auto-backup-toggle');
  if (introEl) introEl.value=settings.introLength||1.5;
  if (backupEl) backupEl.checked=settings.autoBackup!==false;

  introEl?.addEventListener('change',async()=>{
    const s=await getSettings();
    await saveSettings({...s,introLength:parseFloat(introEl.value)||1.5});
    showToast('Settings saved','success');
  });
  backupEl?.addEventListener('change',async()=>{
    const s=await getSettings();
    await saveSettings({...s,autoBackup:backupEl.checked});
    showToast(backupEl.checked?'Auto backup on':'Auto backup off','success');
  });

  document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-'+tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab==='settings') { updateMALUI(); updateStorageInfo(); renderSiteTime(); }
      if (tab.dataset.tab==='manga') { renderManga(); }
    });
  });

  // ─── LIBRARY VIEW TOGGLE (List / Organized) ────────────────
  let currentView = 'list';
  document.getElementById('view-toggle-list')?.addEventListener('click', () => {
    currentView = 'list';
    document.getElementById('view-toggle-list').classList.add('active');
    document.getElementById('view-toggle-organized').classList.remove('active');
    document.getElementById('library-list').style.display = '';
    document.getElementById('organized-list').style.display = 'none';
  });
  document.getElementById('view-toggle-organized')?.addEventListener('click', () => {
    currentView = 'organized';
    document.getElementById('view-toggle-organized').classList.add('active');
    document.getElementById('view-toggle-list').classList.remove('active');
    document.getElementById('library-list').style.display = 'none';
    document.getElementById('organized-list').style.display = '';
    renderOrganized();
  });

  document.getElementById('search-input').addEventListener('input',e=>{F.search=e.target.value.trim();renderAll();});
  document.getElementById('status-filter').addEventListener('change',e=>{F.status=e.target.value;renderAll();});
  document.getElementById('sort-select').addEventListener('change',e=>{F.sort=e.target.value;renderLibrary();});

  document.getElementById('btn-theme').addEventListener('click',toggleTheme);
  document.getElementById('settings-theme-btn')?.addEventListener('click',toggleTheme);

  document.getElementById('btn-mal-connect').addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
    document.querySelector('[data-tab="settings"]').classList.add('active');
    document.getElementById('tab-settings').classList.add('active');
  });

  // MAL Login — the popup will very likely close as soon as the auth window
  // opens (it loses focus, which is normal Chrome extension popup behavior).
  // The whole OAuth exchange happens in background.js. Just reopen the
  // extension after logging in and it'll show "Connected".
  document.getElementById('btn-mal-login').addEventListener('click',()=>{
    document.getElementById('mal-disconnected').classList.add('hidden');
    document.getElementById('mal-loading').classList.remove('hidden');
    chrome.runtime.sendMessage({type:'MAL_AUTH'}, (res) => {
      // This callback only fires if the popup is still alive (rare, but harmless either way)
      if (res?.ok) { updateMALUI(); showToast('MAL connected! ✅','success'); }
      else if (res && !res.ok) {
        document.getElementById('mal-loading').classList.add('hidden');
        document.getElementById('mal-disconnected').classList.remove('hidden');
        showToast('MAL connection failed: '+(res.error||'unknown error'),'error');
      }
    });
  });

  document.getElementById('btn-mal-logout').addEventListener('click',async()=>{
    if (!confirm('Disconnect MyAnimeList?')) return;
    await new Promise(r=>chrome.storage.local.remove(['mal_access_token','mal_refresh_token','mal_token_expiry','mal_username'],r));
    updateMALUI();
    showToast('MAL disconnected','success');
  });

  document.getElementById('btn-mal-import')?.addEventListener('click',async()=>{
    showToast('Importing from MAL...');
    const malList=await malImportList();
    if (!malList.length) { showToast('Nothing to import or not connected','error'); return; }
    const entries=await getEntries();
    const existingMalIds=new Set(entries.map(e=>e.malId).filter(Boolean));
    let added=0;
    for (const item of malList) {
      const a=item.node,s=item.list_status;
      if (existingMalIds.has(a.id)) continue;
      const statusMap={'watching':'watching','completed':'completed','on_hold':'watching','dropped':'dropped','plan_to_watch':'plan'};
      entries.push({
        id:generateId(),
        malId:a.id,
        title:a.title,
        episode:String(s.num_episodes_watched||0),
        url:`https://myanimelist.net/anime/${a.id}`,
        status:statusMap[s.status]||'plan',
        coverImage:a.main_picture?.large||a.main_picture?.medium,
        userScore:s.score||null,
        totalEpisodes:String(a.num_episodes||''),
        tags:[],notes:'',epNotes:'',priority:'normal',type:'sub',
        season:'',pinned:false,savedAt:Date.now(),rewatchCount:0
      });
      added++;
    }
    await saveEntries(entries);
    renderAll();
    showToast(`Imported ${added} anime from MAL ✓`,'success');
  });

  document.getElementById('btn-mal-push')?.addEventListener('click',async()=>{
    const entries=await getEntries();
    const withMal=entries.filter(e=>e.malId);
    showToast(`Syncing ${withMal.length} anime to MAL...`);
    for (const e of withMal) { await malSyncEntry(e); await new Promise(r=>setTimeout(r,300)); }
    showToast(`Synced ${withMal.length} anime to MAL ✓`,'success');
  });

  document.getElementById('btn-mal-resync')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-mal-resync');
    const progressEl = document.getElementById('resync-progress');
    btn.disabled = true;
    progressEl.classList.remove('hidden');
    const { linked, skipped, total } = await resyncOldAnime((i, total, title) => {
      progressEl.textContent = `Checking ${i}/${total}: ${title}`;
    });
    progressEl.textContent = total
      ? `Done — linked ${linked}, ${skipped} need manual linking (low match confidence).`
      : 'Nothing to sync — every anime is already linked.';
    btn.disabled = false;
    renderAll();
    showToast(`Synced ${linked} old anime ✓`, 'success');
  });

  document.getElementById('btn-merge-dupes')?.addEventListener('click', async () => {
    const repaired = await repairOldTitles();
    const removed = await mergeDuplicateEntries();
    const parts = [];
    if (repaired) parts.push(`cleaned ${repaired} old titles`);
    if (removed) parts.push(`merged ${removed} duplicates`);
    showToast(parts.length ? parts.join(', ') + ' ✓' : 'Nothing to clean up ✓', 'success');
    renderAll();
  });

// ─── HEADER TIMER (always visible) ─────────────────────────────
// ─── MASCOT (shows real status, not filler text) ───────────────
// ─── MASCOT EXPRESSIONS ─────────────────────────────────────────
// Idle "bones" isn't something static PNGs can do — this is the honest
// alternative: a real 6-frame sprite loop (Neutral → Blink → Smile →
// Bounce → Head Tilt → Back to Idle), cycled on a timer. Same technique
// old-school game sprite animation uses. Pauses whenever a reaction
// (wave/excited) is showing, resumes idle looping after.
const IDLE_FRAMES = ['icons/mascot-idle1.png','icons/mascot-idle2.png','icons/mascot-idle3.png','icons/mascot-idle4.png','icons/mascot-idle5.png','icons/mascot-idle6.png'];
let idleFrameIndex = 0;
let idleLoopTimer = null;
let mascotBusy = false; // true while a reaction (wave/excited) is showing — pauses the idle loop

function startIdleLoop() {
  clearInterval(idleLoopTimer);
  idleLoopTimer = setInterval(() => {
    if (mascotBusy) return;
    const img = document.getElementById('mascot-chibi');
    if (!img) return;
    idleFrameIndex = (idleFrameIndex + 1) % IDLE_FRAMES.length;
    img.src = IDLE_FRAMES[idleFrameIndex];
  }, 600); // matches a natural blink/tilt pace, not too twitchy
}

let mascotRevertTimer = null;
function setMascotExpression(pose, revertAfterMs) {
  const img = document.getElementById('mascot-chibi');
  if (!img) return;
  clearTimeout(mascotRevertTimer);
  mascotBusy = true;
  img.src = `icons/mascot-${pose}.png`;
  if (revertAfterMs) {
    mascotRevertTimer = setTimeout(() => {
      mascotBusy = false; // idle loop picks back up on its own next tick
    }, revertAfterMs);
  }
}
document.getElementById('mascot-chibi')?.addEventListener('click', () => {
  setMascotExpression('wave', 1800);
  const bubble = document.getElementById('mascot-bubble');
  if (bubble) {
    const prev = bubble.textContent;
    bubble.textContent = 'hii~ 👋';
    setTimeout(() => { bubble.textContent = prev; }, 1800);
  }
});
startIdleLoop();

async function updateMascotBubble() {
  const bubble = document.getElementById('mascot-bubble');
  if (!bubble) return;
  const entries = await getEntries();
  const watching = entries.filter(e => e.status === 'watching').sort((a,b) => (b.savedAt||0)-(a.savedAt||0));
  let text = '';
  const recentlyDetected = watching.length && Date.now() - (watching[0].savedAt||0) < 3600000;
  if (recentlyDetected) {
    // Something was detected/updated in the last hour — show it, that's the most relevant thing
    text = `📺 ${watching[0].title} EP ${watching[0].episode}`;
    setMascotExpression('excited', 2500); // something new happened — she's excited, then settles back to idle
  } else if (watching.length) {
    text = `${watching.length} anime in progress`;
  } else {
    text = 'nothing tracked yet~';
  }
  bubble.textContent = text;
  bubble.classList.add('visible');
}

async function updateHeaderTimer() {
  const el = document.getElementById('header-timer');
  if (!el) return;
  const { today } = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_SITE_TIME' }, res => resolve(res || { today: {} }));
  });
  const totalWatchSec = Object.values(today).reduce((s,t)=>s+(t.watching||0),0);
  const h = Math.floor(totalWatchSec/3600), m = Math.floor((totalWatchSec%3600)/60);
  el.textContent = `⏱ ${h>0?`${h}h ${m}m`:`${m}m`} today`;
}

async function renderSiteTime() {
  const el = document.getElementById('site-time-list');
  if (!el) return;
  el.innerHTML = '<div style="font-size:11px;color:var(--text-secondary)">Loading…</div>';
  const { allTime, today } = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_SITE_TIME' }, res => resolve(res || { allTime:{}, today:{} }));
  });
  const fmt = sec => { const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; };
  const domains = Object.keys(allTime).sort((a,b) => ((allTime[b].watching||0)+(allTime[b].browsing||0)) - ((allTime[a].watching||0)+(allTime[a].browsing||0)));
  if (!domains.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--text-secondary)">No tracked time yet — only counts time on whitelisted sites.</div>';
    return;
  }
  el.innerHTML = '';
  domains.forEach(domain => {
    const { watching=0, browsing=0 } = allTime[domain];
    const todayWatch = today[domain]?.watching || 0;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px';
    row.innerHTML = `<div style="display:flex;justify-content:space-between"><span style="font-weight:600">${escapeHtml(domain)}</span><span style="color:var(--accent);font-weight:600">${fmt(watching+browsing)} total</span></div>
      <div style="font-size:10px;color:var(--text-secondary)">👀 watched ${fmt(watching)} · 🌐 browsed ${fmt(browsing)} · 📅 today ${fmt(todayWatch)}</div>`;
    el.appendChild(row);
  });
}

// ─── AUTO-DETECT WHITELIST ─────────────────────────────────
  const WHITELIST_KEY = 'anitrack_whitelist';
  async function getWhitelist() {
    const d = await chrome.storage.local.get(WHITELIST_KEY);
    return d[WHITELIST_KEY] || [];
  }
  async function renderWhitelist() {
    const list = await getWhitelist();
    const el = document.getElementById('whitelist-list');
    if (!el) return;
    el.innerHTML = list.length ? '' : '<div style="font-size:11px;color:var(--text-secondary)">No sites added yet.</div>';
    list.forEach(domain => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px';
      row.innerHTML = `<span>${escapeHtml(domain)}</span><button class="btn-icon" style="padding:2px 8px" data-domain="${escapeHtml(domain)}">✕</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        const updated = (await getWhitelist()).filter(d => d !== domain);
        await chrome.storage.local.set({ [WHITELIST_KEY]: updated });
        renderWhitelist();
        showToast(`Removed ${domain}`, 'success');
      });
      el.appendChild(row);
    });
  }
  document.getElementById('btn-whitelist-add')?.addEventListener('click', async () => {
    const input = document.getElementById('whitelist-input');
    let val = input.value.trim().toLowerCase();
    if (!val) return;
    // accept a pasted full URL too, just take the hostname
    try { if (val.includes('://')) val = new URL(val).hostname; } catch(_) {}
    val = val.replace(/^www\./, '');
    const list = await getWhitelist();
    if (list.includes(val)) { showToast('Already added','error'); return; }
    list.push(val);
    await chrome.storage.local.set({ [WHITELIST_KEY]: list });
    input.value = '';
    renderWhitelist();
    showToast(`${val} added — auto-detect active on next visit ✓`, 'success');
  });
  renderWhitelist();

  document.getElementById('btn-export').addEventListener('click',exportBackup);
  document.getElementById('settings-export')?.addEventListener('click',exportBackup);
  const importHandler=async(file)=>{
    if (!file) return;
    try { const r=await importBackup(file); renderAll(); showToast(`Restored ${r.added} entries ✓`,'success'); }
    catch(err){showToast(err.message,'error');}
  };
  document.getElementById('btn-import').addEventListener('click',()=>document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change',async e=>{await importHandler(e.target.files[0]);e.target.value='';});
  document.getElementById('settings-import-btn')?.addEventListener('click',()=>document.getElementById('import-file').click());

  document.getElementById('btn-clear-data')?.addEventListener('click',async()=>{
    if (!confirm('Delete ALL anime data? This cannot be undone.')) return;
    await saveEntries([]);
    renderAll();
    updateStorageInfo();
    showToast('All data cleared','success');
  });

  document.getElementById('btn-save-tab').addEventListener('click',async()=>{
    const btn=document.getElementById('btn-save-tab');
    btn.disabled=true;btn.querySelector('span').textContent='⏳ Reading tab…';
    try {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if (!tab) throw new Error('No active tab');
      let pageTitle=tab.title||'',pageUrl=tab.url||'';
      try {
        const results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({
          title:document.title,url:window.location.href,
          metaTitle:document.querySelector('meta[property="og:title"]')?.content||''
        })});
        if(results?.[0]?.result){const r=results[0].result;pageTitle=r.metaTitle||r.title||pageTitle;pageUrl=r.url||pageUrl;}
      }catch(_){}

      const parsed=parseAnimeUrl(pageUrl,pageTitle);
      document.getElementById('tab-preview').classList.remove('hidden');
      document.getElementById('tab-preview').innerHTML=`
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">Detected:</div>
        <div style="font-weight:700">${escapeHtml(parsed.title)}</div>
        <div style="color:var(--text-secondary);font-size:11px;margin-top:3px">Episode ${escapeHtml(String(parsed.episode))}</div>
        <div style="color:var(--accent);font-size:10px;font-family:monospace;margin-top:3px">${escapeHtml(truncateUrl(pageUrl))}</div>`;

      const result=await saveOrUpdateEntry({title:parsed.title,episode:parsed.episode,url:pageUrl,status:'watching',notes:'',epNotes:'',tags:[],totalEpisodes:'',priority:'normal',type:'sub',season:''});
      await autoBackup();
      renderAll();
      showToast(result.updated?`Updated: ${parsed.title} → EP ${parsed.episode}`:`Saved: ${parsed.title} EP ${parsed.episode}`,'success');
    }catch(err){showToast('Error: '+err.message,'error');}
    finally{btn.disabled=false;btn.querySelector('span').textContent='⚡ Save This Episode';}
  });

  // ─── QUICK SEARCH & ADD TO PLAN ─────────────────────────────
  async function runQuickAddSearch() {
    const query = document.getElementById('quickadd-search-input').value.trim();
    const resultsEl = document.getElementById('quickadd-results');
    if (!query) return;
    resultsEl.innerHTML = '<div style="font-size:11px;color:var(--text-secondary)">Searching…</div>';
    const { results, error } = await searchAnimeMulti(query, 8);
    if (!results.length) {
      resultsEl.innerHTML = error
        ? `<div style="font-size:11px;color:var(--text-secondary)">Search failed: ${escapeHtml(error)}. Try again.</div>`
        : '<div style="font-size:11px;color:var(--text-secondary)">No matches found.</div>';
      return;
    }
    resultsEl.innerHTML = '';
    results.forEach(r => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:8px';
      row.innerHTML = `
        ${r.coverImage ? `<img src="${r.coverImage}" style="width:40px;height:56px;object-fit:cover;border-radius:4px;flex-shrink:0">` : `<div style="width:40px;height:56px;border-radius:4px;background:var(--card-bg);flex-shrink:0"></div>`}
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.title)}</div>
          <div style="font-size:11px;color:var(--text-secondary)">${r.year||''}${r.malScore?` · ⭐ ${r.malScore}`:''}${r.totalEps?` · ${r.totalEps} eps`:''}</div>
        </div>
        <button class="btn-secondary quickadd-btn" style="white-space:nowrap;padding:6px 10px;font-size:11px" data-malid="${r.malId}">+ Plan</button>`;
      row.querySelector('.quickadd-btn').addEventListener('click', async () => {
        const entries = await getEntries();
        if (entries.some(e => e.malId === r.malId)) {
          showToast('Already in your library', 'error');
          return;
        }
        entries.push({
          id: generateId(), malId: r.malId, title: r.title,
          episode: '0', url: `https://myanimelist.net/anime/${r.malId}`,
          status: 'plan', coverImage: r.coverImage, totalEpisodes: String(r.totalEps||''),
          tags: [], notes: '', epNotes: '', priority: 'normal', type: 'sub',
          season: '', pinned: false, savedAt: Date.now(), rewatchCount: 0,
          malScore: r.malScore, airingStatus: r.airingStatus||null
        });
        await saveEntries(entries);
        renderAll();
        showToast(`${r.title} added to Plan to Watch ✓`, 'success');
      });
      resultsEl.appendChild(row);
    });
  }
  document.getElementById('quickadd-search-btn')?.addEventListener('click', runQuickAddSearch);
  document.getElementById('quickadd-search-input')?.addEventListener('keydown', e => { if (e.key==='Enter') runQuickAddSearch(); });

  document.getElementById('btn-parse-url').addEventListener('click',()=>{
    const url=document.getElementById('manual-url').value.trim();
    if (!url){showToast('Paste a URL first');return;}
    const parsed=parseAnimeUrl(url,'');
    document.getElementById('edit-title').value=parsed.title;
    document.getElementById('edit-episode').value=parsed.episode==='?'?'':parsed.episode;
    document.getElementById('edit-status').value='watching';
    ['edit-tags','edit-notes','edit-ep-notes'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('edit-total').value='';
    document.getElementById('edit-priority').value='normal';
    document.getElementById('edit-type').value='sub';
    document.getElementById('edit-season').value='';
    document.getElementById('manual-preview').classList.remove('hidden');
  });

  document.getElementById('btn-save-manual').addEventListener('click',async()=>{
    const g=id=>document.getElementById(id)?.value?.trim()||'';
    const url=g('manual-url'),title=g('edit-title');
    if (!url){showToast('URL required');return;}
    if (!title){showToast('Title required');return;}
    const result=await saveOrUpdateEntry({
      title,episode:g('edit-episode')||'?',url,
      status:document.getElementById('edit-status').value,
      notes:g('edit-notes'),epNotes:g('edit-ep-notes'),
      tags:g('edit-tags'),totalEpisodes:g('edit-total'),
      priority:document.getElementById('edit-priority').value,
      type:document.getElementById('edit-type').value,
      season:g('edit-season')
    });
    await autoBackup();
    renderAll();
    showToast(result.updated?`Updated ✓`:`Saved ✓`,'success');
    document.getElementById('manual-url').value='';
    document.getElementById('manual-preview').classList.add('hidden');
  });

  const closeModal=id=>document.getElementById(id).classList.add('hidden');
  ['modal-close','epnotes-close','complete-close','pick-close','link-close'].forEach((btnId,i)=>{
    const ids=['edit-modal','epnotes-modal','complete-modal','pick-modal','link-modal'];
    document.getElementById(btnId)?.addEventListener('click',()=>closeModal(ids[i]));
  });
  ['edit-modal','epnotes-modal','complete-modal','pick-modal','link-modal'].forEach(id=>{
    document.getElementById(id)?.addEventListener('click',e=>{if(e.target===document.getElementById(id))closeModal(id);});
  });

  document.getElementById('link-search-btn')?.addEventListener('click',runLinkSearch);
  document.getElementById('link-search-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')runLinkSearch();});

  document.getElementById('modal-save').addEventListener('click',async()=>{
    const g=id=>document.getElementById(id)?.value?.trim()||'';
    const id=g('modal-entry-id'),title=g('modal-title');
    if (!title){showToast('Title required');return;}
    const entries=await getEntries();
    const idx=entries.findIndex(e=>e.id===id);
    if (idx!==-1) {
      const newStatus = document.getElementById('modal-status').value;
      const wasCompleted = entries[idx].status === 'completed';
      const rewatchCount = (wasCompleted && newStatus === 'watching')
        ? (entries[idx].rewatchCount || 0) + 1
        : (entries[idx].rewatchCount || 0);
      entries[idx]={...entries[idx],title,episode:g('modal-episode')||'?',
        status:newStatus,
        priority:document.getElementById('modal-priority').value,
        type:document.getElementById('modal-type').value,
        season:g('modal-season'),
        tags:parseTags(g('modal-tags')),
        notes:g('modal-notes'),
        totalEpisodes:g('modal-total'),
        rewatchCount
      };
      await saveEntries(entries);
      await malSyncEntry(entries[idx]);
      renderAll();
      showToast(rewatchCount > (entries[idx].rewatchCount||0) ? 'Updated ✓ (rewatch tracked)' : 'Updated ✓','success');
    }
    closeModal('edit-modal');
  });

  document.getElementById('btn-check-seasons-now')?.addEventListener('click', async (ev)=>{
    ev.target.textContent='Checking...'; ev.target.disabled=true;
    chrome.runtime.sendMessage({type:'CHECK_SEASONS_NOW'}, async ()=>{
      ev.target.textContent='🔄 Check Now'; ev.target.disabled=false;
      await renderNewSeasons();
      showToast('Checked for new seasons ✓','success');
    });
  });

  renderAll();
  updateHeaderTimer();
  updateMascotBubble();

  // ─── LIVE REFRESH WHILE POPUP IS OPEN ──────────────────────────
  // background.js writes fresh episodePosSec/episodeProgressPct roughly
  // every 10s while a whitelisted tab is actually playing. Without this,
  // the popup only ever shows a snapshot from when it was opened — if
  // you're watching in another tab with the popup open, the "media
  // player" position readout would just sit frozen instead of ticking
  // forward, which is exactly the "doesn't feel like it's tracking"
  // complaint. Throttled to at most once every 4s and only touches the
  // Library tab specifically (cheapest render, and the only one showing
  // the live position readout) to avoid re-rendering everything on every
  // single storage write.
  let _lastLiveRefresh = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const now = Date.now();
    if (now - _lastLiveRefresh < 4000) return;
    _lastLiveRefresh = now;
    if (document.getElementById('tab-library')?.classList.contains('active')) {
      renderLibrary();
      updateHeaderTimer();
    }
  });
});

// ─── URL PARSER (manual "Paste a URL" entry) ──────────────────
// This path had none of the safeguards autoDetectFromTab (background.js)
// has — no junk-title rejection, no "is this actually a watch page"
// check, and the zoro.to/hianime branch only ever read episode from a
// `?ep=` query param, silently returning '?' on URLs that encode the
// episode in the slug instead. Both fixed below: slug-derived titles that
// look like filename junk or a generic browse/category path word are
// discarded in favor of the real page title when one was supplied, and
// the hianime/zoro.to branch falls back to a trailing path number.
function looksLikeUrlParserJunk(title) {
  if (!title) return true;
  const t = title.trim();
  if (/^(file|video|embed|player|stream|source|src|movie|clip|media)[\s_\-#]*\d+$/i.test(t)) return true;
  const letters = (t.match(/[a-z]/gi) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (digits >= 3 && letters <= 4) return true;
  // Generic site-navigation words that show up as URL slugs on non-watch
  // pages (browse/category/search pages) — never a real anime title.
  if (/^(browse|genre|genres|category|categories|tag|tags|search|page|list|home|account|settings|login|signup|about|contact|faq|privacy|terms)$/i.test(t)) return true;
  return false;
}
function parseAnimeUrl(url, pageTitle='') {
  let title='',episode='';
  try {
    const u=new URL(url),host=u.hostname,path=u.pathname,params=u.searchParams;
    if (/hianime|zoro\.to/.test(host)) {
      const m=path.match(/\/watch\/([^\/\?]+)/);
      if (m) title=slugToTitle(m[1].replace(/-\d+$/,''));
      episode=params.get('ep')||'';
      // Fallback: some URLs on these hosts encode the episode as a
      // trailing "-NNN" in the slug rather than (or in addition to) the
      // ?ep= query param — e.g. /watch/attack-on-titan-112. Without this,
      // those URLs silently parsed to episode '?'.
      if (!episode && m) { const tail = m[1].match(/-(\d{1,4})$/); if (tail) episode = tail[1]; }
    } else if (/gogoanime|gogocdn/.test(host)) {
      const m=path.match(/-episode-(\d+)/i);
      if (m){episode=m[1];title=slugToTitle(path.replace(/-episode-\d+.*$/i,'').replace(/^\//,''));}
    } else if (/aniwatch|aniwaves/.test(host)) {
      const seg=path.match(/\/watch\/([^\/]+)\/ep-(\d+)/i);
      if (seg){episode=seg[2];title=slugToTitle(seg[1].replace(/-\d+$/,''));}
      else{const m=path.match(/-ep-(\d+)/i);if(m){episode=m[1];title=slugToTitle(path.replace(/-ep-\d+.*$/i,'').replace(/^\/watch\/?/,'').replace(/^\//,''));}}
      if (!episode) episode=params.get('ep')||'';
    }
    if (!title){
      const wm=path.match(/\/watch\/([^\/]+)\/ep-?(\d+)/i);
      if(wm){episode=wm[2];title=slugToTitle(wm[1].replace(/-\d+$/,''));}
      else{const slug=path.split('/').filter(Boolean).pop()||'';const em=slug.match(/ep[_-]?(\d+)/i);if(em)episode=em[1];const cl=slug.replace(/ep[_-]?\d+/gi,'').replace(/[-_]+$/,'');if(cl)title=slugToTitle(cl);}
    }
  } catch(e){}
  if (/^\d+$/.test(title.trim())) title='';
  // Discard a slug-derived title that's actually filename junk or a
  // generic nav word (e.g. "Action" from /browse/action) — the URL slug
  // "succeeding" in a technical sense doesn't mean it's a real anime name.
  // Let the page-title fallback below have a shot at it instead.
  if (title && looksLikeUrlParserJunk(title)) title = '';
  if (!title&&pageTitle) title=pageTitle.replace(/[-–|]\s*(Watch|Stream|Online|HD).*/i,'').replace(/[Ee]pisode\s*\d+.*/i,'').trim();
  // If even the page-title-derived result is junk (e.g. an embed iframe's
  // own title is literally "File 2771"), don't silently save it as the
  // anime name — fall through to "Unknown Anime" so the user notices and
  // can correct it, rather than polluting the library with junk titles.
  if (title && looksLikeUrlParserJunk(title)) title = '';
  if (!episode&&pageTitle){const m=pageTitle.match(/[Ee]pisode\s*(\d+)|[Ee][Pp]\s*(\d+)/);if(m)episode=m[1]||m[2];}
  return {title:title||'Unknown Anime',episode:episode||'?'};
}
function slugToTitle(s){return s.replace(/[-_]/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g,c=>c.toUpperCase());}
