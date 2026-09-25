// A tiny Matrix homeserver for matrix-chat.cjs: enough of the client-server
// API for matrix-js-sdk to log in, sync one room, send, react and redact,
// with the Rust crypto's key uploads accepted and ignored. Everything it is
// asked is recorded in `requests`; `deliver(event)` puts an event from
// someone else into the next sync.
const http = require('http');

function createHomeserver() {
  const requests = [];
  const pending = [];
  const waiters = new Set();
  let batch = 1;
  let eventCounter = 0;
  const roomId = '!room:test';
  const self = '@tester:test';
  const other = '@friend:test';
  const tokens = new Map([['tester-token', self]]);
  const now = () => Date.now();
  const event = (type, content, sender = self, extra = {}) => ({
    type, content, sender, event_id: `$e${++eventCounter}`, origin_server_ts: now(), room_id: roomId, ...extra,
  });
  const state = [
    event('m.room.create', { creator: self, room_version: '10' }, self, { state_key: '' }),
    event('m.room.member', { membership: 'join', displayname: 'Tester' }, self, { state_key: self }),
    event('m.room.member', { membership: 'join', displayname: 'Friend' }, other, { state_key: other }),
    event('m.room.power_levels', { users: { [self]: 100, [other]: 50 }, events_default: 0, redact: 50, state_default: 50 }, self, { state_key: '' }),
    event('m.room.name', { name: 'Test Room' }, self, { state_key: '' }),
    event('m.room.join_rules', { join_rule: 'invite' }, self, { state_key: '' }),
  ];
  const history = [event('m.room.message', { msgtype: 'm.text', body: 'Hello from the fake homeserver' }, other)];

  function deliver(item) {
    pending.push(item);
    for (const wake of [...waiters]) wake();
  }

  function roomSync(timeline, withState) {
    return {
      rooms: {
        join: {
          [roomId]: {
            state: { events: withState ? state : [] },
            timeline: { events: timeline, limited: false, prev_batch: 'p0' },
            ephemeral: { events: [] },
            account_data: { events: [] },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
            summary: { 'm.joined_member_count': 2, 'm.invited_member_count': 0, 'm.heroes': [other] },
          },
        },
      },
    };
  }

  const pushRules = {
    global: {
      override: [], content: [], room: [], sender: [],
      underride: [{
        rule_id: '.m.rule.message', default: true, enabled: true,
        conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
        actions: ['notify'],
      }],
    },
  };

  async function handle(request, body) {
    const url = new URL(request.url, 'http://localhost');
    const route = url.pathname.replace(/^\/_matrix\/client\/(?:v3|r0|v1)/, '');
    const auth = (request.headers.authorization || '').replace(/^Bearer /, '');
    const user = tokens.get(auth);
    requests.push({ method: request.method, path: url.pathname, auth, body: body.length ? tryJson(body) : null });

    if (url.pathname === '/_matrix/client/versions') return [200, { versions: ['v1.1', 'v1.5', 'v1.10', 'v1.11'], unstable_features: {} }];
    if (url.pathname === '/.well-known/matrix/client') return [404, { errcode: 'M_NOT_FOUND' }];
    if (route === '/login' && request.method === 'GET') return [200, { flows: [{ type: 'm.login.password' }] }];
    if (route === '/login' && request.method === 'POST') {
      const login = tryJson(body);
      if (login?.password !== 'secret') return [403, { errcode: 'M_FORBIDDEN', error: 'Invalid password' }];
      return [200, { user_id: self, access_token: 'tester-token', device_id: login.device_id || 'NEWDEVICE', home_server: 'test' }];
    }
    if (route === '/logout' && request.method === 'POST') {
      tokens.delete(auth);
      return [200, {}];
    }
    if (!user) return [401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.' }];

    if (route === '/capabilities') return [200, { capabilities: {} }];
    if (route === '/pushrules/' || route === '/pushrules') return [200, pushRules];
    if (/^\/user\/[^/]+\/filter$/.test(route)) return [200, { filter_id: '1' }];
    if (/^\/user\/[^/]+\/filter\//.test(route)) return [200, {}];
    if (route === '/sync') {
      const since = url.searchParams.get('since');
      if (!since) {
        return [200, { next_batch: `s${++batch}`, ...roomSync(history, true), account_data: { events: [] }, presence: { events: [] }, to_device: { events: [] }, device_lists: { changed: [], left: [] }, device_one_time_keys_count: { signed_curve25519: 50 } }];
      }
      const timeout = Math.min(Number(url.searchParams.get('timeout')) || 0, 1500);
      if (!pending.length && timeout) {
        await new Promise(resolve => {
          const wake = () => { waiters.delete(wake); clearTimeout(timer); resolve(); };
          const timer = setTimeout(wake, timeout);
          waiters.add(wake);
        });
      }
      const timeline = pending.splice(0).map(item => ({ ...item, event_id: item.event_id || `$e${++eventCounter}`, origin_server_ts: now(), room_id: roomId }));
      history.push(...timeline);
      return [200, { next_batch: `s${++batch}`, ...(timeline.length ? roomSync(timeline, false) : {}), device_one_time_keys_count: { signed_curve25519: 50 } }];
    }
    let match = route.match(/^\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/);
    if (match && request.method === 'PUT') {
      const sent = event(decodeURIComponent(match[2]), tryJson(body), user, { unsigned: { transaction_id: decodeURIComponent(match[3]) } });
      deliver(sent);
      return [200, { event_id: sent.event_id }];
    }
    match = route.match(/^\/rooms\/([^/]+)\/redact\/([^/]+)\/([^/]+)$/);
    if (match && request.method === 'PUT') {
      const redaction = event('m.room.redaction', tryJson(body) || {}, user, { redacts: decodeURIComponent(match[2]) });
      deliver(redaction);
      return [200, { event_id: redaction.event_id }];
    }
    if (/^\/rooms\/[^/]+\/messages$/.test(route)) return [200, { chunk: [], start: url.searchParams.get('from') || 'p0' }];
    if (/^\/rooms\/[^/]+\/members$/.test(route)) return [200, { chunk: state.filter(item => item.type === 'm.room.member') }];
    if (/^\/rooms\/[^/]+\/joined_members$/.test(route)) return [200, { joined: { [self]: { display_name: 'Tester' }, [other]: { display_name: 'Friend' } } }];
    if (/^\/rooms\/[^/]+\/(receipt|read_markers|typing)/.test(route)) return [200, {}];
    if (/^\/rooms\/[^/]+\/state$/.test(route)) return [200, state];
    if (/^\/rooms\/[^/]+\/event\//.test(route)) return [404, { errcode: 'M_NOT_FOUND' }];
    if (/^\/profile\//.test(route)) return [200, { displayname: user === self ? 'Tester' : 'Friend' }];
    if (/^\/user\/[^/]+\/account_data\//.test(route)) return request.method === 'PUT' ? [200, {}] : [404, { errcode: 'M_NOT_FOUND' }];
    if (route === '/keys/upload') return [200, { one_time_key_counts: { signed_curve25519: 50 } }];
    if (route === '/keys/query') {
      const users = Object.keys(tryJson(body)?.device_keys || {});
      return [200, { device_keys: Object.fromEntries(users.map(id => [id, {}])), failures: {} }];
    }
    if (route === '/keys/claim') return [200, { one_time_keys: {}, failures: {} }];
    if (route.startsWith('/room_keys/')) return [404, { errcode: 'M_NOT_FOUND', error: 'No backup' }];
    if (route.startsWith('/sendToDevice/')) return [200, {}];
    if (route === '/joined_rooms') return [200, { joined_rooms: [roomId] }];
    if (route === '/voip/turnServer') return [200, {}];
    if (route.startsWith('/media/config') || url.pathname.includes('/media/')) return [404, { errcode: 'M_NOT_FOUND' }];
    return [404, { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' }];
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const [status, json] = await handle(request, Buffer.concat(chunks));
        const record = requests.at(-1);
        if (record && record.path === new URL(request.url, 'http://localhost').pathname) record.status = status;
        response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        response.end(JSON.stringify(json));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ errcode: 'M_UNKNOWN', error: error.message }));
      }
    });
  });

  return {
    requests, roomId, self, other,
    /** An old device's token the in-page version saved. */
    addToken(token, user = self) { tokens.set(token, user); },
    deliver: item => deliver({ ...item, sender: item.sender || other }),
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(resolve => { for (const wake of [...waiters]) wake(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

function tryJson(buffer) {
  try { return JSON.parse(String(buffer)); } catch { return null; }
}

module.exports = { createHomeserver };
