// background.js — AniTrack v12

// ─── STORAGE WRITE LOCK ─────────────────────────────────────────
// Multiple independent code paths (VIDEO_PROGRESS, EPISODE_COMPLETE, the
// checkpoint alarm's flushActiveSession, autoDetectFromTab) each do their
// own chrome.storage.local.get → mutate in memory → set. Those are three
// separate async hops, and without serialization two of these running back
// to back can both read the old value before either writes, silently
// dropping one of the writes (classic lost-update race). Every storage
// read-modify-write in this file that can plausibly overlap with another
// now runs through this queue so they execute one at a time, in order.
let _storageQueue = Promise.resolve();
function withStorageLock(fn) {
  const run = () => Promise.resolve().then(fn);
  const result = _storageQueue.then(run, run);
  _storageQueue = result.then(() => {}, () => {}); // never let a rejection break the chain
  return result;
}

const STORAGE_KEY = 'anitrack_v3_entries';
const MAL_CLIENT_ID = '60d7be09243fa086087babee513910d8';
const MAL_AUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const WHITELIST_KEY = 'anitrack_whitelist'; // string[] of hostnames user added

// ─── AUTO-DETECT ON WHITELISTED SITES ─────────────────────────
// Generic by design: no per-site selectors. Just reads document.title /
// og:title / h1 (via content.js, already injected on <all_urls>) and
// pulls an episode number out with generic regex patterns that work the
// same everywhere. Only runs on hostnames the user explicitly whitelisted.

function extractEpisodeNumber(text) {
  if (!text) return null;
  const patterns = [
    /chapter\s*#?(\d{1,4}(?:\.\d+)?)/i,   // "Chapter 44.1" — some sites use chapter numbering with sub-parts
    /episode\s*#?(\d{1,4}(?:\.\d+)?)/i,
    /\bep\.?\s*#?(\d{1,4}(?:\.\d+)?)\b/i,
    // CJK episode markers — "第1話" (JP), "第28集" (CN), "1화" (KR). Without
    // these, any non-English-titled site fell through to episode=null on
    // every single detection, which meant the episode number got stuck at
    // "1" forever (the re-detection guard treats null as "unchanged").
    /第\s*(\d{1,4}(?:\.\d+)?)\s*[話话集]/,
    /(\d{1,4}(?:\.\d+)?)\s*화/,
    /\be(\d{1,4})\b/i,
    /[-–—]\s*(\d{1,4}(?:\.\d+)?)\s*$/,   // "Show Name - 12"
    /#(\d{1,4})\b/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1]); // parseFloat, not parseInt — preserves "44.1" instead of truncating to 44
  }
  return null;
}

// Season/part/cour marker — kept separate from the episode number so that
// "Show Season 2 Episode 5" and "Show Season 1 Episode 5" are recognized as
// different points in different seasons instead of colliding on episode
// number alone. Defaults to '1' (i.e. no marker found = assume season 1)
// so it can be compared directly against entry.season everywhere.
function extractSeasonNumber(text) {
  if (!text) return '1';
  const patterns = [
    /season\s*#?(\d{1,3})/i,
    /\bs(\d{1,3})\s*(?:episode|ep|e\d)/i, // "S2 Episode 5" / "S2E5" — avoid matching a bare trailing "S2" alone as noise
    /\bpart\s*#?(\d{1,3})/i,
    /\bcour\s*#?(\d{1,3})/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return '1';
}

// Strips a matched episode fragment and common site-suffix noise
// (" | SiteName", " - SiteName") to leave just the anime name. Uses the
// actual hostname so this works generically for any whitelisted site,
// not just ones with hardcoded names.
function cleanDetectedTitle(text, hostname) {
  if (!text) return '';
  let t = text;

  // Strip a leading "[SiteName] " bracket tag before anything else — but
  // only when the bracket content actually looks like the hostname's own
  // branding, not just any bracket (some real anime titles legitimately
  // start with a bracket, e.g. fansub-group conventions users might type
  // manually). Trailing "- SiteName"/"| SiteName" was already handled
  // below; this covers the leading-tag case that wasn't stripped before,
  // which caused the same anime to save under two different title strings
  // depending on which site it was watched on (duplicate library entries).
  if (hostname) {
    const domainLabel0 = hostname.split('.').slice(-2)[0] || hostname;
    const norm0 = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const bracketMatch = t.match(/^\s*\[([^\]]{1,30})\]\s*/);
    if (bracketMatch) {
      const tag = norm0(bracketMatch[1]);
      if (tag && (tag === norm0(domainLabel0) || norm0(domainLabel0).includes(tag) || tag.includes(norm0(domainLabel0)))) {
        t = t.slice(bracketMatch[0].length);
      }
    }
  }

  t = t
    .replace(/,?\s*chapter\s*#?\d{1,4}(?:\.\d+)?.*/i, '') // "Show, Chapter 44.1" -> "Show"
    .replace(/episode\s*#?\d{1,4}(?:\.\d+)?.*/i, '')
    .replace(/\bep\.?\s*#?\d{1,4}(?:\.\d+)?\b.*/i, '')
    .split(/[|]/)[0]              // drop " | SiteName" tail
    .replace(/[-–—]\s*\d{1,4}(?:\.\d+)?\s*$/, ''); // drop trailing " - 12"

  // Drop a trailing " - SiteName" / " | SiteName" where SiteName is close
  // to the actual hostname label (generic — works for any domain, not a
  // hardcoded site list).
  if (hostname) {
    const domainLabel = hostname.split('.').slice(-2)[0] || hostname;
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const parts = t.split(/\s*[-|–—]\s*/);
    if (parts.length > 1) {
      const tail = norm(parts[parts.length - 1]);
      if (tail && (tail === norm(domainLabel) || norm(domainLabel).includes(tail) || tail.includes(norm(domainLabel)))) {
        t = parts.slice(0, -1).join(' - ');
      }
    }
  }

  return t.replace(/\s+/g, ' ').trim();
}

// URL patterns that generically suggest an actual watch/episode page,
// as opposed to a browse/search/category/home page. Not site-specific —
// these path words are near-universal across streaming sites. Broadened
// with a generic fallback (path has real depth, i.e. not just the domain
// root) since not every site uses "watch"/"episode" in its URLs.
function looksLikeWatchPage(url) {
  if (/\/(watch|episode|ep[-_]?\d|anime\/[^/]+\/\d|-episode-\d|\/e\d+)/i.test(url)) return true;
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean);
    return path.length >= 2; // deeper than the homepage — likely a specific content page
  } catch(_) { return false; }
}

async function isWhitelisted(hostname) {
  const data = await chrome.storage.local.get(WHITELIST_KEY);
  const list = data[WHITELIST_KEY] || [];
  return list.some(domain => hostname === domain || hostname.endsWith('.' + domain));
}

// Rejects filename/ID-style junk titles (e.g. "File 2771", "Video_483",
// "e-2771", bare numeric strings) that bare embed/mirror players
// (MegaPlay and similar) use as their own document.title/h1 in place of
// a real anime name. Generic pattern + digit-density check — no site
// list required.
function looksLikeFilenameJunk(title) {
  if (!title) return true;
  const t = title.trim();
  if (/^(file|video|embed|player|stream|source|src|movie|clip|media)[\s_\-#]*\d+$/i.test(t)) return true;
  if (/^[a-z]{0,3}[\s_\-#]*\d{3,}$/i.test(t)) return true;
  const letters = (t.match(/[a-z]/gi) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (digits >= 3 && letters <= 4) return true;
  return false;
}

// Rejects titles that are really just the site's own branding, not an
// anime name — this is the #1 cause of junk entries like "AnimeNana".
// If the cleaned title, stripped of spaces/punctuation, is basically the
// same string as the hostname's main label, it's not a real anime title.
function looksLikeSiteBranding(title, hostname) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(title);
  const domainLabel = norm(hostname.split('.').slice(-2)[0] || hostname);
  if (!t || !domainLabel) return false;
  if (t === domainLabel) return true;
  // Substring containment is only meaningful once the title has enough
  // characters to actually resemble the domain word — below that, a single
  // letter or two-letter title (a real short anime title, or CJK title that
  // normalizes down to almost nothing) will trivially be "contained in" or
  // "contain" most domain names and get wrongly rejected as branding.
  if (t.length < 4) return false;
  return t.length <= domainLabel.length + 3 && (t.includes(domainLabel) || domainLabel.includes(t));
}

// ─── LIGHTWEIGHT SEARCH + MATCH (background.js copy) ───────────
// background.js runs in a separate context from popup.js, so this is a
// slimmed duplicate of the matcher: query Jikan + AniList, score by
// similarity, return the best confident match so auto-detect can attach
// a real MAL id / English title / cover image immediately instead of
// leaving entries blank until the user manually runs Sync Old Anime.
function bgLevenshtein(a, b) {
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
function bgWordOverlap(a, b) {
  const wa = new Set(a.split(/[\s,\-!?.:;'"()]+/).filter(w=>w.length>1));
  const wb = new Set(b.split(/[\s,\-!?.:;'"()]+/).filter(w=>w.length>1));
  if (!wa.size || !wb.size) return 0;
  let shared=0; wa.forEach(w=>{ if(wb.has(w)) shared++; });
  // Jaccard (shared / union), not shared / MIN(size). Dividing by the
  // smaller set meant a single-word query like "Naruto" scored a perfect
  // 1.0 against ANY title containing the word "naruto" anywhere, including
  // completely different shows like "Boruto: Naruto Next Generations" —
  // confirmed via direct testing. Dividing by the union instead means a
  // one-word match against a four-word title scores low (1/4), while a
  // near-identical title with one extra word still scores high.
  const union = wa.size + wb.size - shared;
  return union ? shared/union : 0;
}
function bgStripDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function bgTitleSimilarity(a, b) {
  a=bgStripDiacritics(a.toLowerCase().trim()); b=bgStripDiacritics(b.toLowerCase().trim());
  if (!a||!b) return 0;
  if (a===b) return 1;
  // Containment bonus only applies when the two strings are reasonably
  // close in length — otherwise "Naruto" is technically "contained in"
  // "Boruto: Naruto Next Generations" and both scored an automatic 0.9,
  // confidently linking two entirely different anime. Requiring the
  // shorter string to cover at least 60% of the longer one keeps this
  // bonus for real near-duplicates (a title with one trailing word added)
  // without rewarding "any substring anywhere."
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if ((a.includes(b) || b.includes(a)) && lenRatio >= 0.6) return 0.85;
  return Math.max(bgLevenshtein(a,b), bgWordOverlap(a,b));
}
async function bgFindBestMatch(title) {
  const jikanP = fetch(`${JIKAN_BASE_BG}/anime?q=${encodeURIComponent(title)}&limit=5&sfw=false`)
    .then(r=>r.ok?r.json():null).then(d=>(d?.data||[]).map(a=>({
      malId:a.mal_id, title:a.title_english||a.title, coverImage:a.images?.jpg?.image_url,
      totalEps:a.episodes||null, malScore:a.score, airingStatus:a.status
    }))).catch(()=>[]);
  const anilistQuery = `query($s:String){Page(perPage:5){media(search:$s,type:ANIME){idMal title{romaji english} coverImage{medium} episodes averageScore status}}}`;
  const anilistP = fetch('https://graphql.anilist.co', {
    method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({query:anilistQuery, variables:{s:title}})
  }).then(r=>r.ok?r.json():null).then(d=>(d?.data?.Page?.media||[]).filter(a=>a.idMal).map(a=>({
    malId:a.idMal, title:a.title.english||a.title.romaji, coverImage:a.coverImage?.medium,
    totalEps:a.episodes||null, malScore:a.averageScore?a.averageScore/10:null,
    airingStatus:a.status==='RELEASING'?'Currently Airing':a.status
  }))).catch(()=>[]);

  const [jikanResults, anilistResults] = await Promise.all([jikanP, anilistP]);
  const combined = [...jikanResults, ...anilistResults];
  const seen = new Set();
  const deduped = combined.filter(r=>{ if(seen.has(r.malId)) return false; seen.add(r.malId); return true; });
  deduped.forEach(r => r._score = bgTitleSimilarity(title, r.title));
  deduped.sort((a,b)=>b._score-a._score);
  const top = deduped[0], second = deduped[1];
  if (!top || top._score < 0.6) return null;
  // Ambiguity guard: if the runner-up is nearly as good a match as the top
  // result, this is exactly the situation where a spinoff/sequel/prequel
  // with a similar name could get auto-linked instead of the real match
  // (or vice versa). Auto-link only when the top result clearly wins, or
  // scores high enough (>=0.9, i.e. effectively exact/near-exact) that
  // ambiguity doesn't matter. Otherwise leave malId unset — the entry
  // still saves locally, just without a forced (possibly wrong) MAL link;
  // the user can link it manually from the library card.
  if (second && top._score < 0.9 && (top._score - second._score) < 0.12) return null;
  return top;
}

// ─── MAL push (slim copy, background context) ──────────────────
async function bgGetMalToken() {
  const d = await chrome.storage.local.get(['mal_access_token','mal_token_expiry']);
  if (!d.mal_access_token) return null;
  if (d.mal_token_expiry && Date.now() > d.mal_token_expiry - 60000) {
    const r = await refreshMalToken();
    if (!r.ok) return null;
    const fresh = await chrome.storage.local.get(['mal_access_token']);
    return fresh.mal_access_token || null;
  }
  return d.mal_access_token;
}
async function bgPushToMal(entry) {
  if (!entry.malId) return;
  const token = await bgGetMalToken();
  if (!token) return; // not connected, silently skip — this is optional enrichment, not required
  try {
    await fetch(`https://api.myanimelist.net/v2/anime/${entry.malId}/my_list_status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'watching', num_watched_episodes: String(entry.episode || 0) })
    });
  } catch(e) { console.log('bgPushToMal error:', e.message); }
}

const MANGA_STORAGE_KEY = 'anitrack_manga_entries'; // fully separate from anime — no MAL, no Jikan/AniList

async function autoDetectManga(title, chapter, url, hostname) {
  const data = await chrome.storage.local.get(MANGA_STORAGE_KEY);
  const entries = data[MANGA_STORAGE_KEY] || [];
  const normKey = s => s.toLowerCase().trim();
  let entry = entries.find(e => normKey(e.title) === normKey(title));

  let isNew = false;
  if (entry) {
    const chChanged = chapter && parseFloat(entry.chapter) !== chapter;
    if (!chChanged) return; // nothing changed, don't spam
    entry.chapter = String(chapter);
    entry.url = url;
    entry.savedAt = Date.now();
  } else {
    isNew = true;
    entry = {
      id: 'manga_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title,
      chapter: chapter ? String(chapter) : '1',
      url,
      hostname,
      status: 'reading',
      savedAt: Date.now(),
      autoDetected: true
    };
    entries.push(entry);
  }

  await chrome.storage.local.set({ [MANGA_STORAGE_KEY]: entries });
  chrome.notifications.create(`mangadetect_${entry.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: isNew ? '📖 Manga detected' : '📖 Chapter updated',
    message: `${title}${chapter ? ' — Chapter ' + chapter : ''} saved`,
    priority: 0
  });
}

async function autoDetectFromTab(tabId, url) {
  try {
    const hostname = new URL(url).hostname;
    if (!(await isWhitelisted(hostname))) return;

    // The video player is very often embedded in an iframe (different
    // origin than the page itself) — querying only the top frame (the
    // old behavior) means the player is simply invisible, no matter how
    // good the detection logic is. Enumerate every frame in the tab and
    // ask each one directly.
    const frames = await new Promise(resolve => {
      chrome.webNavigation.getAllFrames({ tabId }, result => resolve(result || []));
    }).catch(() => []);
    const frameIds = frames.length ? frames.map(f => f.frameId) : [0];

    const results = await Promise.all(frameIds.map(frameId => new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE_INFO' }, { frameId }, res => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res ? { ...res, _frameId: frameId } : null);
      });
    })));
    const validResults = results.filter(Boolean);
    if (!validResults.length) return;

    // The <video> element is very often inside a bare embed/mirror iframe
    // (MegaPlay and similar) whose own document.title/h1 is just a
    // filename or numeric ID ("File 2771"), while the PARENT frame — the
    // actual site page — has the real anime name but no <video> tag of
    // its own. Picking whichever frame "has the video" for the title (the
    // old behavior) means junk wins every time on these sites. Instead:
    // score every frame's title, reject filename/ID-style junk, and
    // prefer the top frame (frameId 0, the real page) on a tie. Video
    // presence is tracked separately across ALL frames so it isn't lost
    // just because the winning title-frame lacks its own <video> tag.
    const hasVideoAnywhere = validResults.some(r => r.hasVideo);
    const bestTitleOf = r => r.h1 || r.metaTitle || r.title || '';
    const candidates = validResults
      .map(r => ({ r, text: bestTitleOf(r) }))
      .filter(c => c.text && !looksLikeFilenameJunk(c.text));

    let pageInfo;
    if (candidates.length) {
      candidates.sort((a, b) => {
        if (a.r._frameId === 0 && b.r._frameId !== 0) return -1;
        if (b.r._frameId === 0 && a.r._frameId !== 0) return 1;
        return b.text.length - a.text.length;
      });
      pageInfo = candidates[0].r;
    } else {
      // No frame anywhere has a usable non-junk title — degrade to the
      // old best-effort behavior rather than dropping detection entirely.
      pageInfo = validResults.find(r => r.hasVideo)
        || validResults.sort((a,b) => bestTitleOf(b).length - bestTitleOf(a).length)[0];
    }
    pageInfo = { ...pageInfo, hasVideo: pageInfo.hasVideo || hasVideoAnywhere };

    const raw = pageInfo.h1 || pageInfo.metaTitle || pageInfo.title || '';
    if (!raw) return;

    let rawTitle = cleanDetectedTitle(raw, hostname);
    const episode = extractEpisodeNumber(raw);
    const detectedSeason = extractSeasonNumber(raw); // '1' if no marker found
    // Strip stray leading/trailing punctuation left over after suffix
    // removal (dangling "-", ",", "|", ":" etc.) — this is the "half text,
    // commas and signs" mess from cleanup leaving dirty edges behind.
    rawTitle = rawTitle.replace(/^[\s\-–—|,:.]+|[\s\-–—|,:.]+$/g, '').trim();
    if (!rawTitle) return;

    // Reject site-branding text (e.g. "AnimeNana") before it ever becomes an entry.
    if (looksLikeSiteBranding(rawTitle, hostname)) return;
    // Reject filename/ID-style junk (e.g. "File 2771") that slipped through
    // even after frame-preference scoring — this is the last line of
    // defense against embed-only pages with no real title anywhere.
    if (looksLikeFilenameJunk(rawTitle)) return;
    // Too short to be a real title (single word under 3 chars, stray nav text, etc.)
    if (rawTitle.length < 3) return;
    // Only create NEW entries from pages that actually look like a watch/
    // episode page, or where a real episode number was found. This is what
    // stops browse/search/category pages from generating junk entries.
    const confidentPage = episode !== null || looksLikeWatchPage(url);
    if (!confidentPage) return;

    // Generic content-type signal: anime pages have a real <video> element,
    // manga reading pages don't. No site-specific guessing needed. Manga
    // skips Jikan/AniList entirely — those are anime databases, matching
    // manga titles against them would just produce wrong results.
    const contentType = pageInfo.hasVideo ? 'anime' : 'manga';
    if (contentType === 'manga') {
      await autoDetectManga(rawTitle, episode, url, hostname);
      return;
    }

    // Look up a confident match right away — this is what fills in the
    // English title, cover image, episode count, and MAL id immediately
    // instead of leaving the entry blank until a manual resync.
    const match = await bgFindBestMatch(rawTitle);
    const canonicalTitle = match ? match.title : rawTitle;
    const normKey = s => s.toLowerCase().trim();

    const { entry, isNew, skip } = await withStorageLock(async () => {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const entries = data[STORAGE_KEY] || [];

      // Dedupe: prefer matching by malId when we have one (most reliable),
      // but ALSO fall back to matching text against any existing entry —
      // including ones with no malId yet. Without this fallback, an earlier
      // detection that failed to match (saved with malId:null) never gets
      // found by a later successful match, so a duplicate entry gets
      // created instead of upgrading the original.
      //
      // Season is required to agree too. The fuzzy matcher can legitimately
      // resolve "Show Season 2" to the same malId as "Show" (some MAL
      // entries don't split by season) — without checking season here,
      // that would silently overwrite Season 1's episode progress with
      // Season 2's episode number on the very same entry. Different season
      // = different entry, even if malId matches.
      let entry = null;
      if (match) {
        entry = entries.find(e => e.malId === match.malId && (e.season || '1') === detectedSeason)
          || entries.find(e => !e.malId && (e.season || '1') === detectedSeason && (normKey(e.title) === normKey(canonicalTitle) || normKey(e.title) === normKey(rawTitle)));
      } else {
        entry = entries.find(e => (e.season || '1') === detectedSeason && normKey(e.title) === normKey(canonicalTitle));
      }

      let isNew = false;
      if (entry) {
        const epChanged = episode && parseFloat(entry.episode) !== episode;
        if (!epChanged && entry.malId) return { entry, isNew: false, skip: true }; // nothing changed, don't spam
        if (epChanged) { entry.episode = String(episode); }
        entry.url = url;
        entry.savedAt = Date.now();
        if (match && !entry.malId) {
          entry.malId = match.malId;
          entry.title = match.title;
          entry.coverImage = match.coverImage;
          entry.totalEps = match.totalEps;
          entry.malScore = match.malScore;
          entry.airingStatus = match.airingStatus;
        }
      } else {
        isNew = true;
        entry = {
          id: 'auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          title: canonicalTitle,
          episode: episode ? String(episode) : '1',
          url,
          status: 'watching',
          contentType: 'anime',
          season: detectedSeason !== '1' ? detectedSeason : '',
          savedAt: Date.now(),
          autoDetected: true,
          malId: match?.malId || null,
          coverImage: match?.coverImage || null,
          totalEps: match?.totalEps || null,
          malScore: match?.malScore || null,
          airingStatus: match?.airingStatus || null,
          episodeHistory: {},
          totalRewatchViews: 0
        };
        entries.push(entry);
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: entries });
      return { entry, isNew };
    });
    if (skip) return;

    if (entry.malId) await bgPushToMal(entry); // syncs on its own now, no manual step needed

    chrome.notifications.create(`autodetect_${entry.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: isNew ? '👀 AniTrack detected' : '🔄 AniTrack updated',
      message: `${canonicalTitle}${episode ? ' — Episode ' + episode : ''} saved${entry.malId ? ' & synced' : ''}`,
      priority: 0
    });
  } catch (e) {
    console.log('autoDetectFromTab error:', e.message);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    autoDetectFromTab(tabId, tab.url);
  }
});

// ─── PER-SITE + PER-ANIME TIME TRACKING ─────────────────────────
// Two independent layers, not one:
// LAYER A (primary) — real <video> playback progress from content.js.
// This is ground truth: if currentTime actually advanced, you actually
// watched that many seconds. Delta-based, capped to reject seeks/jumps.
// LAYER B (fallback) — tab-focus/idle based, exactly as before. Only
// credited as "watching" if Layer A hasn't reported for this hostname
// recently (meaning no accessible <video> element — DRM-locked player,
// or a site structure our hook can't reach). Always credited as
// "browsing" on non-watch pages regardless, since Layer A only fires
// on pages with video anyway.
// Both layers write through the same creditTime() so site/daily/url/entry
// totals stay consistent no matter which layer contributed.
const SITE_TIME_KEY = 'anitrack_site_time'; // { [hostname]: {watching, browsing} }
const DAILY_TIME_KEY = 'anitrack_site_time_daily'; // { 'YYYY-MM-DD': { [hostname]: {watching, browsing} } }
const URL_TIME_KEY = 'anitrack_url_time'; // { [url]: {watching, browsing, lastSeen} } — per-episode granularity
let activeSession = { hostname: null, startedAt: null, isWatching: false, entryId: null };
let lastVideoProgressAt = {}; // hostname -> timestamp of last Layer A report, used to decide if fallback should fire
let lastVideoTimeByUrl = {}; // url -> last reported currentTime, for delta calculation

function todayKey() { return new Date().toISOString().slice(0,10); }

// ─── REWATCH DETECTION ───────────────────────────────────────────
// Single source of truth for "have I watched this specific episode before,
// and how many times". Called from EPISODE_COMPLETE (real playback, Layer
// A) here in background.js, and from an identical copy in popup.js on the
// manual-save path — both write to the same entry.episodeHistory /
// entry.totalRewatchViews fields so counts can't drift apart depending on
// which path saved the episode.
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

// Single shared credit path — every second logged, from either layer,
// goes through here so all four levels of granularity (site, daily, url,
// per-anime entry) always stay in sync with each other.
// entryId here MUST be a confident (exact-URL) match — never the "guess"
// from findLikelyEntryForHostname's hostname-only fallback. Writing
// per-entry watchTimeSec off a guess is exactly how Tab A's progress ends
// up credited to whatever anime Tab B (or an earlier visit) most recently
// touched on the same domain. Site/daily/url aggregate totals are safe to
// credit either way since they're not anime-specific.
async function creditTime(hostname, url, isWatching, elapsedSec, entryId) {
  if (elapsedSec <= 0) return;
  return withStorageLock(() => creditTimeUnlocked(hostname, url, isWatching, elapsedSec, entryId));
}
async function creditTimeUnlocked(hostname, url, isWatching, elapsedSec, entryId) {
  const data = await chrome.storage.local.get([SITE_TIME_KEY, DAILY_TIME_KEY, URL_TIME_KEY, STORAGE_KEY]);

  const totals = data[SITE_TIME_KEY] || {};
  const bucket = totals[hostname] || { watching: 0, browsing: 0 };
  if (isWatching) bucket.watching += elapsedSec; else bucket.browsing += elapsedSec;
  totals[hostname] = bucket;

  const daily = data[DAILY_TIME_KEY] || {};
  const day = todayKey();
  if (!daily[day]) daily[day] = {};
  const dayBucket = daily[day][hostname] || { watching: 0, browsing: 0 };
  if (isWatching) dayBucket.watching += elapsedSec; else dayBucket.browsing += elapsedSec;
  daily[day][hostname] = dayBucket;
  const cutoff = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  Object.keys(daily).forEach(d => { if (d < cutoff) delete daily[d]; });

  const urlTotals = data[URL_TIME_KEY] || {};
  if (url) {
    const urlBucket = urlTotals[url] || { watching: 0, browsing: 0, lastSeen: 0 };
    if (isWatching) urlBucket.watching += elapsedSec; else urlBucket.browsing += elapsedSec;
    urlBucket.lastSeen = Date.now();
    urlTotals[url] = urlBucket;
    // keep only the most recent 500 URLs so storage doesn't grow forever
    const urlKeys = Object.keys(urlTotals);
    if (urlKeys.length > 500) {
      urlKeys.sort((a,b) => urlTotals[a].lastSeen - urlTotals[b].lastSeen);
      urlKeys.slice(0, urlKeys.length - 500).forEach(k => delete urlTotals[k]);
    }
  }

  let entries = data[STORAGE_KEY] || [];
  if (isWatching && entryId) {
    const entry = entries.find(e => e.id === entryId);
    if (entry) entry.watchTimeSec = (entry.watchTimeSec || 0) + elapsedSec;
  }

  await chrome.storage.local.set({
    [SITE_TIME_KEY]: totals, [DAILY_TIME_KEY]: daily, [URL_TIME_KEY]: urlTotals, [STORAGE_KEY]: entries
  });
}

async function flushActiveSession() {
  if (!activeSession.hostname || !activeSession.startedAt) return;
  const elapsedSec = Math.round((Date.now() - activeSession.startedAt) / 1000);
  if (elapsedSec > 0) {
    // Fallback only credits "watching" if Layer A hasn't reported recently
    // for this hostname — otherwise Layer A already covered it, and
    // crediting again here would double-count the same real seconds.
    const videoActiveRecently = (Date.now() - (lastVideoProgressAt[activeSession.hostname] || 0)) < 20000;
    const creditAsWatching = activeSession.isWatching && !videoActiveRecently;
    await creditTime(activeSession.hostname, activeSession.url, creditAsWatching, elapsedSec, activeSession.entryId);
  }
  activeSession.startedAt = Date.now(); // checkpoint, keep session running
}

async function pauseSession() {
  await flushActiveSession();
  activeSession = { hostname: null, url: null, startedAt: null, isWatching: false, entryId: null };
}

// Returns { entryId, confident }. confident=true ONLY for an exact URL
// match — that's the one case where we actually know which anime this is.
// The hostname-only fallback ("most recently touched entry on this
// domain") is a guess, and callers must NOT use a non-confident entryId to
// write per-episode data (watchTimeSec, episodePosSec, episode number).
// Previously this function returned a single id with no confidence signal,
// so every caller treated the guess as fact — that's how progress from one
// tab/anime could get written onto whatever anime was last touched on the
// same site, even in a different tab entirely.
async function findLikelyEntryForHostname(hostname, url) {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const entries = data[STORAGE_KEY] || [];

  if (url) {
    const exact = entries.find(e => e.url === url);
    if (exact) return { entryId: exact.id, confident: true };
  }

  const matches = entries.filter(e => { try { return new URL(e.url).hostname === hostname; } catch(_) { return false; } });
  matches.sort((a,b) => (b.savedAt||0) - (a.savedAt||0));
  return { entryId: matches[0]?.id || null, confident: false };
}

async function maybeStartSession(hostname, url) {
  const watching = looksLikeWatchPage(url);
  if (activeSession.hostname === hostname && activeSession.startedAt && activeSession.isWatching === watching) {
    activeSession.url = url; // keep url current even without restarting the session
    // Re-resolve entryId too — if the URL changed within the same watching
    // session (next episode, different show), the credited entry needs to
    // follow, not stay locked to whatever was true when the session started.
    // Only carry a CONFIDENT (exact-URL) match — an unconfident guess must
    // not silently attach this session's time to the wrong anime.
    if (watching) {
      const r = await findLikelyEntryForHostname(hostname, url);
      activeSession.entryId = r.confident ? r.entryId : null;
    } else {
      activeSession.entryId = null;
    }
    return;
  }
  await pauseSession();
  if (!(await isWhitelisted(hostname))) return;
  let entryId = null;
  if (watching) {
    const r = await findLikelyEntryForHostname(hostname, url);
    entryId = r.confident ? r.entryId : null;
  }
  activeSession = { hostname, url, startedAt: Date.now(), isWatching: watching, entryId };
}

async function refreshActiveTabSession() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) { await pauseSession(); return; }
    const hostname = new URL(tab.url).hostname;
    await maybeStartSession(hostname, tab.url);
  } catch (e) { /* non-http tabs, chrome:// etc — just skip */ }
}

chrome.tabs.onActivated.addListener(refreshActiveTabSession);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) refreshActiveTabSession();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) pauseSession();
  else refreshActiveTabSession();
});
// Closing the tracked tab entirely wasn't covered before — that time was
// just silently lost until the next 1-min checkpoint or event fired.
chrome.tabs.onRemoved.addListener(() => {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
    if (!tab) pauseSession(); else refreshActiveTabSession();
  });
});
// Guarded — if the "idle" permission isn't actually active yet (Chrome
// disables extensions pending manual re-approval when new permissions are
// added), calling this unguarded would throw and silently kill every
// listener registered below it in this file, which is a much bigger bug
// than just losing idle-detection. Degrade gracefully instead.
try {
  if (chrome.idle) {
    chrome.idle.setDetectionInterval(15); // tightest interval Chrome allows
    chrome.idle.onStateChanged.addListener((state) => {
      if (state !== 'active') pauseSession();
      else refreshActiveTabSession();
    });
  } else {
    console.log('chrome.idle unavailable — check chrome://extensions for a pending permission approval on AniTrack');
  }
} catch(e) {
  console.log('chrome.idle setup failed:', e.message);
}

const TIME_CHECKPOINT_ALARM = 'anitrack_time_checkpoint';
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(TIME_CHECKPOINT_ALARM, { periodInMinutes: 1 });
  refreshActiveTabSession(); // don't wait for a tab-switch event that may never come
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(TIME_CHECKPOINT_ALARM, { periodInMinutes: 1 });
  refreshActiveTabSession();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TIME_CHECKPOINT_ALARM) {
    // Flush whatever's tracked, then re-verify against the actual active
    // tab. This is what makes tracking self-heal within ~1 min if the
    // service worker restarted mid-watch and missed the events that
    // normally start a session.
    flushActiveSession().then(refreshActiveTabSession);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SITE_TIME') {
    (async () => {
      await flushActiveSession(); // make sure current session is up to date first
      const data = await chrome.storage.local.get([SITE_TIME_KEY, DAILY_TIME_KEY]);
      sendResponse({
        allTime: data[SITE_TIME_KEY] || {},
        today: (data[DAILY_TIME_KEY] || {})[todayKey()] || {}
      });
    })();
    return true;
  }
  if (message.type === 'VIDEO_PROGRESS') {
    (async () => {
      try {
        const hostname = new URL(message.url).hostname;
        if (!(await isWhitelisted(hostname))) return;
        lastVideoProgressAt[hostname] = Date.now(); // marks Layer A as active, suppresses fallback double-count

        const match = await findLikelyEntryForHostname(hostname, message.url);
        // Site/daily/url aggregate time is safe to credit either way (it's
        // not anime-specific). Per-entry data below is gated on confidence.
        const rate = message.playbackRate || 1;
        const realElapsedSec = message.watchedDelta / rate;
        if (realElapsedSec > 0) {
          await creditTime(hostname, message.url, true, realElapsedSec, match.confident ? match.entryId : null);
        }

        // Resume position + live progress % — only ever written when we
        // have a CONFIRMED (exact URL) match. Writing this off the
        // hostname-only guess is exactly how episode position/progress for
        // one anime could land on a different anime's library card.
        if (match.confident && match.entryId) {
          await withStorageLock(async () => {
            const data = await chrome.storage.local.get(STORAGE_KEY);
            const entries = data[STORAGE_KEY] || [];
            const entry = entries.find(e => e.id === match.entryId);
            if (entry) {
              entry.episodePosSec = Math.round(message.currentTime);
              entry.episodeDurationSec = Math.round(message.duration);
              entry.episodeProgressPct = Math.round((message.currentTime / message.duration) * 100);
              entry.playbackRate = message.playbackRate || 1;
              await chrome.storage.local.set({ [STORAGE_KEY]: entries });
            }
          });
        }
      } catch(e) { console.log('VIDEO_PROGRESS handling error:', e.message); }
    })();
    return false; // fire-and-forget, no response needed
  }
  if (message.type === 'EPISODE_COMPLETE') {
    (async () => {
      try {
        const hostname = new URL(message.url).hostname;
        if (!(await isWhitelisted(hostname))) return;
        const match = await findLikelyEntryForHostname(hostname, message.url);
        // Same rule as above: an unconfident guess must never write
        // completion/rewatch data onto the wrong anime. If autoDetect
        // hasn't saved this exact URL yet, we simply skip this one
        // completion event rather than risk crediting it to whatever
        // anime was last touched on the same site.
        if (!match.confident || !match.entryId) return;
        await withStorageLock(async () => {
          const data = await chrome.storage.local.get(STORAGE_KEY);
          const entries = data[STORAGE_KEY] || [];
          const entry = entries.find(e => e.id === match.entryId);
          if (!entry) return;
          // Percentage-based completion signal from content.js — mark this
          // specific episode as fully watched. Doesn't change entry.status;
          // that's still a manual/library decision, this just records that
          // playback genuinely reached the end of this episode.
          entry.lastEpisodeCompletedAt = Date.now();
          recordEpisodeWatch(entry, entry.episode || '1');
          await chrome.storage.local.set({ [STORAGE_KEY]: entries });
        });
      } catch(e) { console.log('EPISODE_COMPLETE handling error:', e.message); }
    })();
    return false;
  }
});

// Many streaming sites change episode without a full page reload (SPA-style
// client-side routing via history.pushState). tabs.onUpdated alone misses
// these entirely, which is the real cause of "detection stops working" when
// clicking through episodes. This catches URL changes tabs.onUpdated can't.
let lastNavUrl = {};
try {
  if (chrome.webNavigation) {
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
      if (details.frameId !== 0) return; // top frame only
      if (lastNavUrl[details.tabId] === details.url) return; // dedupe
      lastNavUrl[details.tabId] = details.url;
      // small delay lets the page's own JS finish updating the title/DOM
      // after the route change before we read it
      setTimeout(() => autoDetectFromTab(details.tabId, details.url), 800);
    });
  } else {
    console.log('chrome.webNavigation unavailable — check chrome://extensions for a pending permission approval on AniTrack');
  }
} catch(e) {
  console.log('chrome.webNavigation setup failed:', e.message);
}

// ─── BADGE (unchanged from v4) ───────────────────────────────
async function updateBadge() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const entries = data[STORAGE_KEY] || [];
    const watching = entries.filter(e => e.status === 'watching').length;
    if (watching > 0) {
      chrome.action.setBadgeText({ text: String(watching) });
      chrome.action.setBadgeBackgroundColor({ color: '#c084fc' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    console.log('Badge update error:', e);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) updateBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// ─── MAL OAuth (PKCE, plain method — MAL only supports "plain") ──
// MAL's OAuth2 requires code_challenge_method=plain, so code_verifier === code_challenge.
function generateCodeVerifier(length = 96) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const randomVals = new Uint8Array(length);
  crypto.getRandomValues(randomVals);
  for (let i = 0; i < length; i++) result += chars[randomVals[i] % chars.length];
  return result;
}

async function startMalAuth() {
  const codeVerifier = generateCodeVerifier();
  const redirectUri = chrome.identity.getRedirectURL(); // https://<ext-id>.chromiumapp.org/
  const state = generateCodeVerifier(24);

  const authUrl = `${MAL_AUTH_URL}?response_type=code`
    + `&client_id=${encodeURIComponent(MAL_CLIENT_ID)}`
    + `&code_challenge=${encodeURIComponent(codeVerifier)}`
    + `&code_challenge_method=plain`
    + `&state=${encodeURIComponent(state)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    if (!responseUrl) throw new Error('No response from MAL login');

    const url = new URL(responseUrl);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code) throw new Error('No authorization code returned');
    if (returnedState !== state) throw new Error('State mismatch — possible tampering');

    // Exchange code for tokens
    const tokenRes = await fetch(MAL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MAL_CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      throw new Error('Token exchange failed: ' + errText.slice(0, 200));
    }

    const tokenData = await tokenRes.json();
    const expiry = Date.now() + (tokenData.expires_in * 1000);

    await chrome.storage.local.set({
      mal_access_token: tokenData.access_token,
      mal_refresh_token: tokenData.refresh_token,
      mal_token_expiry: expiry
    });

    // Fetch username right away so popup can show it next time it opens
    try {
      const profRes = await fetch('https://api.myanimelist.net/v2/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      if (profRes.ok) {
        const prof = await profRes.json();
        if (prof?.name) await chrome.storage.local.set({ mal_username: prof.name });
      }
    } catch (_) { /* non-fatal */ }

    return { ok: true };
  } catch (e) {
    console.log('MAL auth error:', e.message);
    return { ok: false, error: e.message };
  }
}

async function refreshMalToken() {
  try {
    const data = await chrome.storage.local.get(['mal_refresh_token']);
    if (!data.mal_refresh_token) return { ok: false, error: 'No refresh token' };

    const res = await fetch(MAL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MAL_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: data.mal_refresh_token
      })
    });

    if (!res.ok) return { ok: false, error: 'Refresh failed' };

    const tokenData = await res.json();
    const expiry = Date.now() + (tokenData.expires_in * 1000);
    await chrome.storage.local.set({
      mal_access_token: tokenData.access_token,
      mal_refresh_token: tokenData.refresh_token || data.mal_refresh_token,
      mal_token_expiry: expiry
    });
    return { ok: true };
  } catch (e) {
    console.log('MAL refresh error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── MESSAGE ROUTER ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TAB_INFO') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        sendResponse({ url: tabs[0].url, title: tabs[0].title, tabId: tabs[0].id });
      } else {
        sendResponse({ error: 'No active tab' });
      }
    });
    return true;
  }

  if (message.type === 'UPDATE_BADGE') {
    updateBadge();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'CHECK_SEASONS_NOW') {
    checkNewSeasons().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'MAL_AUTH') {
    // Note: the popup will very likely close as soon as this opens (it loses focus).
    // That's expected — the whole flow runs here in the background, tokens get
    // stored, and the popup shows "Connected" the next time it's opened.
    startMalAuth().then(sendResponse);
    return true;
  }

  if (message.type === 'MAL_REFRESH') {
    refreshMalToken().then(sendResponse);
    return true;
  }
});

// ─── NEW SEASON WATCHER ───────────────────────────────────────
// Once a day, checks anime marked "completed" for a newly released sequel
// season, and fires a Chrome notification if one is found and hasn't been
// flagged before. Runs on an alarm (not on every popup open) to stay cheap.
const SEASON_CHECK_ALARM = 'anitrack_season_check';
const NEW_SEASONS_KEY = 'anitrack_new_seasons'; // [{sequelMalId, sequelTitle, sourceTitle, coverImage, malScore, totalEps, airingStatus, type, foundAt, dismissed}]
const JIKAN_BASE_BG = 'https://api.jikan.moe/v4';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SEASON_CHECK_ALARM, { periodInMinutes: 1440, delayInMinutes: 2 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SEASON_CHECK_ALARM, { periodInMinutes: 1440, delayInMinutes: 2 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SEASON_CHECK_ALARM) checkNewSeasons();
});

async function checkNewSeasons() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY, NEW_SEASONS_KEY]);
    const entries = data[STORAGE_KEY] || [];
    const newSeasons = data[NEW_SEASONS_KEY] || [];
    const seenIds = new Set(newSeasons.map(s => s.sequelMalId));

    // Unique completed anime that have a known MAL id (needed to look up relations)
    const completedMap = new Map();
    entries.forEach(e => {
      if ((e.status === 'completed' || e.status === 'watching' || e.status === 'dropped') && e.malId) {
        const key = e.title.toLowerCase().trim();
        if (!completedMap.has(key)) completedMap.set(key, e);
      }
    });
    const libraryMalIds = new Set(entries.map(e => e.malId).filter(Boolean));

    let added = false;
    for (const anime of completedMap.values()) {
      await new Promise(r => setTimeout(r, 1200)); // gentle on Jikan's rate limit
      try {
        const relRes = await fetch(`${JIKAN_BASE_BG}/anime/${anime.malId}/relations`);
        if (!relRes.ok) continue;
        const relData = await relRes.json();
        const seqRel = (relData.data || []).find(r => r.relation === 'Sequel');
        if (!seqRel || !seqRel.entry || !seqRel.entry.length) continue;
        const seqId = seqRel.entry[0].mal_id;

        if (libraryMalIds.has(seqId)) continue; // already tracking it
        if (seenIds.has(seqId)) continue; // already recorded

        await new Promise(r => setTimeout(r, 1200));
        const seqRes = await fetch(`${JIKAN_BASE_BG}/anime/${seqId}`);
        if (!seqRes.ok) continue;
        const seqData = (await seqRes.json()).data;
        if (!seqData) continue;
        // MAL's status field can lag hours/a day behind the real broadcast,
        // so also trust the actual aired.from date as a fallback — don't
        // rely on status alone or premiere-day sequels get missed.
        const airedFrom = seqData.aired?.from ? new Date(seqData.aired.from).getTime() : null;
        const hasAired = seqData.status !== 'Not yet aired' || (airedFrom && airedFrom <= Date.now());
        if (!hasAired) continue; // wait until it's actually out

        const isMovie = seqData.type === 'Movie';
        const record = {
          sequelMalId: seqId,
          sequelTitle: seqData.title_english || seqData.title,
          sourceTitle: anime.title,
          coverImage: seqData.images?.jpg?.large_image_url || seqData.images?.jpg?.image_url || '',
          malScore: seqData.score || null,
          totalEps: seqData.episodes || null,
          airingStatus: seqData.status === 'Not yet aired' ? 'Currently Airing' : seqData.status,
          type: seqData.type || '',
          foundAt: Date.now(),
          dismissed: false
        };
        newSeasons.push(record);
        seenIds.add(seqId);
        added = true;

        chrome.notifications.create(`newseason_${seqId}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: isMovie ? '🎬 New Movie Available!' : (anime.status === 'dropped' ? '🤔 Worth a Second Look?' : '📺 New Season Available!'),
          message: anime.status === 'dropped'
            ? `You dropped ${anime.title} — a new one (${record.sequelTitle}) just came out`
            : `${anime.title} → ${record.sequelTitle}`,
          priority: 1
        });
      } catch (e) {
        console.log('Season check error for', anime.title, ':', e.message);
      }
    }

    if (added) await chrome.storage.local.set({ [NEW_SEASONS_KEY]: newSeasons });
    console.log(`checkNewSeasons: scanned ${completedMap.size} eligible anime, found ${added ? 'new' : 'no'} sequels`);
  } catch (e) {
    console.log('checkNewSeasons error:', e.message);
  }
}

// Clicking the notification opens the sequel's MAL page
chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId.startsWith('newseason_')) {
    const seqId = notifId.replace('newseason_', '');
    chrome.tabs.create({ url: `https://myanimelist.net/anime/${seqId}` });
    chrome.notifications.clear(notifId);
  }
});

// ─── NEXT EPISODE NOTIFIER ─────────────────────────────────────
// The on-card countdown only shows when you actually open the popup, so it's
// useless as an alert. This runs every 30 min and pushes a real Chrome
// notification the first time it sees, for a "watching" anime, that today is
// its broadcast day and the broadcast time (JST) has already passed.
const NEXTEP_ALARM = 'anitrack_nextep_check';
const NEXTEP_NOTIFIED_KEY = 'anitrack_nextep_notified'; // {malId: 'YYYY-M-D' last notified}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(NEXTEP_ALARM, { periodInMinutes: 30, delayInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(NEXTEP_ALARM, { periodInMinutes: 30, delayInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NEXTEP_ALARM) checkNextEpisodes();
});

function getWeekdayNumBG(name) {
  if (!name) return null;
  const map = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const clean = name.toLowerCase().trim().replace(/s$/, '');
  return clean in map ? map[clean] : null;
}

async function checkNextEpisodes() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY, NEXTEP_NOTIFIED_KEY]);
    const entries = data[STORAGE_KEY] || [];
    const notified = data[NEXTEP_NOTIFIED_KEY] || {};

    const OFFSET_MIN = 9 * 60; // JST fixed
    const nowUTC = Date.now();
    const nowJST = new Date(nowUTC + OFFSET_MIN * 60000);
    const jstDay = nowJST.getUTCDay();
    const jstHour = nowJST.getUTCHours();
    const jstMin = nowJST.getUTCMinutes();
    const todayKey = `${nowJST.getUTCFullYear()}-${nowJST.getUTCMonth() + 1}-${nowJST.getUTCDate()}`;

    let checked = 0, fired = 0;
    let changed = false;
    for (const e of entries) {
      if (e.status !== 'watching' || e.airingStatus !== 'Currently Airing') continue;
      if (!e.broadcastDay || !e.broadcastTime || !e.malId) continue;
      checked++;
      const wd = getWeekdayNumBG(e.broadcastDay);
      if (wd === null || wd !== jstDay) continue;
      const parts = e.broadcastTime.split(':').map(Number);
      const bh = parts[0], bm = parts[1] || 0;
      if (isNaN(bh)) continue;
      const aired = (jstHour > bh) || (jstHour === bh && jstMin >= bm);
      if (!aired) continue;
      if (notified[e.malId] === todayKey) continue; // already pinged today

      chrome.notifications.create(`nextep_${e.malId}_${todayKey}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '🆕 New Episode Out!',
        message: `${e.title} — next episode just aired`,
        priority: 1
      });
      notified[e.malId] = todayKey;
      changed = true;
      fired++;
    }
    if (changed) await chrome.storage.local.set({ [NEXTEP_NOTIFIED_KEY]: notified });
    console.log(`checkNextEpisodes: checked ${checked} airing entries, fired ${fired} notifications`);
  } catch (e) {
    console.log('checkNextEpisodes error:', e.message);
  }
}
