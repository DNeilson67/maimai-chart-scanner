# ChartScan — maimai DX Internal Level Scanner

A small web app that points your camera (or a photo) at a *maimai DX* song/difficulty
screen, reads the title and displayed level with on-device OCR, matches it against
a community chart database, and pops up the chart's **internal level** — the
precise decimal (e.g. `13.4`) hiding behind the plain number you see in the
arcade (e.g. `13`).

It's a single static site — no backend, no build step, no API keys.

## Files

- `index.html` — structure + all styling
- `app.js` — camera/OCR pipeline, fuzzy song matching, rendering

## Running it

Browsers only allow camera access (`getUserMedia`) on a **secure context**:
HTTPS, or `http://localhost`. Opening `index.html` directly via `file://` will
show the camera button but it won't work — **use "Upload photo" instead** in
that case, or serve the folder locally:

```bash
# any of these work — pick one
npx serve .
python3 -m http.server 8080
php -S localhost:8080
```

Then open `http://localhost:PORT` on your phone (same Wi-Fi) or laptop.

To make it usable from your phone's camera anywhere, deploy the folder as-is to
any static host with HTTPS — GitHub Pages, Netlify, Vercel, Cloudflare Pages —
just drag-and-drop the two files, no build config needed.

## How it works

1. **Data**: on load, the app checks a local cache first (`localStorage`, 12h
   TTL) before hitting the live public dataset from
   [`arcade-songs.zetaraku.dev`](https://arcade-songs.zetaraku.dev/maimai/) —
   the same JSON the official site itself uses in the browser
   (`https://dp4p6x0xfi5o9.cloudfront.net/maimai/data.json`). This keeps repeat
   visits from re-downloading the full ~7000-sheet dataset every time; a small
   refresh (↻) button next to the status pill lets you force an update on
   demand. Every song's every difficulty sheet includes both `level` (what the
   cabinet shows, e.g. `"13"`) and `internalLevel` / `internalLevelValue` (the
   community-tracked decimal constant, e.g. `"13.4"`). Cover art is resolved
   client-side from each song's `imageName`, with a two-step fallback
   (full-size → medium → a generated placeholder) so a single broken image
   never leaves a blank box.
2. **Capture**: the live camera grabs a quick burst of frames and automatically
   keeps the sharpest one (via a Laplacian-variance sharpness estimate),
   since handheld motion blur is one of the biggest real-world accuracy
   killers. Uploaded photos go straight to the next step. Scanning starts
   immediately — there's no manual cropping step.
3. **Preprocessing**: the frame is upscaled if small, converted to grayscale,
   and run through a local-contrast pass — a blurred copy of the image
   approximates the local lighting level, which is subtracted out. This
   handles uneven arcade-screen glare and reflections much better than a
   single global contrast stretch, with a plain global-stretch fallback if
   the blur step isn't supported.
4. **OCR**: [Tesseract.js](https://github.com/naptha/tesseract.js) (loaded
   from a CDN, runs fully in-browser) reads English, Japanese, and Chinese
   text. A single OCR worker is created once and reused for the whole
   session — the engine and language data are the slow part to load, so this
   keeps every scan after the first noticeably faster. If a language pack
   fails to download (flaky connection, blocked CDN), it automatically
   retries with a smaller language set rather than failing silently — check
   the "Recognized text (debug)" panel after a scan, which shows exactly
   which languages ended up loaded. Each scan runs *two* passes with
   different page-segmentation assumptions (scattered UI text vs. one clean
   block) and keeps whichever pass the engine itself was more confident about.
5. **Matching**: recognized text lines *and* individual words are fuzzy-matched
   (Sørensen–Dice) against every song's title/artist. The comparison unit
   adapts to the script: character *bigrams* for Latin text (robust to a
   stray OCR misread across a long title), but single *characters* for
   Japanese/Chinese-heavy text — bigrams are too coarse for short CJK titles,
   where one misread character can wipe out most of the available bigrams
   and tank the score even when OCR got the title mostly right. A regex also
   pulls out any plausible level token (`1`–`15`, optionally with `+`) from
   *both* OCR passes; if a song has a sheet whose level matches one seen on
   screen, its match score gets a boost.
6. **Reveal**: the best match pops up automatically — no confirmation tap
   needed. The popup shows the full difficulty grid with each sheet's shown
   level flipping to reveal the internal level beside it, plus:
   - **prev/next (‹ ›) buttons** and a row of cover thumbnails at the bottom
     to jump straight to any other candidate the scan found, so a wrong
     first guess is a single tap to correct;
   - a **DX / Standard toggle** when a song has both chart types, since they
     can have different levels and internal levels per difficulty;
   - a **Search on YouTube** button that opens a search for the song title +
     artist in a new tab.

If OCR still doesn't nail it (arcade cabinet photos are genuinely hard —
screen glare, angle, motion blur), the **manual search box** underneath is the
reliable fallback: it fuzzy-searches the same dataset by title or artist as
you type.

## Notes & limitations

- Internal levels are **community-sourced estimates** (credited by
  arcade-songs.zetaraku.dev to the maimai internal-level tracking community —
  see their [about page](https://arcade-songs.zetaraku.dev/maimai/about/) for
  full credits), not numbers SEGA publishes. They're very well-maintained but
  can occasionally be revised.
- The data endpoint is fetched client-side from third-party infrastructure
  that this project doesn't control; if your network blocks it or it's ever
  moved, the status pill at the top will show an error instead of silently
  failing. Repeat visits reuse a 12-hour local cache instead of re-fetching,
  and there's a manual refresh button when you do want the latest data.
- This is an unofficial fan tool. maimai DX is a trademark of SEGA
  Interactive Co., Ltd.; this project isn't affiliated with or endorsed by
  SEGA.
