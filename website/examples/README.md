# Website examples

Homepage cards and detail pages are generated from [`catalog.js`](catalog.js).
Chinese and English are separate lists, `locales.zh` and `locales.en`. Pages are
`examples/<slug>/` and `examples/en/<slug>/`. For now the English entries are
placeholders: English copy and page chrome, but they still point at the Chinese
recordings and exports. When the English recording and export for a slug exist,
change that entry's `file`, `video`, `cardGif`, and `posterTime`. `fallback` is
`"zh"`: only while `locales.en` is empty does the English homepage show the
Chinese examples with `fallbackCopy.en` and link to the Chinese pages.

Do not hand-edit generated HTML or the marked blocks in `assets/translations.js`.

## Swap or add an example

An example is a session export and, when you have one, a full-browser recording.
The poster is optional.

1. Put the files in place.
   - Session export: `website-src/sessions/<slug>-<locale>.html`. It lives outside `website/` on purpose: the generator reads it and embeds what the page needs, so it is not published.
   - Recording: `website/assets/examples/<slug>-<locale>.mp4`
   - Poster, only to override the extracted frame: `website/assets/examples/<slug>-<locale>.webp`

   `<locale>` is `zh` or `en`. For a new export, clear `runtime.ownedTabs` and shrink images first:

   ```bash
   node website/examples/prepare-exports.mjs --out website-src/sessions path/to/export.html
   ```

   This needs `ffmpeg` with libwebp. It re-encodes PNG and JPEG screenshots to WebP everywhere in the file. For an export with many screenshots, shrink them too, for example `--scale 0.75 --quality 70` (a 12.9MB export became 4.6MB). Each page carries the screenshots twice, once in the transcript and once in the import data, so check `website/` stays under 45MB.

2. Add or edit one object in `locales.zh` or `locales.en`:

   ```js
   {
     slug: "travel",
     file: "../website-src/sessions/travel-zh.html",
     video: "assets/examples/travel-zh.mp4",
     // title and summary are optional. They default to the session title and
     // the first user message. Set them to override that text.
     // poster: "assets/examples/travel-zh.webp",
     // posterTime: 1,
   }
   ```

   `file` is the export. `video` is optional; leave it out until the recording exists.
   With a video and no `poster`, the generator takes a frame at `posterTime` seconds
   (default 1) and writes `assets/examples/<slug>-<locale>.webp`. `poster` overrides
   that frame. With neither a video nor a poster, the page shows an empty frame.

3. Compress a recording to H.264, with no audio, about 1280 pixels wide:

   ```bash
   ffmpeg -i input.mp4 -an -c:v libx264 -crf 28 -preset slow -vf "scale=1280:-2" -pix_fmt yuv420p -movflags +faststart website/assets/examples/<slug>-<locale>.mp4
   ```

   Record or crop the recording to the browser window only, with no outer black margin. `ffmpeg -i in.mp4 -vf cropdetect -f null -` finds the crop. This recording uses `-vf crop=1464:890:68:46`, which also removes the 1px window border on each side.

   Aim for 20–40 seconds and 5MB or less. The poster, whether you supply it or the
   generator extracts it, should be WebP about 840 pixels wide and 80KB or less.

   Optional animated homepage cover: cut a 3 second loop that already shows work in progress, and set `cardGif` on the entry. The detail page keeps the still poster, and so does the card under `prefers-reduced-motion`.

   ```bash
   ffmpeg -ss 14 -t 3 -i website/assets/examples/<slug>-<locale>.mp4 -vf "fps=15,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 website/assets/examples/<slug>-<locale>-card.gif
   ```

   Keep each GIF near 2MB; lower the width or fps if it grows. Keep `website/` under 45MB.

4. Regenerate:

   ```bash
   node website/examples/generate-pages.mjs
   ```

   The generator warns, and still writes the pages, when a video is over about 5MB,
   has an audio track, or is not H.264. If ffmpeg is missing, it says so and keeps
   a `poster` you already set.

5. Preview on the Pages subpath:

   ```bash
   mkdir -p /tmp/qz-pages
   ln -sfn "$PWD/website" /tmp/qz-pages/qz-browser-agent
   python3 -m http.server 4173 --bind 127.0.0.1 --directory /tmp/qz-pages
   ```

   Open `http://127.0.0.1:4173/qz-browser-agent/#examples`.

## Export runtime

`generate-pages.mjs` rewrites the extension's minified export runtime in
`adaptSessionScript` so the transcript runs inside the page's shadow root. If
the extension changes that runtime, regenerate the example pages and check
`adaptSessionScript` against the new script. The generator stops when an
expected rewrite target is missing, so a changed runtime cannot ship as a
broken page.

The shared-sheet check accepts a 0.1.4 export that differs only by
`#app[data-consent-pending]` using `display: none !important` and
`.data-image-gallery-strip` omitting `scrollbar-gutter: stable`. It still
writes the 0.1.2 spelling and rejects every other difference.
