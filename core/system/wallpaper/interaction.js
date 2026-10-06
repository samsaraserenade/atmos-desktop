// What's behind the wallpaper: the theme's workspace colour (light with
// Atmos Light), on the body, so a removed wallpaper or one still loading
// shows that and never the window's own colour.
let active = false;
let previousRootBackground = '';
let previousBodyBackground = '';

export function applyWallpaperPresentation() {
  if (!active) return;
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'rgb(var(--workspace-rgb, 0,0,0))';
}

export async function mountWallpaperInteraction(context) {
  if (active) return;
  active = true;
  previousRootBackground = document.documentElement.style.background;
  previousBodyBackground = document.body.style.background;
  context.onCleanup(() => {
    active = false;
    document.documentElement.style.background = previousRootBackground;
    document.body.style.background = previousBodyBackground;
  });
  applyWallpaperPresentation();
}
