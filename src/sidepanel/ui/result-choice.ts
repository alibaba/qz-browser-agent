import type { ResultChoiceOptions } from "../../sdk/sidepanel/dom.js";

/** Stateless choice card. Native input events bubble to the owning form. */
export function renderResultChoice(document: Document, options: ResultChoiceOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = "qz-choice-card";

  const label = document.createElement("label");
  label.className = "qz-choice-card-label";
  label.htmlFor = options.id;

  const input = document.createElement("input");
  input.id = options.id;
  input.name = options.name;
  input.value = options.value;
  input.type = options.multiple ? "checkbox" : "radio";
  input.className = options.multiple ? "qz-checkbox" : "qz-radio";
  input.checked = input.defaultChecked = options.checked;
  input.disabled = Boolean(options.disabled);

  const content = document.createElement("span");
  content.className = "qz-choice-card-content";
  const title = document.createElement("strong");
  title.className = "qz-choice-card-title";
  title.id = `${options.id}-label`;
  title.dir = "auto";
  title.textContent = options.label;
  input.setAttribute("aria-labelledby", title.id);
  content.append(title);

  if (options.description) {
    const description = document.createElement("span");
    description.className = "qz-choice-card-description";
    description.id = `${options.id}-description`;
    description.dir = "auto";
    description.textContent = options.description;
    input.setAttribute("aria-describedby", description.id);
    content.append(description);
  }

  const values = options.meta?.filter(value => value.trim());
  if (values?.length) {
    const meta = document.createElement("span");
    meta.className = "qz-choice-card-meta";
    for (const value of values) {
      const item = document.createElement("span");
      item.className = "qz-choice-card-tag";
      item.dir = "auto";
      item.textContent = value;
      meta.append(item);
    }
    content.append(meta);
  }

  label.append(input, content);
  const imageUrl = webUrl(options.imageUrl);
  if (imageUrl) {
    const image = document.createElement("img");
    image.className = "qz-choice-card-image";
    image.src = imageUrl.href;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    label.append(image);
  }
  card.append(label);

  const sourceUrl = webUrl(options.url);
  if (sourceUrl) {
    const footer = document.createElement("div");
    footer.className = "qz-choice-card-footer";
    const source = document.createElement("a");
    source.className = "qz-choice-card-source";
    source.href = sourceUrl.href;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.dir = "ltr";
    source.title = sourceUrl.href;
    source.setAttribute("aria-label", `${options.label} · ${sourceUrl.hostname}`);
    source.textContent = sourceUrl.hostname;
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = " ↗";
    source.append(arrow);
    footer.append(source);
    card.append(footer);
  }
  return card;
}

function webUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url : null;
  } catch { return null; }
}
