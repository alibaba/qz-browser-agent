# Screenshot sources

The table screenshots come from a new live qz task. The other screenshots are crops of real qz browser recordings. UI text, code, and result content are unchanged.
PNG output preserves the original pixels; CSS scales images for display. Model-selection footers
are outside the crops. Coordinates refer to the original 2880 × 1626 recordings and use
`x, y, width, height`.

Source paths below are relative to the local `qz-intro/` production directory. The source videos
remain outside the Git repository.

| Asset | Recording | Time (seconds) | Crop |
| --- | --- | ---: | --- |
| gallery-en.png | v3/recordings/hangzhou-gallery.mov | 31 | 2132, 176, 740, 1360 |
| gallery-zh.png | zh-v7/recordings/gallery-final.mov | 4 | 2132, 176, 740, 1360 |
| skill-code-en.png | v3/recordings/skill-ui.mov | 87 | 2132, 370, 740, 1100 |
| skill-code-zh.png | zh-v7/recordings/skill-script.mov | 3 | 2132, 370, 740, 1100 |
| skill-ui-en.png | v3/recordings/skill-custom-ui.mov | 8 | 2132, 370, 740, 1100 |
| skill-ui-zh.png | zh-v7/recordings/skill-ui.mov | 3 | 2132, 370, 740, 1100 |
| parallel-en.png | v7/recordings/delegate.mov | 44 | 2132, 176, 740, 1360 |
| parallel-zh.png | zh-v7/recordings/delegate-hangzhou.mov | 40 | 2132, 176, 740, 1360 |

For example:

```bash
ffmpeg -ss 87 -i qz-intro/v3/recordings/skill-ui.mov \
  -frames:v 1 -vf 'crop=740:1100:2132:370' skill-code-en.png
```

The Wikipedia photographs retain their respective licenses. Source links, photographers, and
licenses are listed on the [credits page](../../credits/index.html). Project names appear in an actual comparison task; they do not imply endorsement.

## Live research table — October 15, 2026

`table-en.png` and `table-zh.png` are unmodified screenshots of the real extension Data view at
1280 × 460 CSS pixels with a 2× device scale (2560 × 920 PNG output). The extension ran in a
fresh, isolated Chromium profile with a real DeepSeek API connection. No page or model responses
were mocked. These are AI-generated research results shown as a product demonstration.

The first task compared Playwright, Puppeteer, and Selenium against their official documentation.
It visited the documentation pages, performed 60 tool executions, and saved six comparison rows.
A follow-up task condensed the cells, checked Selenium Manager's setup behavior, and saved English
and Simplified Chinese tables. The screenshot capture then selected each table in the actual UI.
Both runs completed. Browser profiles and credentials were removed after capture.

Initial instruction:

> I'm choosing a browser automation tool for a project. Compare Playwright, Puppeteer and Selenium
> using their official documentation at https://playwright.dev/, https://pptr.dev/ and
> https://www.selenium.dev/documentation/webdriver/. Check supported browsers, language bindings,
> setup, auto-waiting, debugging tools, and remote execution. Save a comparison table I can edit and
> export, with one row per criterion, a column for each tool, and source links. Keep each cell concise.
> Read the current pages before writing the table. This is research only.

The local capture scripts, task events, and saved demo data are in `qz-site-captures/`, outside
this repository. Provider credentials are neither included in this site nor displayed in screenshots.

Research sources include [Playwright](https://playwright.dev/docs/intro),
[Puppeteer](https://pptr.dev/guides/what-is-puppeteer),
[Selenium WebDriver](https://www.selenium.dev/documentation/webdriver/), and
[Selenium Manager](https://www.selenium.dev/documentation/selenium_manager/).
