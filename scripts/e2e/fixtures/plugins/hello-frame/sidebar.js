import atmos from 'atmos-sdk';

const render = state => {
  document.body.innerHTML = `<div style="padding:8px 12px;line-height:1.6">Visits: <b>${state.visits ?? 0}</b><br>A widget running in its own frame.</div>`;
};
render(await atmos.state.get());
atmos.state.onChange(render);
