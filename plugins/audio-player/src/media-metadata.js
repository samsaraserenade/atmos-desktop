/**
 * The Media Metadata library, set up for Audio Player's engine frame: its
 * renderer.js runs here and reaches the service's main-process handlers
 * through the route Audio Player gives it (see services/media-metadata/README.md).
 */
import atmos from 'atmos-sdk';

const metadata = await import(await atmos.library('service:media-metadata', 'renderer.js'));
metadata.setInvoke((channel, ...args) => atmos.invoke('service:media-metadata', channel, ...args));

export const { readTags, writeCoverArt } = metadata;
