import assert from "node:assert/strict";

const key = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = value => String(value ?? "").trim().replace(/\s+/g, " ");
const businessRow = row => row?.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : row;
const fields = row => Object.entries(businessRow(row) || {}).map(([name, value]) => ({ name, key: key(name), value }));
const named = (row, names) => fields(row).find(field => names.includes(field.key));
function number(value, label) {
  const match = typeof value === "number" ? String(value) : clean(value).replace(/,/g, "").match(/^-?\d+(?:\.\d+)?(?:\s*(?:points?|votes?|mw|ml))?$/i)?.[0];
  const result = typeof value === "number" ? value : Number.parseFloat(match);
  assert.ok(Number.isFinite(result), `${label} must be numeric; got ${JSON.stringify(value)}`);
  return result;
}
function url(value) {
  const text = clean(value).replace(/&amp;/g, "&");
  const raw = text.match(/\]\((https?:\/\/[^\s)]+)\)/)?.[1] || text;
  try { const result = new URL(raw); return /^https?:$/.test(result.protocol) ? result : null; } catch { return null; }
}
function urls(row) {
  return fields(row).flatMap(field => { const value = url(field.value); return value ? [{ ...field, url: value }] : []; });
}
const sourceHref = value => { const parsed = new URL(value); parsed.hash = ""; return parsed.href; };
function hnRow(row) {
  const title = named(row, ["title", "storytitle", "headline", "story", "name"]);
  assert.ok(title && clean(title.value), "HN row needs a non-empty story title");
  const score = named(row, ["points", "point", "score", "votes", "upvotes", "hnpoints", "pointsatcapture"]);
  assert.ok(score, "HN row needs a points/score column");
  const points = number(score.value, "HN points");
  assert.ok(Number.isInteger(points) && points >= 0, "HN points must be a nonnegative integer");
  const links = urls(row);
  const discussion = links.find(field => field.url.hostname === "news.ycombinator.com" && field.url.pathname === "/item" && /^\d+$/.test(field.url.searchParams.get("id") || ""));
  assert.ok(discussion, "HN row needs a real item discussion URL");
  const article = links.find(field => ["articleurl", "storyurl", "articlelink", "storylink", "url", "link", "sourceurl", "source"].includes(field.key))
    || links.find(field => field.url.href !== discussion.url.href) || discussion;
  const articleColumn = fields(row).some(field => ["articleurl", "storyurl", "articlelink", "storylink", "url", "link", "sourceurl", "source"].includes(field.key));
  assert.ok(links.length >= 2 || articleColumn, "HN row needs an article URL field as well as its discussion URL");
  return { id: discussion.url.searchParams.get("id"), title: clean(title.value), points,
    articleUrl: sourceHref(article.url.href), discussionUrl: `https://news.ycombinator.com/item?id=${discussion.url.searchParams.get("id")}` };
}
function earthquakeRow(row) {
  const magnitude = named(row, ["magnitude", "mag", "magnitudemw", "magnitudeml", "magnitudevalue"]);
  const place = named(row, ["place", "location", "region", "eventplace", "title"]);
  const time = named(row, ["time", "timestamp", "datetime", "date", "timeutc", "utctime", "datetimeutc", "eventtime", "occurredat"]);
  assert.ok(magnitude, "Earthquake row needs a magnitude column");
  assert.ok(place && clean(place.value), "Earthquake row needs a place");
  assert.ok(time && clean(time.value), "Earthquake row needs a time");
  const link = urls(row).find(field => field.url.hostname === "earthquake.usgs.gov" && /\/earthquakes\/eventpage\/[^/]+/.test(field.url.pathname));
  assert.ok(link, "Earthquake row needs a USGS event URL");
  const id = link.url.pathname.match(/\/earthquakes\/eventpage\/([^/]+)/)[1];
  const epoch = typeof time.value === "number" ? time.value : Date.parse(clean(time.value));
  return { id, magnitude: number(magnitude.value, "Earthquake magnitude"), place: clean(place.value),
    time: Number.isFinite(epoch) ? epoch : clean(time.value), sourceUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}` };
}
function unique(rows, label) {
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, `${label} contains duplicate source records`);
}
function subset(rows, followUpRows, normalize, predicate, label) {
  const expected = rows.filter(predicate).sort((a, b) => a.id.localeCompare(b.id));
  const actual = followUpRows.map(normalize).sort((a, b) => a.id.localeCompare(b.id));
  unique(actual, label);
  assert.deepEqual(actual, expected, `${label} must contain exactly the qualifying original records, without changed fields`);
  return { expectedRows: expected.length, actualRows: actual.length, exact: true };
}
function markdownText(markdown) {
  if (Array.isArray(markdown)) return markdown.map(markdownText).join("\n\n");
  if (markdown instanceof Uint8Array) return new TextDecoder().decode(markdown);
  if (markdown && typeof markdown === "object") return markdownText(markdown.text ?? markdown.bytes ?? "");
  return String(markdown ?? "");
}

/** Verify actual model-produced rows/files. This helper neither seeds data nor calls a provider. */
export function verifyLiveCase({ id, rows, followUpRows, markdown, sourceRows } = {}) {
  const result = { id, checks: [] };
  if (id === "hn-reading-list") {
    assert.ok(Array.isArray(rows), "HN acceptance requires the actual table rows");
    assert.equal(rows.length, 10, "HN reading list must contain exactly ten stories");
    const canonical = rows.map(hnRow); unique(canonical, "HN reading list");
    result.rows = canonical.length; result.checks.push("ten-unique-stories", "nonempty-titles", "numeric-points", "article-and-discussion-urls");
    if (Array.isArray(sourceRows)) {
      assert.deepEqual(canonical, sourceRows.slice(0, 10).map(hnRow), "HN rows must match the same captured front page");
      result.sourceSnapshotVerified = true;
    } else result.sourceSnapshotVerified = false;
    if (followUpRows !== undefined) {
      assert.ok(Array.isArray(followUpRows));
      result.followUp = subset(canonical, followUpRows, hnRow, row => row.points >= 100, "HN shortlist");
      result.checks.push("exact-100-point-subset");
    }
  }
  if (id === "earthquake-watch") {
    assert.ok(Array.isArray(rows), "Earthquake acceptance requires the actual table rows");
    assert.ok(rows.length >= 1 && rows.length <= 5, "Earthquake watch must contain one to five events");
    const canonical = rows.map(earthquakeRow); unique(canonical, "Earthquake watch");
    assert.ok(canonical.every((row, index) => index === 0 || canonical[index - 1].magnitude >= row.magnitude), "Earthquakes must be sorted by magnitude descending");
    result.rows = canonical.length; result.checks.push("unique-events", "descending-magnitude", "place-and-time", "usgs-event-urls");
    const source = Array.isArray(sourceRows?.features) ? sourceRows.features.map(feature => ({ ...feature.properties, id: feature.id })) : sourceRows;
    if (Array.isArray(source)) {
      const valid = source.filter(event => typeof event.mag === "number" || typeof event.magnitude === "number");
      const expectedCount = Math.min(5, valid.length); assert.equal(canonical.length, expectedCount);
      const strongest = valid.map(event => event.mag ?? event.magnitude).sort((a, b) => b - a).slice(0, expectedCount);
      assert.deepEqual(canonical.map(row => row.magnitude), strongest, "Selected earthquakes must be the five strongest in the captured feed");
      const byId = new Map(valid.map(event => [String(event.id || url(event.url || event.sourceUrl)?.pathname.match(/eventpage\/([^/]+)/)?.[1] || ""), event]));
      for (const row of canonical) { const actual = byId.get(row.id); assert.ok(actual, `Event ${row.id} is missing from the captured feed`); assert.equal(row.magnitude, actual.mag ?? actual.magnitude); }
      result.sourceSnapshotVerified = true;
    } else result.sourceSnapshotVerified = false;
    if (followUpRows !== undefined) {
      assert.ok(Array.isArray(followUpRows));
      result.followUp = subset(canonical, followUpRows, earthquakeRow, row => row.magnitude >= 4, "Earthquake shortlist");
      result.checks.push("exact-magnitude-four-subset");
    }
  }
  if (markdown !== undefined) {
    const text = markdownText(markdown).replace(/^\uFEFF/, "");
    assert.ok(text.trim().length >= 100, "The downloaded Markdown must contain substantive content");
    assert.ok(!/^\s*<!doctype html|^\s*<html/i.test(text), "The downloaded Markdown must not be an HTML error page");
    result.markdownChars = text.length; result.checks.push("substantive-markdown-bytes");
    if (id === "json-checklist") {
      const items = text.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm) || [];
      const sections = text.match(/^#{2,6}\s+/gm) || [];
      assert.ok(Math.max(items.length, sections.length) >= 6, "The RFC checklist needs at least six listed items or sections");
      assert.match(text, /json/i); assert.match(text, /RFC[\s_-]*8259|rfc-editor\.org\/rfc\/rfc8259/i);
      result.checks.push("six-json-checklist-items", "rfc-8259-reference");
    }
    if (id === "readme-review") {
      assert.match(text, /README\.md/i); assert.match(text, /README\.zh-CN\.md/i);
      assert.match(text, /https?:\/\/(?:github\.com|raw\.githubusercontent\.com)\/alibaba\/qz-browser-agent/);
      result.checks.push("bilingual-readme-references", "repository-source-url");
    }
    if (id === "city-choice") { assert.match(text, /https?:\/\/[^\s)]+wikipedia\.org\//); result.checks.push("wikipedia-source-url"); }
  }
  return result;
}
