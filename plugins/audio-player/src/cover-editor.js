/**
 * The cover-art editor (album menu → Edit Cover Art), drawn in the panel.
 * It prepares the new image here; the engine writes it into the album's
 * files (through the Media Metadata library) and updates the library.
 */
import atmos from 'atmos-sdk';
import { call } from './client.js';

const $ = id => document.getElementById(id);

let album = null;
let newFile = null;
let newUrl = null;

export function openCoverEditor(target) {
  album = target;
  newFile = null;
  newUrl = null;
  // The editor sits in the drawer; make sure all of it is on screen.
  atmos.drawer.expand().catch(() => {});

  $('cover-editor-title').textContent = target.album || 'Unknown Album';
  $('cover-editor-artist').textContent = target.artist || 'Unknown Artist';
  const preview = $('cover-editor-preview');
  const placeholder = $('cover-editor-placeholder');
  if (target.cover) {
    preview.src = target.cover;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    // An empty src would load the document itself; drop the attribute.
    preview.removeAttribute('src');
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
  }
  $('cover-editor-save').disabled = true;
  setStatus('');

  const backdrop = $('cover-editor-backdrop');
  const modal = $('cover-editor-modal');
  backdrop.style.display = 'block';
  modal.style.display = 'block';
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    modal.classList.add('open');
  });
}

function close() {
  const backdrop = $('cover-editor-backdrop');
  const modal = $('cover-editor-modal');
  backdrop.classList.remove('open');
  modal.classList.remove('open');
  setTimeout(() => {
    backdrop.style.display = 'none';
    modal.style.display = 'none';
  }, 240);
  album = null;
  newFile = null;
  newUrl = null;
}

function setStatus(text, kind = '') {
  const status = $('cover-editor-status');
  status.textContent = text;
  status.className = `cover-editor-status${kind ? ` ${kind}` : ''}`;
}

function chooseFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  newFile = file;
  const reader = new FileReader();
  reader.onload = event => {
    newUrl = event.target.result;
    const preview = $('cover-editor-preview');
    preview.src = newUrl;
    preview.style.display = 'block';
    $('cover-editor-placeholder').style.display = 'none';
    $('cover-editor-save').disabled = false;
  };
  reader.readAsDataURL(file);
}

function resizeDataUrl(dataUrl, size) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      canvas.getContext('2d').drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

async function saveCover() {
  if (!album || !newFile || !newUrl) return;
  const saveButton = $('cover-editor-save');
  saveButton.disabled = true;
  setStatus('Saving…');
  try {
    // Every source format is normalised to JPEG, so describe those bytes.
    const embedDataUrl = await resizeDataUrl(newUrl, 600);
    const mimeType = /^data:image\/png[;,]/i.test(embedDataUrl) ? 'image/png' : 'image/jpeg';
    const thumbDataUrl = await resizeDataUrl(newUrl, 400);
    const result = await call('saveCover', album.key, embedDataUrl.split(',')[1], mimeType, thumbDataUrl);
    if (result?.anyWriteErr) setStatus('Saved (some files could not be written)', 'warn');
    else if (result?.sidecarUsed) setStatus(`Saved · cover.jpg written next to files (${result.sidecarExt} embed not supported)`, 'warn');
    else setStatus('Saved!', 'ok');
    setTimeout(close, 1100);
  } catch (error) {
    console.error('[audio-player] cover save:', error);
    setStatus(`Error: ${error.message || String(error)}`, 'err');
    saveButton.disabled = false;
  }
}

export function initCoverEditor() {
  $('cover-editor-close').addEventListener('click', close);
  $('cover-editor-cancel').addEventListener('click', close);
  $('cover-editor-backdrop').addEventListener('click', close);
  $('cover-editor-modal').addEventListener('click', event => event.stopPropagation());

  const dropZone = $('cover-editor-drop-zone');
  dropZone.addEventListener('click', async event => {
    event.stopPropagation();
    try {
      const mediaPath = album ? await call('mediaPathForAlbum', album.key) : null;
      const selected = await atmos.invoke('plugin:audio-player', 'choose-cover', mediaPath);
      if (!selected?.data) return;
      const bytes = selected.data instanceof Uint8Array ? selected.data : new Uint8Array(selected.data?.data || selected.data);
      chooseFile(new File([bytes], selected.name || 'cover', { type: selected.type || 'application/octet-stream' }));
    } catch (error) {
      setStatus(`Could not open image: ${error?.message || String(error)}`, 'err');
    }
  });
  $('cover-editor-file-input').addEventListener('change', event => {
    const file = event.target.files[0];
    if (file) chooseFile(file);
    event.target.value = '';
  });
  dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', event => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = event.dataTransfer.files[0];
    if (file) chooseFile(file);
  });
  $('cover-editor-save').addEventListener('click', saveCover);
  document.addEventListener('keydown', event => {
    const modal = $('cover-editor-modal');
    if (event.key === 'Escape' && modal && modal.style.display !== 'none' && modal.style.display !== '') {
      event.preventDefault();
      close();
    }
  });
}
