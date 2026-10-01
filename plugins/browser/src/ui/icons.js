/**
 * The browser's icons: 16 px line drawings in currentColor, so they follow
 * Atmos's ink colour like its own.
 */
const svg = body => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  back: svg('<path d="M13 8H3.5M7.5 4 3.5 8l4 4"/>'),
  forward: svg('<path d="M3 8h9.5M8.5 4l4 4-4 4"/>'),
  reload: svg('<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5v3h-3"/>'),
  stop: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  menu: svg('<circle cx="3.5" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="12.5" cy="8" r=".6" fill="currentColor"/>'),
  star: svg('<path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.69 3.93L8 11.2l-3.52 1.85.69-3.93L2.3 6.35l3.95-.55z"/>'),
  starFilled: svg('<path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.69 3.93L8 11.2l-3.52 1.85.69-3.93L2.3 6.35l3.95-.55z" fill="currentColor"/>'),
  lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  warning: svg('<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/>'),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/>'),
  globe: svg('<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.6 1.7 2.4 3.6 2.4 5.8S9.6 12.1 8 13.8C6.4 12.1 5.6 10.2 5.6 8S6.4 3.9 8 2.2z"/>'),
  download: svg('<path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/>'),
  history: svg('<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>'),
  bookmark: svg('<path d="M4.5 2.5h7v11L8 11l-3.5 2.5z"/>'),
  speaker: svg('<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.5 5.8a3 3 0 0 1 0 4.4M12.3 4.2a5.3 5.3 0 0 1 0 7.6"/>'),
  muted: svg('<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.5 6.2l3 3.6M13.5 6.2l-3 3.6"/>'),
  private: svg('<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="1.8"/><path d="M2.5 13.5 13.5 2.5"/>'),
  folder: svg('<path d="M2 4.5h4l1.2 1.5H14v6.5H2z"/>'),
  file: svg('<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>'),
  pause: svg('<path d="M5.5 4v8M10.5 4v8"/>'),
  play: svg('<path d="M5 3.5v9l7-4.5z"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  up: svg('<path d="M4 10l4-4 4 4"/>'),
  down: svg('<path d="M4 6l4 4 4-4"/>'),
  camera: svg('<rect x="2" y="4.5" width="8.5" height="7" rx="1.2"/><path d="M10.5 7.2 14 5.5v5l-3.5-1.7"/>'),
  microphone: svg('<rect x="6" y="2.5" width="4" height="7" rx="2"/><path d="M3.8 8a4.2 4.2 0 0 0 8.4 0M8 12.2v1.8"/>'),
  location: svg('<path d="M8 14s4.5-4.1 4.5-7.3a4.5 4.5 0 0 0-9 0C3.5 9.9 8 14 8 14z"/><circle cx="8" cy="6.7" r="1.5"/>'),
  bell: svg('<path d="M4 11V7.2a4 4 0 0 1 8 0V11l1 1.2H3z"/><path d="M6.8 13.6a1.3 1.3 0 0 0 2.4 0"/>'),
  clipboard: svg('<rect x="3.5" y="3" width="9" height="11" rx="1.2"/><path d="M6 3V2h4v1"/>'),
  link: svg('<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.8.8"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.8-.8"/>'),
  shield: svg('<path d="M8 1.8l5 1.9v3.9c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6V3.7z"/><path d="M5.8 8l1.5 1.5 3-3"/>'),
  shieldOff: svg('<path d="M8 1.8l5 1.9v3.9c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6V3.7z"/><path d="M2.5 2.5l11 11"/>'),
};

/** The icon for a site permission. */
export const PERMISSION_ICONS = {
  camera: 'camera', microphone: 'microphone', geolocation: 'location', notifications: 'bell', 'clipboard-read': 'clipboard',
};

/** What a permission lets a site do, as a prompt says it. */
export const PERMISSION_WORDS = {
  camera: 'Use your camera',
  microphone: 'Use your microphone',
  geolocation: 'Know your location',
  notifications: 'Show notifications',
  'clipboard-read': 'See text and images you copy',
};

/** Its short name, for Settings. */
export const PERMISSION_NAMES = {
  camera: 'Camera', microphone: 'Microphone', geolocation: 'Location', notifications: 'Notifications', 'clipboard-read': 'Clipboard',
  ads: 'Ads and trackers', popups: 'Pop-ups without a click',
};
