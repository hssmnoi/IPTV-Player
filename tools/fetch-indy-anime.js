#!/usr/bin/env node
/**
 * fetch-indy-anime.js
 * สร้าง / อัปเดต playlist JSON จาก indy-anime.net พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้ารายการบน indy-anime.net (จำเป็น ยกเว้นใช้ --update-meta)
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: subth)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *                     ใช้กับ --update-meta เพื่ออัปเดตเฉพาะ season ที่ระบุ
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY    TMDB API key (ถ้าไม่ใส่จะอ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ (ใช้เมื่อ search ได้ผลผิด)
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *                     ไม่ระบุ = อัปเดตทั้งหมด
 *                     poster  = เฉพาะรูปปกซีรีส์/ซีซัน/แทร็ก
 *                     cover   = เฉพาะรูป thumbnail ของแต่ละตอน
 *                     title   = เฉพาะชื่อตอน
 *                     ต้องใช้คู่กับ --output เสมอ
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *
 *   # Fetch ซับไทย (สร้างไฟล์ใหม่)
 *   node fetch-indy-anime.js https://indy-anime.net/SLUG/ --track=subth --output=FILENAME.txt
 *
 *   # Merge พากย์ไทยเข้าไฟล์เดิม
 *   node fetch-indy-anime.js https://indy-anime.net/SLUG-th/ --track=th --output=FILENAME.txt
 *
 *   # Fetch season 2
 *   node fetch-indy-anime.js https://indy-anime.net/SLUG-season-2/ --track=subth --season=2 --output=FILENAME.txt
 *
 *   # อัปเดต metadata จาก TMDB
 *   node fetch-indy-anime.js --update-meta --output=FILENAME.txt
 *
 *   # ระบุ TMDB ID ตรงๆ กรณี search ผิด
 *   node fetch-indy-anime.js --update-meta --tmdb-id=82684 --output=FILENAME.txt
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - Stream URL รูปแบบ: https://hls.animeindy.com:8443/vid/{HASH}/video.mp4/playlist.m3u8
 *   - ไม่ต้องใช้ proxy (CDN รองรับ CORS)
 *   - TMDB_API_KEY อ่านจาก tools/.env หรือ .env อัตโนมัติ
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

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
const args = process.argv.slice(2);
const seriesUrl = args.find((a) => a.startsWith("http"));
const tmdbKey = (args.find((a) => a.startsWith("--tmdb-key=")) || "").replace("--tmdb-key=", "") || process.env.TMDB_API_KEY || "";
const customOutput = (args.find((a) => a.startsWith("--output=")) || "").replace("--output=", "");

const trackArg = (args.find((a) => a.startsWith("--track=")) || "").replace("--track=", "");
const TRACK_MAP = { th: "พากย์ไทย", subth: "ซับไทย" };
const trackName = TRACK_MAP[trackArg] || trackArg || "ซับไทย";
const isDubbedTrack = trackName === "พากย์ไทย";
const filterTrack = trackArg ? trackName : null;

const seasonArg = args.find((a) => a.startsWith("--season="));
const seasonNum = seasonArg ? (parseInt(seasonArg.replace("--season=", "")) || 1) : null;
const seasonName = seasonNum ? `Season ${seasonNum}` : null;

const updateMetaArg = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta = !!updateMetaArg;
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "all";

const tmdbIdArg = args.find((a) => a.startsWith("--tmdb-id="));
const forceTmdbId = tmdbIdArg ? parseInt(tmdbIdArg.replace("--tmdb-id=", "")) || null : null;

if (!seriesUrl && !updateMeta) {
  console.error("Usage: node fetch-indy-anime.js <url> [--track=th|subth] [--season=N] [--output=FILE]");
  console.error("       node fetch-indy-anime.js --update-meta[=poster|cover|title] [--season=N] [--track=th|subth] --output=FILE.txt");
  process.exit(1);
}

// ───── Config ─────
const PLAYLIST_DIR = path.resolve(__dirname, "../playlist/anime/Series");
const INDEX_PATH = path.resolve(PLAYLIST_DIR, "index.txt");
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/playlist/anime/series/";
const REFERER = "https://indy-anime.net/";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer": REFERER,
};

// ───── Helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
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

// ───── Step 1: Parse series page ─────
async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch หน้ารายการ: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Title
  const title = $("h1").first().text().trim()
    || $(".entry-title").first().text().trim()
    || $("title").text().replace(/\s*[-|].*$/, "").trim();

  // Poster image
  const posterImg = $(".poster img, .thumb img, .series-thumbnail img").attr("src")
    || $("article img").first().attr("src")
    || "";

  // Episode links — collect all /watch/ links
  const seen = new Set();
  const episodes = [];

  $("a[href*='/watch/']").each((_, el) => {
    const epUrl = $(el).attr("href");
    if (!epUrl || seen.has(epUrl)) return;
    seen.add(epUrl);

    const thumb = $(el).find("img").attr("src") || "";
    const epTitle = $(el).text().trim();
    episodes.push({ url: epUrl, thumb, epTitle });
  });

  // Sort by episode number extracted from URL
  episodes.sort((a, b) => {
    const numA = parseInt((a.url.match(/episode[-–](\d+)/i) || [])[1] || 0);
    const numB = parseInt((b.url.match(/episode[-–](\d+)/i) || [])[1] || 0);
    return numA - numB;
  });

  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน`);
  return { title, posterImg, episodes };
}

// ───── Step 2: Get stream URL from episode page ─────
async function getStreamUrl(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const $ = cheerio.load(html);

  // Method 1: iframe src from team-indy.net
  const iframeSrc = $("iframe[src*='team-indy.net/embed'], iframe[src*='indy-anime.net/embed']").attr("src") || "";
  const hashFromIframe = (iframeSrc.match(/\/embed\/([a-zA-Z0-9]+)\//i) || [])[1];
  if (hashFromIframe) {
    return buildStreamUrl(hashFromIframe);
  }

  // Method 2: inline JS containing the hash
  const scriptContent = $("script:not([src])").map((_, el) => $(el).html()).get().join("\n");
  const hashFromScript = (scriptContent.match(/\/vid\/([a-zA-Z0-9]+)\/video\.mp4/i) || [])[1]
    || (scriptContent.match(/embed\/([a-zA-Z0-9]+)\//i) || [])[1];
  if (hashFromScript) {
    return buildStreamUrl(hashFromScript);
  }

  // Method 3: direct m3u8 URL already in page
  const directMatch = html.match(/https?:\/\/hls\.animeindy\.com[^"'\s]+playlist\.m3u8/i);
  if (directMatch) return directMatch[0];

  throw new Error(`ไม่พบ stream hash ใน ${epPageUrl}`);
}

function buildStreamUrl(hash) {
  return `https://hls.animeindy.com:8443/vid/${hash}/video.mp4/playlist.m3u8`;
}

// ───── Step 3: TMDB metadata ─────
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
  const url = `https://api.themoviedb.org/3/search/tv?query=${query}&language=en-US&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
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
  const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${season}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return { episodes: [], poster: null };
  const data = await res.json();
  return {
    episodes: data.episodes || [],
    poster: data.poster_path ? `https://image.tmdb.org/t/p/original${data.poster_path}` : null,
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
  return {
    enEpisodes: enData.episodes,
    thEpisodes: thEps,
    poster: enData.poster,
  };
}

async function getTmdbEpisodes(tvId, apiKey, season = 1, language = "en-US") {
  return (await getTmdbSeason(tvId, apiKey, season, language)).episodes;
}

// ───── Step 4: Build / merge playlist JSON ─────
function buildStationName(epNum, epTitle, isDubbedTrack) {
  if (!epTitle) return isDubbedTrack ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbedTrack ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

// posterUrl      = show-level poster (playlist.image, index)
// seasonPosterUrl = season-specific poster (season.image, track.image)
function buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName) {
  const newTrack = { name: trackName, image: seasonPosterUrl, stations };

  if (fs.existsSync(outputPath)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    } catch {
      console.warn("⚠️  ไฟล์เดิม parse ไม่ได้ สร้างใหม่แทน");
      existing = null;
    }

    if (existing) {
      const targetName = seasonName || "Season 1";
      let season = existing.groups?.find((g) => g.name === targetName)
        ?? (seasonNum ? null : existing.groups?.[0]);

      if (!season) {
        existing.groups = existing.groups || [];
        season = { name: targetName, image: seasonPosterUrl, groups: [] };
        existing.groups.push(season);
      }

      // Convert old single-track structure to multi-track
      if (season.stations && !season.groups) {
        const existingTrackName = trackName === "พากย์ไทย" ? "ซับไทย" : "พากย์ไทย";
        season.groups = [{ name: existingTrackName, image: season.image || posterUrl, stations: season.stations }];
        delete season.stations;
      }

      season.groups = season.groups || [];
      season.groups = season.groups.filter((g) => g.name !== trackName);
      season.groups.push(newTrack);

      // พากย์ไทย always first
      season.groups.sort((a, b) => {
        if (a.name === "พากย์ไทย") return -1;
        if (b.name === "พากย์ไทย") return 1;
        return 0;
      });

      console.log(`\n🔀 Merge "${trackName}" เข้าไฟล์เดิม (${season.groups.length} tracks)`);
      return existing;
    }
  }

  // New file
  const newSeasonName = seasonName || "Season 1";
  return {
    name: seriesTitle,
    image: posterUrl,
    groups: [{ name: newSeasonName, image: seasonPosterUrl, groups: [newTrack] }],
  };
}

// ───── Step 5: Update index.txt ─────
function updateIndex(seriesTitle, posterUrl, filename, { upsert = false } = {}) {
  if (!fs.existsSync(INDEX_PATH)) {
    console.warn("⚠️  ไม่พบ index.txt ข้าม...");
    return;
  }

  let index;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    console.warn("⚠️  index.txt parse ไม่ได้ ข้าม...");
    return;
  }

  const fileUrl = `${GITHUB_RAW_BASE}${filename}`;
  const existing = index.groups.find((g) => g.url === fileUrl);

  if (existing) {
    if (!upsert) {
      console.log(`ℹ️  มีอยู่ใน index.txt แล้ว (${existing.name}) ข้าม...`);
      return;
    }
    const changed = existing.name !== seriesTitle || existing.image !== posterUrl;
    if (!changed) {
      console.log(`ℹ️  index.txt ไม่มีการเปลี่ยนแปลง ข้าม...`);
      return;
    }
    existing.name = seriesTitle;
    existing.image = posterUrl;
  } else {
    const dupByName = index.groups.find((g) => g.name === seriesTitle);
    if (dupByName) {
      console.warn(`⚠️  ชื่อ "${seriesTitle}" ซ้ำกับรายการที่มีอยู่ (${dupByName.url})`);
    }
    index.groups.push({ url: fileUrl, name: seriesTitle, image: posterUrl });
  }

  index.groups.sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
  );

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
  const action = existing ? "อัปเดต" : "เพิ่ม";
  console.log(`✅ ${action} index.txt แล้ว (เรียงตามชื่อ A–Z)`);
}

// ───── Update meta only ─────
async function runUpdateMeta() {
  if (!tmdbKey) { console.error("❌ ต้องมี TMDB_API_KEY ใน .env"); process.exit(1); }
  if (!customOutput) { console.error("❌ ต้องระบุ --output=FILENAME.txt"); process.exit(1); }

  const outputFile = customOutput.endsWith(".txt") ? customOutput : `${customOutput}.txt`;
  const outputPath = path.resolve(PLAYLIST_DIR, outputFile);
  if (!fs.existsSync(outputPath)) { console.error(`❌ ไม่พบไฟล์: ${outputPath}`); process.exit(1); }

  const doPoster = updateMetaMode === "all" || updateMetaMode === "poster";
  const doCover  = updateMetaMode === "all" || updateMetaMode === "cover";
  const doTitle  = updateMetaMode === "all" || updateMetaMode === "title";

  console.log(`\n🔧 mode: ${updateMetaMode} (poster=${doPoster} cover=${doCover} title=${doTitle})`);

  const playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
  const rawTitle = playlist.name || "";

  let tmdbResult;
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
  const tmdbName = formatSeriesTitle(tmdbEnName, tmdbThName);
  console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);

  const allSeasons = playlist.groups || [];
  const seasonsToUpdate = seasonName
    ? allSeasons.filter((s) => s.name === seasonName)
    : allSeasons;

  if (seasonName && seasonsToUpdate.length === 0) {
    console.error(`❌ ไม่พบ "${seasonName}" ในไฟล์`);
    process.exit(1);
  }

  console.log(`\n📂 จะอัปเดต: ${seasonsToUpdate.map((s) => s.name).join(", ")}${filterTrack ? ` › ${filterTrack}` : " (ทุก track)"}`);

  if (doPoster && !seasonName) {
    playlist.name = tmdbName;
    playlist.image = tmdbPoster;
  }

  for (const season of seasonsToUpdate) {
    const sNum = parseInt(season.name?.match(/\d+/)?.[0]) || 1;

    let enEps = [];
    let thEps = [];
    let seasonPoster = tmdbPoster;
    if (doPoster || doCover || doTitle) {
      const tmdbSeason = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
      enEps = tmdbSeason.enEpisodes;
      thEps = tmdbSeason.thEpisodes;
      if (tmdbSeason.poster) seasonPoster = tmdbSeason.poster;
      console.log(`\n✅ Season ${sNum}: ${enEps.length} ตอน | poster: ${seasonPoster !== tmdbPoster ? "season-specific" : "show-level"}`);
    }

    if (doPoster) season.image = seasonPoster;

    const tracks = season.groups?.length ? season.groups : [season];
    for (const track of tracks) {
      if (!Array.isArray(track.stations)) continue;
      if (filterTrack && track.name !== filterTrack) continue;
      if (doPoster) track.image = seasonPoster;

      const dubbed = track.name === "พากย์ไทย" || !track.name;
      const tmdbEps = dubbed ? thEps : enEps;

      track.stations.forEach((station, i) => {
        const tmdbEp = tmdbEps[i];
        if (doTitle && tmdbEp?.name) {
          station.name = buildStationName(i + 1, tmdbEp.name, dubbed);
        }
        if (doCover && tmdbEp?.still_path) {
          station.image = `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`;
        }
      });

      const updated = [doPoster && "poster", doTitle && "title", doCover && "cover"].filter(Boolean).join("+");
      console.log(`  ✅ [${updated}] "${track.name || "stations"}" (${track.stations.length} ตอน)`);
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
  console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);

  updateIndex(tmdbName, tmdbPoster, outputFile, { upsert: true });

  console.log("🎉 เสร็จสิ้น!");
}

// ───── Main ─────
async function main() {
  if (updateMeta) { await runUpdateMeta(); return; }

  try {
    const { title: rawTitle, posterImg: rawPoster, episodes } = await parseSeriesPage(seriesUrl);

    if (episodes.length === 0) {
      console.error("❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง");
      process.exit(1);
    }

    // TMDB lookup
    let seriesTitle = rawTitle;
    let posterUrl = rawPoster;
    let seasonPosterUrl = rawPoster; // season-specific poster (season.image, track.image)
    let tmdbEpisodes = [];

    if (tmdbKey) {
      let tmdbResult;
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
        const tmdbName = formatSeriesTitle(tmdbEnName, tmdbThName);
        const tmdbPoster = tmdbResult.poster_path
          ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
          : rawPoster;
        console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
        seriesTitle = tmdbName;
        posterUrl = tmdbPoster;
        seasonPosterUrl = tmdbPoster; // default to show-level, override below if season poster exists

        if (isDubbedTrack) {
          const biData = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, seasonNum || 1);
          tmdbEpisodes = biData.thEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${seasonNum || 1}, th-TH w/ EN fallback) จาก TMDB`);
        } else {
          const seasonData = await getTmdbSeason(tmdbResult.id, tmdbKey, seasonNum || 1, "en-US");
          tmdbEpisodes = seasonData.episodes;
          if (seasonData.poster) seasonPosterUrl = seasonData.poster;
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${seasonNum || 1}, en-US) จาก TMDB`);
        }
        console.log(`✅ poster: show-level=${posterUrl !== rawPoster} season-specific=${seasonPosterUrl !== posterUrl}`);
      } else {
        console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก indy-anime แทน");
      }
    }

    // Fetch stream URL for each episode
    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = i + 1;
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      let streamUrl = null;
      try {
        streamUrl = await getStreamUrl(ep.url);
        process.stdout.write(`  URL: ${streamUrl}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const tmdbEp = tmdbEpisodes[i];
      const epTitle = tmdbEp?.name || "";
      const epThumb = tmdbEp?.still_path
        ? `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`
        : ep.thumb || "";

      const stationName = buildStationName(epNum, epTitle, isDubbedTrack);

      stations.push({
        name: stationName,
        ...(epThumb && { image: epThumb }),
        url: streamUrl || ep.url,
        referer: REFERER,
      });

      console.log(` ✅`);
      if (i < episodes.length - 1) await sleep(600);
    }

    // Build / merge playlist
    const slug = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim());
    const outputFile = slug.endsWith(".txt") ? slug : `${slug}.txt`;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    const playlist = buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName);
    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
    console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);

    updateIndex(seriesTitle, posterUrl, outputFile);

    console.log("\n🎉 เสร็จสิ้น!");
    console.log(`   ไฟล์: playlist/anime/series/${outputFile}`);
    console.log(`   จำนวนตอน: ${stations.length}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
