/** Small DOM helpers for the browser's views. Text is always set as text, never parsed. */
import { ICONS } from './icons.js';
import { hostOf } from '../address.js';

/** h('div', { class: 'x', onclick }, child, 'text', …) */
export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name === 'text') element.textContent = value;
    else if (name === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (name === 'dataset') Object.assign(element.dataset, value);
    else if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

/** One of ICONS as an element (our own markup, never page content). */
export function icon(name) {
  const template = document.createElement('template');
  template.innerHTML = ICONS[name] || ICONS.globe;
  return template.content.firstElementChild;
}

/** A site's icon: the page's own (a data: URL Core fetched), or a globe. */
export function siteIcon(dataUrl, fallback = 'globe') {
  if (typeof dataUrl === 'string' && /^data:image\//i.test(dataUrl)) {
    const image = h('img', { alt: '', draggable: 'false', src: dataUrl });
    image.addEventListener('error', () => image.replaceWith(icon(fallback)), { once: true });
    return image;
  }
  return icon(fallback);
}

/** What to call a tab: its title, else its site, else "New tab". */
export function tabLabel(tab) {
  if (!tab) return '';
  if (tab.kind === 'history' || tab.page === 'history') return 'History';
  if (tab.title) return tab.title;
  if (tab.url) return hostOf(tab.url) || tab.url;
  return tab.private ? 'New private tab' : 'New tab';
}

/** 1.5 MB, 320 KB… */
export function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = n / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/** Runs `fn` once per animation frame at most. */
export function perFrame(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(); });
  };
}

/**
 * Runs `fn` soon, once for a burst of calls. For widgets and settings:
 * a frame Chromium isn't painting (a collapsed sidebar section) gets no
 * animation frames, but timers still run, so it's current when it shows.
 */
export function soon(fn, delay = 30) {
  let timer = null;
  return () => {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; fn(); }, delay);
  };
}

/**
 * Give `element` the keyboard, taking it from the page if that has it.
 * Focus moving into this frame from the page arrives a moment after the
 * frame asks, and lands on the frame's body; so it's asked again until it
 * holds (a few times, over a quarter of a second), unless you've moved on
 * to something else in the frame meanwhile.
 */
export function takeFocus(element, { select = false } = {}) {
  const take = () => {
    const active = document.activeElement;
    if (active === element && document.hasFocus()) return;
    if (active && active !== document.body && active !== element) return;
    window.focus();
    element.focus({ preventScroll: true });
    if (select) element.select?.();
  };
  element.focus({ preventScroll: true });
  if (select) element.select?.();
  requestAnimationFrame(take);
  for (const delay of [60, 150, 300]) setTimeout(take, delay);
}
