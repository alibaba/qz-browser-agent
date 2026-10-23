// Per-locale example lists. Detail pages, homepage cards, and translations
// are generated from this file. Paths are relative to the website root.
//
// An entry needs `slug` and `file` (the session export). `video` is an optional
// mp4. `poster` is an optional image; with a video and no poster, the generator
// extracts a frame. `posterTime` is the extract point in seconds (default 1).
// `cardGif` is an optional animated cover for the homepage card only; the detail
// page keeps the still poster, and so do visitors who prefer reduced motion.
// `title` and `summary` override the session title and the first user message.
//
// fallback: while a locale list is empty, the homepage shows that locale's
// cards from locales[fallback], using fallbackCopy for the empty locale.
// The cards link to the fallback locale's pages. One flag, read only here.
window.QZ_EXAMPLES = {
  storeUrl: "https://chromewebstore.google.com/detail/dknbdgkgoinlgjpfebapkklbmjjgdblm",
  fallback: "zh",
  copy: {
    en: {
      nav: "Examples",
      title: "Real tasks, start to finish.",
      lede: "Each example is a real qz session. The frame on the left is from that session. Follow every step on the right, then import it into qz and pick up the conversation.",
      open: "Open example",
      back: "All examples",
      kind: "Session export",
      download: "Import into qz to continue",
      chrome: "Add to Chrome",
      thread: "Exported conversation",
      missing: "This session export is not on the site yet.",
    },
    "zh-CN": {
      nav: "例子",
      title: "真实任务，完整过程。",
      lede: "每个例子都是轻舟的一次真实会话。左边是这次会话自己的画面，右边是它每一步怎么想、怎么做；导入轻舟，就能接着这段对话继续问。",
      open: "打开例子",
      back: "全部例子",
      kind: "会话导出",
      download: "导入轻舟继续对话",
      chrome: "添加到 Chrome",
      thread: "导出的对话",
      missing: "这份会话导出还没有放进站点。",
    },
  },
  fallbackCopy: {
    en: {
      travel: {
        title: "Kyoto attractions gallery",
        summary: "5 sub-tasks run at once, each finds its own pictures, and the results merge into one gallery.",
        alt: "The gallery of Kyoto photos from the session",
      },
      pelican: {
        title: "A pelican riding a bicycle",
        summary: "Operating the UI like a person.",
        alt: "A pelican on a bicycle, drawn with the mouse on a canvas",
      },
      "hn-skill": {
        title: "Turn Hacker News into a Skill",
        summary: "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence.",
        alt: "Building a Skill from the HN front page",
        sessionAlt: {
          reuse: "Reusing the saved Skill in a new session to read Show HN",
        },
        related: { first: "Create the Skill", reuse: "Reuse in one sentence" },
      },
      "github-weekly": {
        title: "Weekly GitHub trending digest",
        summary: "Reads this week's Trending list, puts it into a table, and writes a short weekly summary.",
        alt: "This week's trending list and the project table",
      },
    },
  },
  locales: {
    zh: [
      {
        slug: "travel",
        title: "杭州景点图集",
        summary: "5 个景点，5 个子任务同时开跑，各自找图，最后汇成一份图集。",
        file: "../website-src/sessions/travel-zh.html",
        video: "assets/examples/travel-zh.mp4",
        cardGif: "assets/examples/travel-zh-card.gif",
        posterTime: 42,
        alt: "并行找图后汇成的杭州景点图集",
      },
      {
        slug: "hn-skill",
        session: "first",
        title: "将 Hacker News 变成 Skill",
        summary: "整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。",
        file: "../website-src/sessions/hn-skill-zh.html",
        video: "assets/examples/hn-skill-zh.mp4",
        cardGif: "assets/examples/hn-skill-zh-card.gif",
        posterTime: 30,
        alt: "整理 HN 热帖并生成 Skill 的过程",
        related: [{ slug: "hn-skill-reuse", id: "reuse", label: "一句话复用" }],
      },
      {
        slug: "hn-skill-reuse",
        group: "hn-skill",
        session: "reuse",
        card: false,
        title: "将 Hacker News 变成 Skill",
        summary: "整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。",
        file: "../website-src/sessions/hn-skill-reuse-zh.html",
        video: "assets/examples/hn-skill-reuse-zh.mp4",
        posterTime: 14,
        alt: "新会话里用已保存的 Skill 查看 Show HN 热帖",
        related: [{ slug: "hn-skill", id: "first", label: "创建 Skill" }],
      },
      {
        slug: "github-weekly",
        title: "GitHub 周榜整理",
        summary: "读完本周 Trending 榜单，整理成表，再写好一段周报总结。",
        file: "../website-src/sessions/github-weekly-zh.html",
        video: "assets/examples/github-weekly-zh.mp4",
        cardGif: "assets/examples/github-weekly-zh-card.gif",
        posterTime: 28,
        alt: "本周榜单和整理出的项目表",
      },
      {
        slug: "pelican",
        title: "喜闻乐见的鹈鹕骑自行车",
        summary: "像人一样操作界面",
        file: "../website-src/sessions/pelican-zh.html",
        video: "assets/examples/pelican-zh.mp4",
        cardGif: "assets/examples/pelican-zh-card.gif",
        posterTime: 40,
        alt: "用鼠标在画布上画出的骑自行车的鹈鹕",
      },
    ],
    // Placeholder English pages: English copy and page chrome, but they still
    // point at the Chinese recordings and sessions. When the English recording
    // and export for a slug exist, change its file, video, cardGif and posterTime.
    en: [
      {
        slug: "travel",
        title: "Kyoto attractions gallery",
        summary: "5 sub-tasks run at once, each finds its own pictures, and the results merge into one gallery.",
        file: "../website-src/sessions/travel-en.html",
        video: "assets/examples/travel-en.mp4",
        cardGif: "assets/examples/travel-en-card.gif",
        posterTime: 42,
        alt: "The gallery of Kyoto photos from the session",
      },
      {
        slug: "hn-skill",
        session: "first",
        title: "Turn Hacker News into a Skill",
        summary: "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence.",
        file: "../website-src/sessions/hn-skill-en.html",
        video: "assets/examples/hn-skill-en.mp4",
        cardGif: "assets/examples/hn-skill-en-card.gif",
        posterTime: 40,
        alt: "Building a Skill from the HN front page",
        related: [{ slug: "hn-skill-reuse", id: "reuse", label: "Reuse in one sentence" }],
      },
      {
        slug: "hn-skill-reuse",
        group: "hn-skill",
        session: "reuse",
        card: false,
        title: "Turn Hacker News into a Skill",
        summary: "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence.",
        file: "../website-src/sessions/hn-skill-reuse-en.html",
        video: "assets/examples/hn-skill-reuse-en.mp4",
        posterTime: 20,
        alt: "Reusing the saved Skill in a new session to read Show HN",
        related: [{ slug: "hn-skill", id: "first", label: "Create the Skill" }],
      },
      {
        slug: "github-weekly",
        title: "Weekly GitHub trending digest",
        summary: "Reads this week's Trending list, puts it into a table, and writes a short weekly summary.",
        file: "../website-src/sessions/github-weekly-en.html",
        video: "assets/examples/github-weekly-en.mp4",
        cardGif: "assets/examples/github-weekly-en-card.gif",
        posterTime: 26,
        alt: "This week's trending list and the project table",
      },
      {
        slug: "pelican",
        title: "A pelican riding a bicycle",
        summary: "Operating the UI like a person.",
        file: "../website-src/sessions/pelican-en.html",
        video: "assets/examples/pelican-en.mp4",
        cardGif: "assets/examples/pelican-en-card.gif",
        posterTime: 40,
        alt: "A pelican on a bicycle, drawn with the mouse on a canvas",
      },
    ],
  },
};
