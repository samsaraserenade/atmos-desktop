const http = require('http');
const fs = require('fs');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson('http://127.0.0.1:9222/json');
  const page = targets.find(target => target.type === 'page' && target.url.startsWith('atmos-app://'));
  if (!page) throw new Error('Atmos renderer target not found');

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const runtimeErrors = [];
  let nextId = 1;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails?.text || 'Runtime exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      runtimeErrors.push(message.params.args.map(arg => arg.value || arg.description || '').join(' '));
    }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await call('Runtime.enable');
  await call('Page.enable');

  const report = await evaluate(`(async () => ({
    readyState: document.readyState,
    title: document.title,
    plugins: (await window.atmosCore.listPlugins()).map(item => item.id),
    services: (await window.atmosCore.listServices()).map(item => item.id),
    sidebar: [...document.querySelectorAll('.fin-section')].map(el => ({ id: el.id, label: el.querySelector('.fin-section-name')?.textContent?.trim(), visible: getComputedStyle(el).display !== 'none' })),
    panel: { contentChildren: document.querySelector('#panel-content')?.childElementCount },
    extensionStyles: [...document.querySelectorAll('style[data-extension-style]')].map(el => el.dataset.extensionStyle),
  }))()`);

  await evaluate(`(async () => { document.querySelector('#acc-plugin-settings')?.click(); await new Promise(r => setTimeout(r, 150)); })()`);
  report.settings = await evaluate(`({
    open: document.querySelector('#settings-menu')?.classList.contains('open'),
    nav: [...document.querySelectorAll('.sm-nav-label')].map(el => el.textContent.trim()),
    aboutVisible: !!document.querySelector('.sm-home'),
  })`);

  report.settingsPages = await evaluate(`(async () => {
    const output = {};
    const items = [...document.querySelectorAll('.sm-nav-item')];
    for (const item of items) {
      const label = item.querySelector('.sm-nav-label')?.textContent?.trim();
      if (!label || ['About', 'Sidebar', 'Panels'].includes(label)) continue;
      item.click(); await new Promise(r => setTimeout(r, 40));
      const cards = [...document.querySelectorAll('#settings-menu-list .sm-card')];
      output[label] = cards.map(card => ({
        name: card.querySelector('.sm-card-name')?.textContent?.trim(),
        enabled: card.querySelector('input[type="checkbox"]')?.checked,
      }));
    }
    return output;
  })()`);

  report.panels = await evaluate(`(async () => {
    const panelsNav = [...document.querySelectorAll('.sm-nav-item')].find(el => el.querySelector('.sm-nav-label')?.textContent.trim() === 'Panels');
    panelsNav?.click(); await new Promise(r => setTimeout(r, 80));
    let cards = [...document.querySelectorAll('#settings-menu-list .sm-card')];
    const original = cards.find(card => card.classList.contains('open'))?.querySelector('.sm-card-name')?.textContent.trim();
    const results = [];
    for (const name of cards.map(card => card.querySelector('.sm-card-name')?.textContent.trim())) {
      cards = [...document.querySelectorAll('#settings-menu-list .sm-card')];
      const card = cards.find(item => item.querySelector('.sm-card-name')?.textContent.trim() === name);
      card?.querySelector('.sm-card-main')?.click(); await new Promise(r => setTimeout(r, 100));
      results.push({ name, active: [...document.querySelectorAll('#settings-menu-list .sm-card')].some(item => item.classList.contains('open') && item.querySelector('.sm-card-name')?.textContent.trim() === name), contentChildren: document.querySelector('#panel-content')?.childElementCount });
    }
    cards = [...document.querySelectorAll('#settings-menu-list .sm-card')];
    cards.find(item => item.querySelector('.sm-card-name')?.textContent.trim() === original)?.querySelector('.sm-card-main')?.click();
    document.querySelector('#settings-menu-close')?.click();
    return { original, results };
  })()`);

  await new Promise(resolve => setTimeout(resolve, 250));
  report.runtimeErrors = runtimeErrors;
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('.smoke-screen.png', Buffer.from(screenshot.data, 'base64'));
  console.log(JSON.stringify(report, null, 2));
  socket.close();
})().catch(error => { console.error(error); process.exit(1); });
