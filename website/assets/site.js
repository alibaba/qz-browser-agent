import { translations } from './translations.js';

// Progressive enhancement: the English page remains usable without JavaScript.
const languageButton = document.querySelector('.language');
const languageStorageKey = 'qz.website.language';
const contentBindings = [...document.querySelectorAll('[data-i18n]')];
const attributeBindings = [...document.querySelectorAll('[data-i18n-attributes]')];
let locale = 'en';
let localeVersion = 0;

function preferredLanguage() {
  const explicit = new URL(location.href).searchParams.get('lang');
  if (Object.hasOwn(translations, explicit)) return explicit;
  try {
    const saved = localStorage.getItem(languageStorageKey);
    if (Object.hasOwn(translations, saved)) return saved;
  } catch { /* Language selection also works when browser storage is unavailable. */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function pageLocale() {
  const specified = languageButton?.dataset.exampleLocale;
  if (specified && Object.hasOwn(translations, specified)) return specified;
  return '';
}

function setLanguage(next, { remember = false } = {}) {
  const copy = translations[next];
  if (!copy) return;
  const { scrollX, scrollY } = window;
  locale = next;
  localeVersion += 1;
  document.documentElement.lang = next;
  document.title = copy.title;
  // These strings are static markup shipped with the site, never visitor-supplied HTML.
  for (const element of contentBindings) element.innerHTML = copy.html[element.dataset.i18n];
  for (const element of attributeBindings) {
    for (const [name, value] of Object.entries(copy.attributes[element.dataset.i18nAttributes])) {
      element.setAttribute(name, value);
    }
  }
  languageButton.textContent = next === 'en' ? '中文' : 'EN';
  languageButton.lang = next === 'en' ? 'zh-CN' : 'en';
  languageButton.setAttribute('aria-label', next === 'en' ? 'Switch to 简体中文' : 'Switch to English');
  document.querySelectorAll('.copy-status').forEach((status) => { status.textContent = ''; });
  if (remember) {
    try { localStorage.setItem(languageStorageKey, next); } catch { /* Optional preference. */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', next);
    history.replaceState(history.state, '', url);
    window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
  }
}

if (languageButton instanceof HTMLButtonElement) {
  setLanguage(pageLocale() || preferredLanguage());
  languageButton.hidden = false;
  languageButton.addEventListener('click', () => {
    const href = languageButton.dataset.switchHref;
    if (href) {
      const next = locale === 'en' ? 'zh-CN' : 'en';
      try { localStorage.setItem(languageStorageKey, next); } catch { /* Optional preference. */ }
      location.assign(href);
      return;
    }
    setLanguage(locale === 'en' ? 'zh-CN' : 'en', { remember: true });
  });
  window.addEventListener('popstate', () => setLanguage(pageLocale() || preferredLanguage()));
}

const dialog = document.querySelector('#video-dialog');
const video = dialog?.querySelector('video');

if (dialog instanceof HTMLDialogElement && video instanceof HTMLVideoElement) {
  document.querySelectorAll('[data-open-video]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!video.getAttribute('src')) video.src = video.dataset.src;
      dialog.showModal();
      video.play().catch(() => { /* Native controls remain available if playback is blocked. */ });
    });
  });
  dialog.querySelector('.close-video')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => video.pause());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}

for (const copyButton of document.querySelectorAll('[data-copy-prompt], [data-copy-target]')) {
  const content = document.getElementById(copyButton.dataset.copyTarget || 'first-prompt');
  const status = copyButton.closest('[data-copy-block], .first-prompt')?.querySelector('.copy-status');
  if (!(copyButton instanceof HTMLButtonElement) || !content || !status || !navigator.clipboard) continue;
  copyButton.hidden = false;
  let resetTimer;
  copyButton.addEventListener('click', async () => {
    clearTimeout(resetTimer);
    const requestedLocaleVersion = localeVersion;
    try {
      await navigator.clipboard.writeText(content.textContent.trim());
      if (requestedLocaleVersion !== localeVersion) return;
      status.textContent = copyButton.dataset.copied;
      resetTimer = setTimeout(() => { status.textContent = ''; }, 2500);
    } catch {
      if (requestedLocaleVersion !== localeVersion) return;
      status.textContent = copyButton.dataset.failed;
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(content);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  });
}

// The source links work without JavaScript; the dialog keeps visitors on the page.
const imageDialog = document.querySelector('#image-dialog');
const expandedImage = document.querySelector('#expanded-image');
const imageOriginal = document.querySelector('#image-original');
if (imageDialog instanceof HTMLDialogElement && expandedImage instanceof HTMLImageElement) {
  document.querySelectorAll('[data-open-image]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const source = link.querySelector('img');
      if (!source) return;
      event.preventDefault();
      expandedImage.src = link.href;
      expandedImage.alt = source.alt;
      imageOriginal.href = link.href;
      imageDialog.showModal();
    });
  });
  imageDialog.querySelector('.close-image').addEventListener('click', () => imageDialog.close());
  imageDialog.addEventListener('click', (event) => {
    if (event.target !== imageDialog) return;
    const rect = imageDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) imageDialog.close();
  });
}
