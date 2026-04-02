#!/usr/bin/env node
/**
 * fetch-kurokamii.js
 * สร้าง / อัปเดต playlist JSON จาก kurokamii.com พร้อม metadata จาก TMDB
 * Stream ผ่าน Cloudflare Worker proxy (CORS bypass)
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า anime บน kurokamii.com
 *                      เช่น https://kurokamii.com/anime/6423
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY    TMDB API key (ถ้าไม่ใส่จะอ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ (ใช้เมื่อ search ได้ผลผิด)
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *
 *   # Fetch พากย์ไทย (สร้างไฟล์ใหม่)
 *   node fetch-kurokamii.js https://kurokamii.com/anime/6423 --track=th --output=FILENAME.txt
 *
 *   # อัปเดต metadata จาก TMDB
 *   node fetch-kurokamii.js --update-meta --output=FILENAME.txt
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - Stream ผ่าน CF Worker: https://shy-haze-2452.natajrak-p.workers.dev/
 *   - UUID มาจาก iframe akuma-player.xyz/play/{uuid}
 *   - Stream URL: files.akuma-player.xyz/view/{uuid}
 *   - TMDB_API_KEY อ่านจาก tools/.env หรือ .env อัตโนมัติ
 */

const cheerio = require("cheerio");
const fs      = require("fs");
const path    = require("path");

// ───── Load .env ─────
const envPath = fs.existsSync(path.resolve(__dirname, ".env"))
  ? path.resolve(__dirname, ".env")
  : path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf-8").split("\n").forEach((line) => {
    const [key, ...val] = line.trim().split("=");
    if (key && !process.env[key]) process.env[key] = val.join("=").trim().replace(/^['"]|['"]$/g, "");
  });
}

// ───── CLI args ─────
const args        = process.argv.slice(2);
const seriesUrl   = args.find((a) => a.startsWith("http"));
const tmdbKey     = (args.find((a) => a.startsWith("--tmdb-key=")) || "").replace("--tmdb-key=", "") || process.env.TMDB_API_KEY || "";
const customOutput = (args.find((a) => a.startsWith("--output=")) || "").replace("--output=", "");
const idPrefixArg  = (args.find((a) => a.startsWith("--id-prefix=")) || "").replace("--id-prefix=", "");

const trackArg    = (args.find((a) => a.startsWith("--track=")) || "").replace("--track=", "");
const TRACK_MAP   = { th: "พากย์ไทย", subth: "ซับไทย" };
const trackName   = TRACK_MAP[trackArg] || trackArg || "พากย์ไทย";
const isDubbedTrack = trackName === "พากย์ไทย";
const filterTrack = trackArg ? trackName : null;

const seasonArg   = args.find((a) => a.startsWith("--season="));
const seasonNum   = seasonArg ? (parseInt(seasonArg.replace("--season=", "")) || 1) : null;
const seasonName  = seasonNum ? `Season ${seasonNum}` : null;

const updateMetaArg  = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta     = !!updateMetaArg;
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "all";

const tmdbIdArg   = args.find((a) => a.startsWith("--tmdb-id="));
const forceTmdbId = tmdbIdArg ? parseInt(tmdbIdArg.replace("--tmdb-id=", "")) || null : null;

const typeArg     = (args.find((a) => a.startsWith("--type=")) || "").replace("--type=", "");
const contentType = ['anime-series','anime-movie','movie','series'].includes(typeArg) ? typeArg : 'anime-series';
const isMovie     = contentType === 'anime-movie' || contentType === 'movie';

if (!seriesUrl && !updateMeta) {
  console.error("Usage: node fetch-kurokamii.js <url> [--track=th|subth] [--season=N] [--output=FILE]");
  console.error("       node fetch-kurokamii.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt");
  process.exit(1);
}

// ───── Config ─────
const TYPE_CONFIG = {
  'anime-series': { dir: '../playlist/anime/series', base: 'playlist/anime/series/'  },
  'anime-movie':  { dir: '../playlist/anime/movies', base: 'playlist/anime/movies/'  },
  'movie':        { dir: '../playlist/movies',       base: 'playlist/movies/'        },
  'series':       { dir: '../playlist/series',       base: 'playlist/series/'        },
};
const PLAYLIST_DIR    = path.resolve(__dirname, TYPE_CONFIG[contentType].dir);
const INDEX_PATH      = path.resolve(PLAYLIST_DIR, 'index.txt');
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/${TYPE_CONFIG[contentType].base}`;
const CF_PROXY        = "https://shy-haze-2452.natajrak-p.workers.dev/";
const PLAYER_REFERER  = "https://akuma-player.xyz/";

const HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer":         "https://kurokamii.com/",
};

// ───── Helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** ดึง Inertia version จาก data-page attribute ของ HTML */
async function getInertiaVersion(animeUrl) {
  const html = await fetchHtml(animeUrl);
  const m = html.match(/data-page='([^']+)'/) || html.match(/data-page="([^"]+)"/);
  if (!m) throw new Error("ไม่พบ data-page attribute — อาจไม่ใช่ Inertia app");
  const page = JSON.parse(m[1].replace(/&quot;/g, '"'));
  return page.version;
}

/** Inertia JSON request */
async function fetchInertia(url, version) {
  const res = await fetch(url, {
    headers: {
      ...HEADERS,
      "X-Inertia":         "true",
      "X-Inertia-Version": version,
      "X-Requested-With":  "XMLHttpRequest",
      "Accept":            "application/json, text/plain, */*",
    },
  });
  if (!res.ok) throw new Error(`Inertia HTTP ${res.status} for ${url}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(name) {
  return name
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** แปลง UUID → stream URL ผ่าน CF proxy */
function buildStreamUrl(uuid) {
  const streamUrl = `https://files.akuma-player.xyz/view/${uuid}`;
  return `${CF_PROXY}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(PLAYER_REFERER)}`;
}

// ───── Step 1: Parse anime page (Inertia) ─────
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);

  // ดึง Inertia version จาก HTML ก่อน
  const version = await getInertiaVersion(url);
  console.log(`🔑 Inertia version: ${version}`);

  const data    = await fetchInertia(url, version);
  const anime   = data.props?.anime;
  if (!anime) throw new Error("ไม่พบ anime props ใน Inertia response");

  const title     = anime.cat_title || "";
  const posterImg = anime.cat_image || anime.cover_md || "";
  const catId     = anime.cat_id;

  const episodes = (anime.episode_list || []).map(ep => ({
    url:     `https://kurokamii.com/anime/${catId}/episode/${ep.list_id}`,
    epTitle: ep.list_title || "",
    listId:  ep.list_id,
  }));

  // เรียงตาม list_id (ascending)
  episodes.sort((a, b) => a.listId - b.listId);

  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน`);
  return { title, posterImg, episodes, version };
}

// ───── Step 2: Get UUID from episode page (Inertia) ─────
async function getEpisodeUuid(epPageUrl, version) {
  const data = await fetchInertia(epPageUrl, version);
  const cur  = data.props?.currentEpisode;
  if (!cur) throw new Error(`ไม่พบ currentEpisode ใน ${epPageUrl}`);

  // UUID จาก player_url: https://akuma-player.xyz/play/{uuid}
  const playerUrl = cur.player_url || "";
  const m = playerUrl.match(/akuma-player\.xyz\/play\/([a-f0-9-]+)/i)
         || (cur.uuid ? [null, cur.uuid] : null);
  if (!m) throw new Error(`ไม่พบ UUID ใน ${epPageUrl}`);
  return m[1];
}

// ───── Step 3: TMDB metadata (เหมือน fetch-indy-anime.js) ─────
function cleanTitleForSearch(title) {
  return title
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/พากย์ไทย|ซับไทย|ซับ|พากย์/g, "")
    .replace(/[\u0E00-\u0E7F]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchTmdb(title, apiKey) {
  const query = encodeURIComponent(cleanTitleForSearch(title));
  const url   = `https://api.themoviedb.org/3/search/tv?query=${query}&language=en-US&api_key=${apiKey}`;
  const res   = await fetch(url);
  if (!res.ok) return null;
  const data  = await res.json();
  return data.results?.[0] || null;
}

async function getTmdbShow(tvId, apiKey, language = "en-US") {
  const url = `https://api.themoviedb.org/3/tv/${tvId}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function getTmdbShowNameTh(tvId, apiKey) {
  const data = await getTmdbShow(tvId, apiKey, "th-TH");
  return data?.name || null;
}

function formatSeriesTitle(enName, thName) {
  if (thName && thName !== enName) return `${enName} [${thName}]`;
  return enName;
}

async function getTmdbSeason(tvId, apiKey, season = 1, language = "en-US") {
  const url  = `https://api.themoviedb.org/3/tv/${tvId}/season/${season}?language=${language}&api_key=${apiKey}`;
  const res  = await fetch(url);
  if (!res.ok) return { episodes: [], poster: null };
  const data = await res.json();
  return {
    episodes: data.episodes || [],
    poster:   data.poster_path ? `https://image.tmdb.org/t/p/original${data.poster_path}` : null,
  };
}

function isGenericEpisodeName(name) {
  if (!name) return true;
  const s = name.trim();
  return /^Episode\s+\d+$/i.test(s) || /^ตอนที่\s*\d+$/.test(s);
}

async function getTmdbSeasonBilingual(tvId, apiKey, season = 1) {
  const [enData, thData] = await Promise.all([
    getTmdbSeason(tvId, apiKey, season, "en-US"),
    getTmdbSeason(tvId, apiKey, season, "th-TH"),
  ]);
  const thEps = thData.episodes.map((thEp, i) => {
    const enName = enData.episodes[i]?.name || "";
    const thName = isGenericEpisodeName(thEp.name) ? enName : (thEp.name || enName);
    return { ...enData.episodes[i], ...thEp, name: thName };
  });
  return { enEpisodes: enData.episodes, thEpisodes: thEps, poster: enData.poster };
}

// ── TMDB Movie functions ───────────────────────────────────────────
async function searchTmdbMovie(title, apiKey) {
  const query = encodeURIComponent(cleanTitleForSearch(title));
  const url   = `https://api.themoviedb.org/3/search/movie?query=${query}&language=en-US&api_key=${apiKey}`;
  const res   = await fetch(url);
  if (!res.ok) return null;
  const data  = await res.json();
  return data.results?.[0] || null;
}

async function getTmdbMovieDetail(movieId, apiKey, language = "en-US") {
  const url = `https://api.themoviedb.org/3/movie/${movieId}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function getTmdbMovieNameTh(movieId, apiKey) {
  const data = await getTmdbMovieDetail(movieId, apiKey, "th-TH");
  return data?.title || null;
}

// ───── Step 4: Build station name ─────
function buildStationName(epNum, epTitle, isDubbed) {
  if (!epTitle) return isDubbed ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbed ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

// ───── Step 5: Build / merge playlist JSON ─────
function buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName) {
  const newTrack = { name: trackName, image: seasonPosterUrl, stations };

  if (fs.existsSync(outputPath)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(outputPath, "utf-8")); }
    catch { console.warn("⚠️  ไฟล์เดิม parse ไม่ได้ สร้างใหม่แทน"); existing = null; }

    if (existing) {
      const targetName = seasonName || "Season 1";
      let season = existing.groups?.find((g) => g.name === targetName)
        ?? (seasonNum ? null : existing.groups?.[0]);

      if (!season) {
        existing.groups = existing.groups || [];
        season = { name: targetName, image: seasonPosterUrl, groups: [] };
        existing.groups.push(season);
      }

      if (season.stations && !season.groups) {
        const otherTrack = trackName === "พากย์ไทย" ? "ซับไทย" : "พากย์ไทย";
        season.groups = [{ name: otherTrack, image: season.image || posterUrl, stations: season.stations }];
        delete season.stations;
      }

      season.groups = season.groups || [];
      season.groups = season.groups.filter((g) => g.name !== trackName);
      season.groups.push(newTrack);
      season.groups.sort((a, b) => {
        if (a.name === "พากย์ไทย") return -1;
        if (b.name === "พากย์ไทย") return 1;
        return 0;
      });

      console.log(`\n🔀 Merge "${trackName}" เข้าไฟล์เดิม (${season.groups.length} tracks)`);
      return existing;
    }
  }

  return {
    name:   seriesTitle,
    image:  posterUrl,
    groups: [{ name: seasonName || "Season 1", image: seasonPosterUrl, groups: [newTrack] }],
  };
}

// ── Build / update part file ({tmdbId}-{slug}.txt) ──────────────
function buildPartFile(outputPath, season, posterUrl, trackName, streamUrl, streamReferer) {
  const partName   = `ภาค ${season}`;
  const newStation = {
    name:  trackName,
    image: posterUrl,
    url:   streamUrl,
    ...(streamReferer && { referer: streamReferer }),
  };

  let playlist;
  if (fs.existsSync(outputPath)) {
    try { playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8")); }
    catch { playlist = null; }
  }

  if (!playlist) {
    return { name: partName, image: posterUrl, stations: [newStation] };
  }

  playlist.name  = partName;
  playlist.image = posterUrl;
  playlist.stations = (playlist.stations || []).filter(s => s.name !== trackName);
  playlist.stations.push(newStation);
  playlist.stations.sort((a, b) => {
    if (a.name === "พากย์ไทย") return -1;
    if (b.name === "พากย์ไทย") return 1;
    return 0;
  });
  console.log(`\n🔀 Merge "${trackName}" เข้า ${partName}`);
  return playlist;
}

// ── Upsert group entry in main file ({slug}.txt) ──────────────
function upsertMainFile(mainPath, franchiseName, franchisePoster, partTitle, partPoster, partFileRawUrl, season) {
  const badgeName = `ภาค ${season}`;

  let main;
  if (fs.existsSync(mainPath)) {
    try { main = JSON.parse(fs.readFileSync(mainPath, "utf-8")); }
    catch { main = null; }
  }

  if (!main) {
    main = { name: franchiseName, image: franchisePoster, groups: [] };
  }
  // Don't overwrite existing root name/image

  main.groups = main.groups || [];
  const existing = main.groups.find(g => g.url === partFileRawUrl);
  if (existing) {
    existing.name  = partTitle;
    existing.image = partPoster;
    existing.badge = badgeName;
    console.log(`\n🔀 อัปเดต group "${badgeName}" ใน main file`);
  } else {
    main.groups.push({ name: partTitle, image: partPoster, url: partFileRawUrl, badge: badgeName });
    console.log(`\n➕ เพิ่ม group "${badgeName}" เข้า main file`);
  }

  main.groups.sort((a, b) => {
    const na = parseInt(a.badge?.match(/\d+/)?.[0]) || 0;
    const nb = parseInt(b.badge?.match(/\d+/)?.[0]) || 0;
    return na - nb;
  });

  return main;
}

// ───── Step 6: Update index.txt ─────
function updateIndex(seriesTitle, posterUrl, filename, { upsert = false } = {}) {
  if (!fs.existsSync(INDEX_PATH)) { console.warn("⚠️  ไม่พบ index.txt ข้าม..."); return; }

  let index;
  try { index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")); }
  catch { console.warn("⚠️  index.txt parse ไม่ได้ ข้าม..."); return; }

  const fileUrl  = `${GITHUB_RAW_BASE}${filename}`;
  const existing = index.groups.find((g) => g.url === fileUrl);

  if (existing) {
    if (!upsert) { console.log(`ℹ️  มีอยู่ใน index.txt แล้ว (${existing.name}) ข้าม...`); return; }
    const changed = existing.name !== seriesTitle || existing.image !== posterUrl;
    if (!changed) { console.log(`ℹ️  index.txt ไม่มีการเปลี่ยนแปลง ข้าม...`); return; }
    existing.name  = seriesTitle;
    existing.image = posterUrl;
  } else {
    const dupByName = index.groups.find((g) => g.name === seriesTitle);
    if (dupByName) console.warn(`⚠️  ชื่อ "${seriesTitle}" ซ้ำกับรายการที่มีอยู่ (${dupByName.url})`);
    index.groups.push({ url: fileUrl, name: seriesTitle, image: posterUrl });
  }

  index.groups.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
  const action = existing ? "อัปเดต" : "เพิ่ม";
  console.log(`✅ ${action} index.txt แล้ว (เรียงตามชื่อ A–Z)`);
}

// ───── Helper: resolve playlist file ─────
function resolvePlaylistFile(fname) {
  if (fs.existsSync(path.resolve(PLAYLIST_DIR, fname))) return fname;
  const files = fs.readdirSync(PLAYLIST_DIR);
  const match = files.find((f) => f === fname || f.endsWith(`-${fname}`));
  return match || fname;
}

// ───── Update meta only ─────
async function runUpdateMeta() {
  if (!tmdbKey)      { console.error("❌ ต้องมี TMDB_API_KEY ใน .env"); process.exit(1); }
  if (!customOutput) { console.error("❌ ต้องระบุ --output=FILENAME.txt"); process.exit(1); }

  const outputFile    = customOutput.endsWith(".txt") ? customOutput : `${customOutput}.txt`;
  const resolvedOutput = resolvePlaylistFile(outputFile);
  if (resolvedOutput !== outputFile) console.log(`📂 พบไฟล์: ${resolvedOutput}`);
  const outputPath = path.resolve(PLAYLIST_DIR, resolvedOutput);
  if (!fs.existsSync(outputPath)) { console.error(`❌ ไม่พบไฟล์: ${outputPath}`); process.exit(1); }

  const doPoster = updateMetaMode === "all" || updateMetaMode === "poster";
  const doCover  = updateMetaMode === "all" || updateMetaMode === "cover";
  const doTitle  = updateMetaMode === "all" || updateMetaMode === "title";

  console.log(`\n🔧 mode: ${updateMetaMode} (poster=${doPoster} cover=${doCover} title=${doTitle})`);

  const playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
  const rawTitle = playlist.name || "";
  const isMovieStructure = Array.isArray(playlist.stations);

  let tmdbResult;
  if (isMovieStructure) {
    // ── Movie update-meta ──────────────────────────────────────
    if (forceTmdbId) {
      console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
      tmdbResult = await getTmdbMovieDetail(forceTmdbId, tmdbKey, "en-US");
      if (!tmdbResult) { console.error(`❌ ไม่พบ TMDB ID: ${forceTmdbId}`); process.exit(1); }
    } else {
      console.log(`\n🎬 กำลัง search TMDB (movie) สำหรับ: "${rawTitle}"`);
      tmdbResult = await searchTmdbMovie(rawTitle, tmdbKey);
      if (!tmdbResult) { console.error("❌ ไม่พบใน TMDB"); process.exit(1); }
    }
    const tmdbPoster = `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`;
    const tmdbEnName = tmdbResult.title || rawTitle;
    const tmdbThName = await getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
    const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
    console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);
    if (doPoster) {
      // Part file: update image only, keep name as "ภาค N"
      playlist.image = tmdbPoster;
      (playlist.stations || []).forEach(s => { s.image = tmdbPoster; });
    }

    // Sync back to main file group entry
    const mainSlug   = resolvedOutput.replace(/^\d+-/, "");
    const mainPath   = path.resolve(PLAYLIST_DIR, mainSlug);
    if (fs.existsSync(mainPath)) {
      try {
        const main = JSON.parse(fs.readFileSync(mainPath, "utf-8"));
        const partRawUrl = `${GITHUB_RAW_BASE}${resolvedOutput}`;
        const grp = (main.groups || []).find(g => g.url === partRawUrl);
        if (grp) {
          if (doPoster) { grp.name = tmdbName; grp.image = tmdbPoster; }
          fs.writeFileSync(mainPath, JSON.stringify(main, null, 4), "utf-8");
          console.log(`✅ อัปเดต main file group: ${mainSlug}`);
        }
      } catch { /* ignore if main file missing/corrupt */ }
    }
    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
    console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);
    updateIndex(tmdbName, tmdbPoster, resolvedOutput, { upsert: true });
    console.log("🎉 เสร็จสิ้น!");
    return;
  }

  // ── Series update-meta ──────────────────────────────────────
  if (forceTmdbId) {
    console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
    tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
    if (!tmdbResult) { console.error(`❌ ไม่พบ TMDB ID: ${forceTmdbId}`); process.exit(1); }
  } else {
    console.log(`\n🎬 กำลัง search TMDB สำหรับ: "${rawTitle}"`);
    tmdbResult = await searchTmdb(rawTitle, tmdbKey);
    if (!tmdbResult) { console.error("❌ ไม่พบใน TMDB"); process.exit(1); }
  }

  const tmdbPoster = `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`;
  const tmdbEnName = tmdbResult.name || rawTitle;
  const tmdbThName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
  const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
  console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);

  const allSeasons     = playlist.groups || [];
  const seasonsToUpdate = seasonName
    ? allSeasons.filter((s) => s.name === seasonName)
    : allSeasons;

  if (seasonName && seasonsToUpdate.length === 0) { console.error(`❌ ไม่พบ "${seasonName}" ในไฟล์`); process.exit(1); }

  console.log(`\n📂 จะอัปเดต: ${seasonsToUpdate.map((s) => s.name).join(", ")}${filterTrack ? ` › ${filterTrack}` : " (ทุก track)"}`);

  if (doPoster && !seasonName) { playlist.name = tmdbName; playlist.image = tmdbPoster; }

  for (const season of seasonsToUpdate) {
    const sNum = parseInt(season.name?.match(/\d+/)?.[0]) || 1;
    let enEps = [], thEps = [], seasonPoster = tmdbPoster;

    if (doPoster || doCover || doTitle) {
      const tmdbSeason = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
      enEps = tmdbSeason.enEpisodes;
      thEps = tmdbSeason.thEpisodes;
      if (tmdbSeason.poster) seasonPoster = tmdbSeason.poster;
      console.log(`\n✅ Season ${sNum}: ${enEps.length} ตอน`);
    }

    if (doPoster) season.image = seasonPoster;

    const tracks = season.groups?.length ? season.groups : [season];
    for (const track of tracks) {
      if (!Array.isArray(track.stations)) continue;
      if (filterTrack && track.name !== filterTrack) continue;
      if (doPoster) track.image = seasonPoster;

      const dubbed   = track.name === "พากย์ไทย" || !track.name;
      const tmdbEps  = dubbed ? thEps : enEps;

      track.stations.forEach((station, i) => {
        const tmdbEp = tmdbEps[i];
        if (doTitle && tmdbEp?.name) station.name  = buildStationName(i + 1, tmdbEp.name, dubbed);
        if (doCover && tmdbEp?.still_path) station.image = `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`;
      });

      const updated = [doPoster && "poster", doTitle && "title", doCover && "cover"].filter(Boolean).join("+");
      console.log(`  ✅ [${updated}] "${track.name || "stations"}" (${track.stations.length} ตอน)`);
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
  console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);
  updateIndex(tmdbName, tmdbPoster, resolvedOutput, { upsert: true });
  console.log("🎉 เสร็จสิ้น!");
}

// ───── Main ─────
async function main() {
  if (updateMeta) { await runUpdateMeta(); return; }

  try {
    const { title: rawTitle, posterImg: rawPoster, episodes, version: inertiaVersion } = await parseAnimePage(seriesUrl);

    if (episodes.length === 0) {
      console.error("❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง");
      process.exit(1);
    }

    // TMDB lookup
    let seriesTitle    = rawTitle;
    let posterUrl      = rawPoster;
    let seasonPosterUrl = rawPoster;
    let tmdbEpisodes   = [];
    let tmdbShow       = null;

    if (tmdbKey) {
      let tmdbResult;
      if (isMovie) {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await getTmdbMovieDetail(forceTmdbId, tmdbKey, "en-US");
        } else {
          console.log("\n🎬 กำลัง search TMDB (movie)...");
          tmdbResult = await searchTmdbMovie(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.title || rawTitle;
          const tmdbThName = await getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow    = tmdbResult;
          seriesTitle = tmdbName;
          posterUrl   = tmdbPoster;
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก kurokamii แทน");
        }
      } else {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
        } else {
          console.log("\n🎬 กำลัง search TMDB...");
          tmdbResult = await searchTmdb(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || rawTitle;
          const tmdbThName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);

          tmdbShow        = tmdbResult;
          seriesTitle     = tmdbName;
          posterUrl       = tmdbPoster;
          seasonPosterUrl = tmdbPoster;

          if (isDubbedTrack) {
            const biData = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, seasonNum || 1);
            tmdbEpisodes    = biData.thEpisodes;
            if (biData.poster) seasonPosterUrl = biData.poster;
          } else {
            const seasonData = await getTmdbSeason(tmdbResult.id, tmdbKey, seasonNum || 1, "en-US");
            tmdbEpisodes    = seasonData.episodes;
            if (seasonData.poster) seasonPosterUrl = seasonData.poster;
          }
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน จาก TMDB`);
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก kurokamii แทน");
        }
      }
    }

    // Fetch UUID + build stream URL สำหรับทุก episode
    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep    = episodes[i];
      const epNum = i + 1;
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      let streamUrl = null;
      try {
        const uuid = await getEpisodeUuid(ep.url, inertiaVersion);
        streamUrl  = buildStreamUrl(uuid);
        process.stdout.write(` UUID: ${uuid}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const tmdbEp     = tmdbEpisodes[i];
      const epTitle    = tmdbEp?.name || "";
      const epThumb    = tmdbEp?.still_path
        ? `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`
        : "";
      const stationName = buildStationName(epNum, epTitle, isDubbedTrack);

      stations.push({
        name:    stationName,
        ...(epThumb && { image: epThumb }),
        url:     streamUrl || ep.url,
        referer: PLAYER_REFERER,
      });

      console.log(` ✅`);
      if (i < episodes.length - 1) await sleep(800);
    }

    // Build / merge playlist
    const slug         = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim());
    const slugFile     = slug.endsWith(".txt") ? slug : `${slug}.txt`;
    const resolvedId   = idPrefixArg || String(tmdbShow?.id || "");
    const outputFile   = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath   = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error("❌ ไม่พบ stream URL"); process.exit(1); }

      const partSeason   = seasonNum || 1;
      // Part file: {tmdbId}-{slug}.txt
      const partPlaylist = buildPartFile(outputPath, partSeason, posterUrl, trackName, s.url, s.referer);
      fs.writeFileSync(outputPath, JSON.stringify(partPlaylist, null, 4), "utf-8");
      console.log(`\n📁 บันทึก part file: ${outputPath}`);

      // Main file: {slug}.txt (no tmdbId prefix)
      const mainFile    = slugFile;
      const mainPath    = path.resolve(PLAYLIST_DIR, mainFile);
      const partRawUrl  = `${GITHUB_RAW_BASE}${outputFile}`;
      const mainPlaylist = upsertMainFile(mainPath, seriesTitle, posterUrl, seriesTitle, posterUrl, partRawUrl, partSeason);
      fs.writeFileSync(mainPath, JSON.stringify(mainPlaylist, null, 4), "utf-8");
      console.log(`📁 บันทึก main file: ${mainPath}`);

      updateIndex(seriesTitle, posterUrl, mainFile);
    } else {
      const playlist = buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName);
      fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
      console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
      updateIndex(seriesTitle, posterUrl, outputFile);
    }

    console.log("\n🎉 เสร็จสิ้น!");
    console.log(`   ไฟล์: ${TYPE_CONFIG[contentType].base}${outputFile}`);
    console.log(`   ${isMovie ? 'ประเภท: Movie' : `จำนวนตอน: ${stations.length}`}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
