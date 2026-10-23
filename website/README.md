# qz website

Preview the static site from the repository root:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory website
```

Open `http://127.0.0.1:4173/`. Use the language button to switch between English and Simplified
Chinese on the same page. The initial language follows `?lang=en` or `?lang=zh-CN`, then a saved
preference, then the browser language. Switching preserves the URL fragment and scroll position.
Example detail pages are separate for each locale; their language button opens the other locale.

No dependency installation or build is required. Edit `assets/translations.js` for the localized
content and attributes. Keep the English fallback in `index.html` in sync with those translations;
it remains usable without JavaScript. Layout and behavior live in `assets/site.css` and
`assets/site.js`. All local URLs are relative so the site also works under the GitHub Pages project
path `/qz-browser-agent/`.

## Content and assets

- Use the product's default black, white, and gray design tokens at website sizes. The website
  follows the system color scheme and reduced-motion preference.
- Primary installation links point to the [Chrome Web Store](https://chromewebstore.google.com/detail/dknbdgkgoinlgjpfebapkklbmjjgdblm).
  The installation section also links to the latest GitHub release for manual installation.
- The Agent-friendly section pairs an illustrative terminal session with actual narrow Side Panel
  screenshots from the documentation-research task. The console is authored HTML, not a recording.
  `assets/screens/agent-en.png` and `agent-zh.png` show the same original English conversation in
  each interface language; see [screenshot sources](assets/screens/SOURCES.md) for capture details.
- The CLI and Skill installation commands use the published `qz-browser-agent` npm package and
  `skills/qz-browser-agent/SKILL.md`. Both languages use `npx skills add alibaba/qz-browser-agent -g`
  to install the Skill. See the [CLI guide](../services/mcp-bridge/README.md) for CLI usage.
  Without JavaScript, the English content and installation commands remain visible.
- The English and Chinese workspace screenshots are unchanged copies of `docs/images/workspace.png`
  and `docs/images/workspace-zh-CN.png`. Update both copies when those source images change.
- Open Graph and Twitter cards use the 1200×630 `assets/og-card.png` in both languages. Keep the
  image tags in `index.html` and both `ogImage` values in `assets/translations.js` aligned.
- `assets/demo-en.mp4` is the existing 45-second English demo. It loads only when the
  visitor opens the player. Chinese mode labels the video as English and uses the Chinese workspace
  screenshot. Language switches keep the existing video player and its playback position.
- The table screenshots come from a live documentation-research task with a real model. The image
  collections, Skill script editor, custom result cards, and parallel task tree are native UI crops
  from the English and Chinese recordings.
  See [screenshot sources](assets/screens/SOURCES.md) for exact frames and crop coordinates.
  Click any screenshot to inspect it in a dialog or open its original image.
- The privacy link points to `docs/permissions.md` on GitHub, which remains the policy's source.
- The [credits page](credits/index.html) records attribution for the screenshots and film.
  `assets/CREDITS.md` preserves the film's source notes.
- This site adds no analytics, cookies, external fonts, or third-party embeds. Its only browser
  storage is the visitor's language preference.

## GitHub Pages

The deployment workflow uploads only `website/`, without building or testing the extension.
In repository **Settings → Pages**, select **GitHub Actions** as the source. The workflow can be
run manually and deploys when changes to the website or its workflow reach `main`.

The expected default URL is `https://alibaba.github.io/qz-browser-agent/`. Update canonical,
language-alternate, and Open Graph URLs in `index.html` and `assets/translations.js` if the domain changes.
Publishing requires the repository's normal permissions and organization policy to allow Pages.
