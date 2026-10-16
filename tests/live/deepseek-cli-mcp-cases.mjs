// Short English requests with public sources; all writes stay in the isolated test profile.
export const CASES = [
  {
    id: "hn-reading-list", kind: "research",
    prompt: 'Open https://news.ycombinator.com/ and save the first 10 stories in a Data table called "HN reading list", with title, points, article URL, and discussion URL.',
    expectTable: "HN reading list", expectMinRows: 10,
    followUp: 'Keep only stories with at least 100 points in a new table called "HN shortlist".',
  },
  {
    id: "database-comparison", kind: "steer",
    prompt: 'Compare SQLite and DuckDB for analyzing local CSV files. Check both projects\' official documentation and give me a short recommendation with sources.',
    steer: 'Focus on a single-user desktop app. Keep the answer under 150 words.',
    expectTerms: ["SQLite", "DuckDB"], expectSource: true,
  },
  {
    id: "earthquake-watch", kind: "research",
    prompt: 'Read https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson and save the five largest earthquakes to "Earthquake watch". Include magnitude, place, time, and source URL, sorted by magnitude.',
    expectTable: "Earthquake watch", expectMinRows: 1,
    followUp: 'Create a second table called "Earthquake shortlist" containing only events from that table with magnitude 4 or greater.',
  },
  {
    id: "json-checklist", kind: "export",
    prompt: 'Use the qingzhou-documents Skill to read https://www.rfc-editor.org/rfc/rfc8259.txt and create a downloadable Markdown checklist of six JSON interoperability pitfalls.',
    expectDownload: true, expectTerms: ["JSON"],
  },
  {
    id: "city-choice", kind: "form",
    prompt: 'Ask me to choose Hangzhou or Suzhou using a choice form. Then use Wikipedia to recommend three historic places in my chosen city, with source links.',
    expectSource: true, expectTerms: ["Hangzhou"],
    followUp: 'Turn those three places into a downloadable one-page Markdown guide.',
  },
  {
    id: "readme-review", kind: "export",
    prompt: 'Compare README.md and README.zh-CN.md in https://github.com/alibaba/qz-browser-agent. Flag any differences in installation instructions and save a short Markdown review with source links.',
    expectDownload: true,
  },
  {
    id: "confirm-research", kind: "confirmation",
    prompt: 'Ask for my confirmation before browsing https://en.wikipedia.org/wiki/Hangzhou, then summarize its history in three sentences with a source link.',
    expectSource: true, expectTerms: ["Hangzhou"],
  },
  {
    id: "cancel-research", kind: "cancel",
    prompt: 'Research PostgreSQL, SQLite, and DuckDB using their official documentation. Compare how each handles concurrent reads and writes, with source links.',
  },
];
