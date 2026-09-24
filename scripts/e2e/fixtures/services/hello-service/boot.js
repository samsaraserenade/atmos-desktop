import atmos from 'atmos-sdk';

atmos.expose({
  greet: name => `Hello, ${name}! (from ${atmos.extension.id}, ${location.origin})`,
});
