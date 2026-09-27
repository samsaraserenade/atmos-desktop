import { registerBootHook } from 'atmos-core/core/boot-registry.js';
import { provideCapability } from 'atmos-core/core/renderer-capabilities.js';
import { audioApi } from './engine.js';

// Before any extension's boot hook, so their restores find it.
registerBootHook('audio', {
  order: -90,
  run(context) {
    context.onCleanup(provideCapability('media.audio', audioApi, { owner: 'audio' }));
  },
});
