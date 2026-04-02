# IPTV Player — Project Context for Claude

## ภาพรวม

โปรเจคนี้คือ IPTV Player ส่วนตัว ชื่อ **BKL Play**
ดึง stream URL จากเว็บแหล่งต่างๆ มา generate เป็น playlist JSON แล้วเล่นผ่าน player ในเว็บ
มี CMS สำหรับจัดการ playlist และ fetch script สำหรับดึงข้อมูล

---

## Repository

- **GitHub**: `natajrak/IPTV-Player` (branch: `main`)
- **GitHub Raw Base**: `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/`
- **Local dev server**: `http://localhost:4000`

---

## โครงสร้างโฟลเดอร์

```
IPTV-Player/
├── server.js                  # Local dev server (แทน npx serve)
├── serve-web.bat              # เปิด server → node server.js
├── CLAUDE.md                  # ไฟล์นี้
│
├── web/
│   ├── cms/
│   │   └── index.html         # หน้า CMS จัดการ playlist
│   └── images/                # รูป favicon, cover ต่างๆ
│
├── tools/                     # Fetch scripts (Node.js)
│   ├── fetch-fairyanime.js    # ดึงจาก fairyanime.net
│   ├── fetch-indy-anime.js    # ดึงจาก indy-anime.net
│   ├── fetch-kurokamii.js     # ดึงจาก kurokamii.com (ผ่าน CF proxy)
│   ├── fairyanime.bat         # Interactive CLI สำหรับ fairyanime
│   ├── indy-anime.bat         # Interactive CLI สำหรับ indy-anime
│   ├── update-meta-all.bat    # Batch update metadata ทุกไฟล์
│   ├── .env                   # TMDB_API_KEY (ไม่ commit)
│   └── package.json           # dependency: cheerio
│
├── playlist/
│   ├── anime/
│   │   ├── series/
│   │   │   ├── index.txt      # รายชื่อ anime series ทั้งหมด
│   │   │   └── {tmdbId}-{slug}.txt   # ข้อมูล playlist แต่ละเรื่อง
│   │   └── movies/
│   │       ├── index.txt
│   │       └── {tmdbId}-{slug}.txt
│   ├── movies/
│   │   ├── index.txt
│   │   └── {tmdbId}-{slug}.txt
│   └── series/
│       ├── index.txt
│       └── {tmdbId}-{slug}.txt
│
├── cloudflare/
    └── worker-proxy.js        # Source code Cloudflare Worker proxy
```

---

## Playlist Format (JSON)

### ความแตกต่างของ 4 หมวด

| หมวด | โฟลเดอร์ | Structure |
|------|----------|-----------|
| Anime Series | `playlist/anime/series/` | Series (seasons → tracks → episodes) |
| Anime Movies | `playlist/anime/movies/` | Movie (parts/ภาค → tracks) |
| Movies | `playlist/movies/` | Movie (parts/ภาค → tracks) |
| Series | `playlist/series/` | Series (seasons → tracks → episodes) |

> **หลักการ**: Anime/non-Anime คือแค่ **categorization** ไม่ใช่ structural difference
> Structure ขึ้นอยู่กับว่าเป็น **Movie** หรือ **Series** เท่านั้น

---

### index.txt — รายชื่อทั้งหมด (ทุกหมวด)
```json
{
  "name": "The Series",
  "image": "https://.../cover.png",
  "groups": [
    {
      "url": "https://raw.githubusercontent.com/.../playlist/anime/series/12345-slug.txt",
      "name": "Title EN [ชื่อไทย]",
      "image": "https://image.tmdb.org/t/p/original/xxx.jpg"
    }
  ]
}
```

---

### Structure: Series (Anime Series + Series)
seasons → tracks → episodes (3 ชั้น)
```json
{
  "name": "Title EN [ชื่อไทย]",
  "image": "https://image.tmdb.org/t/p/original/poster.jpg",
  "groups": [
    {
      "name": "Season 1",
      "image": "https://image.tmdb.org/t/p/original/season-poster.jpg",
      "groups": [
        {
          "name": "พากย์ไทย",
          "image": "https://image.tmdb.org/t/p/original/season-poster.jpg",
          "stations": [
            {
              "name": "ตอน 1 - Episode Title",
              "image": "https://image.tmdb.org/t/p/original/still.jpg",
              "url": "https://stream-url...",
              "referer": "https://source-site.com/"
            }
          ]
        },
        {
          "name": "ซับไทย",
          "image": "...",
          "stations": [ ... ]
        }
      ]
    }
  ]
}
```

---

### Structure: Movie (Anime Movies + Movies)
parts (ภาค) → tracks (2 ชั้น) — รองรับหลายภาคต่อในไฟล์เดียว
```json
{
  "name": "Title EN [ชื่อไทย]",
  "image": "https://image.tmdb.org/t/p/original/poster.jpg",
  "groups": [
    {
      "name": "ภาค 1",
      "image": "https://image.tmdb.org/t/p/original/poster.jpg",
      "stations": [
        {
          "name": "พากย์ไทย",
          "image": "https://image.tmdb.org/t/p/original/poster.jpg",
          "url": "https://stream-url...",
          "referer": "https://source-site.com/"
        },
        {
          "name": "ซับไทย",
          "image": "...",
          "url": "https://stream-url..."
        }
      ]
    },
    {
      "name": "ภาค 2",
      "image": "https://image.tmdb.org/t/p/original/poster2.jpg",
      "stations": [
        {
          "name": "พากย์ไทย",
          "url": "https://stream-url..."
        }
      ]
    }
  ]
}
```

> **Backward compat**: ไฟล์เดิมที่มี `stations` at root จะถูก auto-migrate เป็น `groups[0]` อัตโนมัติเมื่อรัน script ครั้งถัดไป

---

### กฎการตั้งชื่อ
- **ชื่อเรื่อง**: `ชื่ออังกฤษ [ชื่อไทย]` เสมอ (ใช้ `splitTitle()` ใน CMS แยกแสดง 2 บรรทัด)
- **ชื่อไฟล์**: `{tmdbId}-{slug}.txt` เช่น `42942-angel-beats.txt`
- **Tracks**: พากย์ไทย อยู่ก่อน ซับไทย เสมอ

---

## Fetch Scripts

### Args ที่ใช้ร่วมกันทุก script
```
<url>                    URL หน้าแหล่งข้อมูล
--track=th|subth         th = พากย์ไทย, subth = ซับไทย
--season=N               ระบุ season (default: 1)
--output=FILENAME.txt    ชื่อไฟล์ผลลัพธ์
--tmdb-id=N              ระบุ TMDB ID ตรงๆ
--update-meta[=poster|cover|title]   อัปเดต metadata อย่างเดียว
```

### fetch-fairyanime.js
- **แหล่ง**: fairyanime.net
- **Stream**: CDN ไม่ติด CORS ใช้ตรงได้

### fetch-indy-anime.js
- **แหล่ง**: indy-anime.net
- **Stream**: `https://hls.animeindy.com:8443/vid/{hash}/video.mp4/playlist.m3u8`
- **PLAYLIST_DIR**: `playlist/anime/series`
- **ใช้สำหรับ update-meta** ของทุก series (ใช้ script เดียวกัน ไม่มีโค้ด source-specific ใน update-meta path)

### fetch-kurokamii.js
- **แหล่ง**: kurokamii.com
- **Input URL**: หน้า anime เช่น `https://kurokamii.com/anime/6423`
- **วิธีดึง stream**:
  1. Fetch หน้า episode → หา iframe `akuma-player.xyz/play/{uuid}`
  2. UUID → `https://files.akuma-player.xyz/view/{uuid}`
  3. ต้องผ่าน CF Worker (CORS block): `https://shy-haze-2452.natajrak-p.workers.dev/?url={encoded}&referer={encoded}`
- **Default track**: `th` (พากย์ไทย) — ต่างจาก script อื่นที่ default เป็น subth
- **PLAYLIST_DIR**: `playlist/anime/series`

---

## Cloudflare Worker Proxy

- **Worker name**: `shy-haze-2452`
- **Live URL**: `https://shy-haze-2452.natajrak-p.workers.dev/`
- **Source**: `cloudflare/worker-proxy.js`
- **Params**: `?url={encoded_url}&referer={encoded_referer}`
- **ทำงาน**: Fetch server-side ที่ CF edge → bypass CORS → rewrite URL ใน m3u8 ทุก layer
- **รองรับ URL types**: absolute (`https://`), protocol-relative (`//`), relative path (`/`)

### ตัวอย่างการใช้ (kurokamii)
```
https://shy-haze-2452.natajrak-p.workers.dev/?url=https%3A%2F%2Ffiles.akuma-player.xyz%2Fview%2F{uuid}&referer=https%3A%2F%2Fakuma-player.xyz%2F
```

### akuma-player stream structure
- **Entry**: `https://files.akuma-player.xyz/view/{uuid}` → master m3u8
- **Playlist**: `https://files.akuma-player.xyz/files/{hash}_.txt` → media playlist
- **Segments**: `https://akuma-player-{date}.space/{hash}/{hash}_NNN.html` (ปลอมเป็น .html จริงๆ คือ .ts)

---

## server.js (Local Dev Server)

แทน `npx serve` ใช้ Node built-ins เท่านั้น

### Endpoints
| Method | Path | หน้าที่ |
|--------|------|---------|
| GET | `/` | redirect → `/web/` |
| GET | `/web/`, static files | serve ไฟล์ปกติ |
| POST | `/api/run-fetch` | รัน fetch script → SSE stream output |
| GET | `/api/playlist-files?tab=` | list ไฟล์ใน playlist dir + ชื่อจาก index.txt |

### ALLOWED_SCRIPTS (whitelist)
```js
'fetch-fairyanime.js'
'fetch-indy-anime.js'
'fetch-kurokamii.js'
```

### PLAYLIST_DIRS
```js
'anime-series' → 'playlist/anime/series'
'anime-movie'  → 'playlist/anime/movies'
'movie'        → 'playlist/movies'
'series'       → 'playlist/series'
```

### SSE format (run-fetch)
```
data: {"t":"out","v":"..."}    // stdout
data: {"t":"err","v":"..."}    // stderr
data: {"t":"done","code":0}    // exit code
```

---

## CMS (web/cms/index.html)

### Tabs
| Tab | แหล่ง index.txt | kind |
|-----|-----------------|------|
| Anime Series | `playlist/anime/series/index.txt` | series |
| Anime Movie | `playlist/anime/movies/index.txt` | movie |
| Movie | `playlist/movies/index.txt` | movie |
| Series | `playlist/series/index.txt` | series |

### Data source
- **localhost / 127.0.0.1** → โหลดจาก local (`/playlist/...`)
- **อื่นๆ** → โหลดจาก GitHub Raw URL
- Header แสดง icon: `fi-ss-folder-tree` (local) / `fi-sr-cloud-code` (GitHub)

### Features
- **ค้นหา** instant search ทุก tab
- **Title** แสดง 2 บรรทัด EN + TH (splitTitle แยก `[...]`)
- **Copy buttons** hover-reveal ทุก field
- **Per-row Update button** (hover บน Season cell) → Update Metadata modal
- **Batch Update** → อัปเดตทุกไฟล์ใน tab ต่อเนื่อง
- **Add modal** (local only) → เลือก script, กรอก URL, เลือก track/season/filename → Run

### ADD_SCRIPTS (ใน CMS)
```js
'anime-series': [fairyanime, indy-anime, kurokamii]
'anime-movie':  [fairyanime, indy-anime]
'movie':        []
'series':       []
```

### Update Metadata
- ใช้ `fetch-indy-anime.js` เสมอ (UPDATE_SCRIPT hardcoded)
- ทั้ง 2 script มี `runUpdateMeta()` เหมือนกัน ใช้แทนกันได้

### Datalist Autocomplete (Add modal)
- โหลดจาก `/api/playlist-files?tab=`
- `option.value` = ชื่อเรื่อง (EN + TH) → top line
- `option.label` = `{tmdbId}  {slug}` → hint line
- เมื่อเลือก → แปลงกลับเป็น slug ใส่ช่อง filename + fill TMDB ID อัตโนมัติ

---

## การเพิ่มแหล่งข้อมูลใหม่

เมื่อต้องการเพิ่ม fetch script สำหรับเว็บใหม่ ต้องอัปเดต 3 จุด:

1. **`tools/fetch-{source}.js`** — เขียน script ใหม่
2. **`server.js`** — เพิ่มใน `ALLOWED_SCRIPTS`
3. **`web/cms/index.html`** — เพิ่มใน `ADD_SCRIPTS` ของ tab ที่เกี่ยวข้อง

---

## Environment

### tools/.env
```
TMDB_API_KEY=your_key_here
```

### Dependencies
- **tools/**: `cheerio` (HTML parsing)
- **server.js**: Node built-ins เท่านั้น (http, fs, path, url, child_process)

### เริ่ม dev server
```bat
serve-web.bat   ← double-click หรือรันใน terminal
```
→ เปิด `http://localhost:4000/web/` (Player) และ `http://localhost:4000/web/cms/` (CMS)

---

## TMDB

- **API**: `https://api.themoviedb.org/3/`
- **ชื่อเรื่อง**: ดึง EN (`en-US`) + TH (`th-TH`) รวมเป็น `EN [TH]`
- **Poster**: `https://image.tmdb.org/t/p/original{poster_path}`
- **Episode still**: `https://image.tmdb.org/t/p/original{still_path}`
- **Search**: `/search/tv?query=` (ตัด Thai, special chars ออกก่อน search)

### กฎชื่อตอน (Episode Name Fallback)

ดึงชื่อตอนทั้ง EN และ TH พร้อมกัน แล้วใช้ตาม priority นี้:

1. ถ้าชื่อ TH **มีอยู่และไม่ generic** → ใช้ TH
2. ถ้าชื่อ TH **ว่าง** หรือ **generic** → ใช้ EN แทน

**"Generic"** หมายถึง match pattern ใดใดต่อไปนี้:
- `Episode N` (case-insensitive) — TMDB ใส่ให้อัตโนมัติเมื่อไม่มีชื่อจริง
- `ตอนที่ N`

```js
// isGenericEpisodeName()
/^Episode\s+\d+$/i.test(name)  →  generic
/^ตอนที่\s*\d+$/.test(name)    →  generic
!name                           →  generic (ว่าง)
```

Logic นี้อยู่ใน `getTmdbSeasonBilingual()` ทุก fetch script
