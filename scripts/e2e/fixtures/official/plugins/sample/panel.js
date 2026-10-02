import atmos from 'atmos-sdk';

const state = await atmos.state.get();
document.body.innerHTML = '<main style="padding:32px"><h2 style="margin:0;font-weight:500">Sample</h2><p id="starts"></p></main>';
document.getElementById('starts').textContent = `Started ${state.starts ?? 0} time(s)`;
