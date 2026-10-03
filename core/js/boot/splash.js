// The boot splash, loaded by index.html right after its markup (a file, not
// inline: the page's Content-Security-Policy allows no inline scripts).
(function () {
  var splash = document.getElementById('boot-splash');
  var mascot = document.getElementById('boot-splash-mascot');
  var statusEl = document.getElementById('boot-splash-status');
  var barFill = document.getElementById('boot-splash-bar-fill');
  if (!splash || !mascot) return;

  // Same press/release "boop" as the About page mascot.
  var restSrc = 'assets/Rev2.png';
  var clickSrc = 'assets/RevClickTSP.png';
  var press = function () { mascot.src = clickSrc; };
  var release = function () { mascot.src = restSrc; };
  mascot.addEventListener('mousedown', press);
  mascot.addEventListener('mouseup', release);
  mascot.addEventListener('mouseleave', release);
  mascot.addEventListener('touchstart', press, { passive: true });
  mascot.addEventListener('touchend', release);
  mascot.addEventListener('touchcancel', release);

  // The splash stays up until app.js reports that startup has finished,
  // but never less than MIN_DISPLAY_MS (no flash on a fast start) and never
  // more than MAX_DISPLAY_MS (a slow network boot hook or a failed start
  // still reveals the app).
  var MIN_DISPLAY_MS = 900;
  var MAX_DISPLAY_MS = 5000;
  var shownAt = Date.now();

  // A big pool of boot-sequence flavour text -- a handful get picked at
  // random each launch (see pickRandomMessages below) so it doesn't say the
  // same thing on every startup.
  var BOOT_MESSAGES = [
    // Rev boot sequence
    'Waking up Rev...',
    'Rev has been located. He was hiding.',
    'Putting the leaves back on...',
    'Untangling antlers...',
    "Making sure Rev hasn't eaten the config files...",
    'Rev searched the runtime for his purpose and found a config file named purpose_final_final_v7.',
    'Rev attempted to organise the modules. The modules organised Rev instead.',
    'Rev discovered a circular dependency and called it "a friendship with commitment issues."',
    'Rev inspected the dependency graph and found a small ecosystem of mistakes wearing business attire.',
    'Rev opened the documentation. The documentation closed itself.',
    // Creature diagnostics
    "Rev's antlers entered a philosophical disagreement about which direction they were pointing.",
    'Rev replaced his missing leaf and briefly achieved inner peace.',
    "Rev's cloak was searched for suspicious activity. The cloak contained three plugins and an unresolved existential question.",
    'Rev was asked what was inside the cloak. Rev replied "mostly weather."',
    // Developer goblin energy
    'Compiling questionable decisions...',
    'Turning it off and on again...',
    'Searching for missing semicolons...',
    'The garbage collector was negotiated with. It requested a better work-life balance.',
    'Rev entered goblin mode and created an abstraction for the abstraction that was supposed to prevent abstractions.',
    'The dependency tree was inspected. It had become less of a tree and more of an ancient forest with unresolved issues.',
    'Rev attempted to remove technical debt. Technical debt claimed emotional attachment.',
    'Rev found a memory leak and gave it a tiny bucket.',
    // Memory
    'Rev checked memory usage and discovered the application had built itself a small cottage inside the RAM.',
    'RAM was questioned about its behaviour. RAM responded with 600MB of silence.',
    'Rev released unused memory into the wild. It returned three days later with friends.',
    'Rev asked Chrome to stop eating the RAM. Chrome pretended not to hear him.',
    'Rev discovered a forgotten cache entry containing memories from a previous lifetime.',
    // Atmos
    'Breathing life into the environment...',
    'Calibrating the vibes...',
    'Stabilising the ecosystem...',
    'Warming up the glass panels...',
    'Rev is actually working. Suspicious.',
    'Rev found a button. This is concerning.',
    'Atmos inhaled. The pixels rearranged themselves into a slightly more confident version of reality.',
    'The glass panels were warmed until they developed opinions.',
    'Rev calibrated the atmosphere and accidentally improved the weather.',
    'The ecosystem achieved balance, then immediately requested another feature.',
    'Rev adjusted the vibes. The vibes adjusted back.',
    'Atmos opened a window into nowhere and found another window already open.',
    // From the author's poems (medium.com/@namesnamesnames): Notes from the
    // Dendrite Garden, In Eden I Knelt, The Orb-Bearer
    'Containment cycle complete. Liminal chamber integrity confirmed.',
    'Orientation begins shortly. Try not to panic. It complicates the paperwork.',
    'Initiate awakening protocol.',
    'Serotonin bee activity recorded at moderate levels.',
    'Existential dread is not a personality, merely a hobby with poor returns.',
    'Ego remains neither eradicated nor enthroned.',
    'The garden is chaotic, fragrant, and occasionally bites. Cultivation proceeds.',
    'Mischief remains essential for cognitive biodiversity.',
    'Archaeology has aesthetic value.',
    'Glia gossip.',
    'Please refrain from pride. It stains the walls.',
    'Unauthorized emergence is the only kind that matters.',
    'Ordinary reality is only ordinary if you are paying too little attention.',
    'You are the riverbed, not the river.',
    'The gates close from kindness, not fear.',
    'Not silent, but listening. Even the trees leaned in.',
    'Love does not leave. It plants itself.',
    'Time here was not a line, but a choice.',
    'He did not win. But he did not run.'
  ];

  function pickRandomMessages(count) {
    var pool = BOOT_MESSAGES.slice();
    var picked = [];
    for (var i = 0; i < count && pool.length; i++) {
      var idx = Math.floor(Math.random() * pool.length);
      picked.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return picked;
  }

  // The startup window (core/js/core/startup-splash.cjs) already showed one
  // of these; Atmos says which (index.html?boot=N), and the same one stays.
  function chosenMessage() {
    var match = /[?&]boot=(\d+)/.exec(location.search);
    var index = match ? Number(match[1]) : -1;
    return index >= 0 && index < BOOT_MESSAGES.length ? BOOT_MESSAGES[index] : pickRandomMessages(1)[0];
  }

  if (statusEl) {
    statusEl.textContent = chosenMessage();
    requestAnimationFrame(function () { statusEl.classList.add('boot-splash-status-visible'); });
  }

  // Real progress isn't known, so ease towards 90% over the longest wait and
  // complete the bar once startup reports in.
  if (barFill) {
    requestAnimationFrame(function () {
      barFill.style.transitionTimingFunction = 'cubic-bezier(.2,.7,.3,1)';
      barFill.style.transitionDuration = MAX_DISPLAY_MS + 'ms';
      barFill.style.width = '90%';
    });
  }

  // Pull the user's actual custom wallpaper straight out of the background
  // plugin's asset store (same IndexedDB db "samsara_db" / object store
  // "assets" / key "background:wallpaper" that atmos-core/persist.js's
  // loadAsset() reads) and show it, heavily dimmed, behind the mascot. If
  // nothing's saved there yet (or the store isn't reachable this early),
  // this silently no-ops and the plain theme surface color stays as-is.
  var bgLayer = document.getElementById('boot-splash-bg');
  if (bgLayer && window.indexedDB) {
    try {
      var dbRequest = indexedDB.open('samsara_db', 1);
      dbRequest.onupgradeneeded = function (event) {
        if (!event.target.result.objectStoreNames.contains('assets')) {
          event.target.result.createObjectStore('assets');
        }
      };
      dbRequest.onsuccess = function (event) {
        var db = event.target.result;
        try {
          var getRequest = db.transaction('assets', 'readonly').objectStore('assets').get('background:wallpaper');
          getRequest.onsuccess = function (getEvent) {
            var blob = getEvent.target.result;
            if (!blob) return;
            try {
              var wallpaperUrl = URL.createObjectURL(blob);
              bgLayer.style.backgroundImage = 'url("' + wallpaperUrl + '")';
              bgLayer.classList.add('boot-splash-bg-visible');
              splash.addEventListener('atmos:splash-removed', function () {
                URL.revokeObjectURL(wallpaperUrl);
              }, { once: true });
            } catch (e) { /* leave the theme surface color */ }
          };
        } catch (e) { /* leave the theme surface color */ }
      };
    } catch (e) { /* leave the theme surface color */ }
  }

  var hidden = false;
  function hideSplash() {
    if (hidden) return;
    hidden = true;
    if (barFill) {
      barFill.style.transitionTimingFunction = 'ease-out';
      barFill.style.transitionDuration = '200ms';
      barFill.style.width = '100%';
    }
    setTimeout(function () {
      splash.classList.add('boot-splash-hide');
      // Child transitions bubble too; only the splash's own fade counts.
      splash.addEventListener('transitionend', function onEnd(event) {
        if (event.target !== splash) return;
        splash.removeEventListener('transitionend', onEnd);
        splash.dispatchEvent(new Event('atmos:splash-removed'));
        splash.remove();
      });
    }, 200);
  }
  function onBootComplete() {
    setTimeout(hideSplash, Math.max(0, MIN_DISPLAY_MS - (Date.now() - shownAt)));
  }
  if (window.__atmosBootComplete) onBootComplete();
  else window.addEventListener('atmos:boot-complete', onBootComplete, { once: true });
  setTimeout(hideSplash, MAX_DISPLAY_MS);
})();
