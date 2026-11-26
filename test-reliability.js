
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, 'monitor.js'),
  'utf8'
);

const NOW = 1800000000000;

let telegramCalls = 0;
let pushCalls = 0;
let failTelegram = false;
let failPush = false;

const mockState = {
  items: {},
  history: [],
  outbox: {},
  checkpoints: {},
  errors: []
};

class TestDate extends Date {
  static now() {
    return NOW;
  }
}

const mockWebPush = {
  setVapidDetails() {},

  async sendNotification() {
    pushCalls++;

    if (failPush) {
      const error = new Error('Simulated push failure');
      error.statusCode = 410;
      throw error;
    }
  }
};

const mockFS = {
  existsSync() {
    return true;
  },

  readFileSync() {
    return JSON.stringify(mockState);
  },

  writeFileSync() {},
  renameSync() {}
};

const sandbox = {
  console,

  Date: TestDate,

  AbortSignal,

  setTimeout: fn => {
    fn();
    return 0;
  },

  process: {
    env: {
      SEND_ALERTS: 'true',
      STATE_FILE: 'state-reliability-test.json',
      TELEGRAM_BOT_TOKEN: 'MOCK',
      TELEGRAM_CHAT_ID: 'MOCK',
      VAPID_PUBLIC_KEY: 'MOCK',
      VAPID_PRIVATE_KEY: 'MOCK',
      WEB_PUSH_SUBSCRIPTION: '{}'
    },
    exitCode: 0
  },

  fetch: async () => {
    telegramCalls++;

    return {
      ok: !failTelegram,
      status: failTelegram ? 400 : 200,

      async json() {
        return {
          ok: !failTelegram,
          error_code: failTelegram ? 400 : undefined
        };
      }
    };
  },

  require(name) {
    if (name === 'node:fs') return mockFS;
    if (name === 'node:path') return path;
    if (name === 'web-push') return mockWebPush;

    if (
      name === './engine' ||
      name === './levels' ||
      name === './config.json'
    ) {
      return {};
    }

    throw Error('Unexpected module: ' + name);
  },

  module: {}
};

vm.createContext(sandbox);

vm.runInContext(
  source + `
    globalThis.testAPI = {
      state,
      enqueue,
      flush,
      notify,
      alertAge
    };
  `,
  sandbox
);

const api = sandbox.testAPI;

const nowSeconds = NOW / 1000;

function reset() {
  telegramCalls = 0;
  pushCalls = 0;

  failTelegram = false;
  failPush = false;

  api.state.outbox = {};
  sandbox.process.exitCode = 0;
}

async function run() {
  console.log('V6.1 ADVANCED RELIABILITY TESTS');

  // TEST 1: FRESH ALERT

  reset();

  await api.enqueue(
    'fresh',
    'TEST',
    'Fresh alert',
    nowSeconds - 300
  );

  assert.ok(api.state.outbox.fresh);

  await api.flush();

  assert.equal(telegramCalls, 1);
  assert.equal(pushCalls, 1);
  assert.equal(
    Object.keys(api.state.outbox).length,
    0
  );

  console.log('PASS 1: Fresh alert delivery');

  // TEST 2: HISTORICAL ALERT

  reset();

  await api.enqueue(
    'historical',
    'TEST',
    'Old alert',
    nowSeconds - 1800
  );

  await api.flush();

  assert.equal(telegramCalls, 0);
  assert.equal(pushCalls, 0);
  assert.equal(
    Object.keys(api.state.outbox).length,
    0
  );

  console.log('PASS 2: Historical alert blocked');

  // TEST 3: DUPLICATE QUEUE PROTECTION

  reset();

  await api.enqueue(
    'duplicate',
    'TEST',
    'Duplicate alert',
    nowSeconds - 60
  );

  await api.enqueue(
    'duplicate',
    'TEST',
    'Duplicate alert',
    nowSeconds - 60
  );

  assert.equal(
    Object.keys(api.state.outbox).length,
    1
  );

  await api.flush();
  await api.flush();

  assert.equal(telegramCalls, 1);
  assert.equal(pushCalls, 1);

  console.log('PASS 3: Duplicate queue protection');

  // TEST 4: MOBILE PUSH FAILURE AND RECOVERY

  reset();

  failPush = true;

  await api.enqueue(
    'partial-push',
    'TEST',
    'Partial delivery',
    nowSeconds - 60
  );

  await api.flush();

  assert.equal(telegramCalls, 1);
  assert.equal(pushCalls, 1);

  assert.equal(
    api.state.outbox['partial-push'].delivery.telegram,
    true
  );

  assert.equal(
    api.state.outbox['partial-push'].delivery.push,
    false
  );

  failPush = false;

  await api.flush();

  assert.equal(telegramCalls, 1);
  assert.equal(pushCalls, 2);

  assert.equal(
    Object.keys(api.state.outbox).length,
    0
  );

  console.log('PASS 4: Mobile push recovery');

  // TEST 5: TELEGRAM FAILURE AND RECOVERY

  reset();

  failTelegram = true;

  await api.enqueue(
    'partial-telegram',
    'TEST',
    'Partial delivery',
    nowSeconds - 60
  );

  await api.flush();

  assert.equal(telegramCalls, 1);
  assert.equal(pushCalls, 1);

  failTelegram = false;

  await api.flush();

  assert.equal(telegramCalls, 2);
  assert.equal(pushCalls, 1);

  assert.equal(
    Object.keys(api.state.outbox).length,
    0
  );

  console.log('PASS 5: Telegram recovery');

  // TEST 6: EXPIRED SIGNAL

  reset();

  api.state.outbox.expired = {
    title: 'TEST',
    body: 'Expired signal',
    createdAt: NOW - 60000,
    signalCloseTime: nowSeconds - 1800,
    delivery: {}
  };

  await api.flush();

  assert.equal(telegramCalls, 0);
  assert.equal(pushCalls, 0);

  assert.equal(
    Object.keys(api.state.outbox).length,
    0
  );

  console.log('PASS 6: Expired signal removed');

  // TEST 7: EXPIRED PENDING QUEUE

  reset();

  api.state.outbox.oldQueue = {
    title: 'TEST',
    body: 'Expired queue',
    createdAt: NOW - 31 * 60000,
    signalCloseTime: nowSeconds - 60,
    delivery: {}
  };

  await api.flush();

  assert.equal(telegramCalls, 0);
  assert.equal(pushCalls, 0);

  assert.equal(
    Object.keys(api.state.outbox).length,
    0
  );

  console.log('PASS 7: Expired pending queue removed');

  // TEST 8: LEGACY PENDING NOTIFICATION

  reset();

  api.state.outbox.legacy = {
    title: 'TEST',
    body: 'Legacy notification',
    createdAt: NOW - 60000,
    delivery: {}
  };

  await api.flush();

  assert.equal(telegramCalls, 0);
  assert.equal(pushCalls, 0);

  assert.equal(
    Object.keys(api.state.outbox).length,
    0
  );

  console.log('PASS 8: Legacy pending alert discarded');

  // TEST 9: FRESHNESS BOUNDARY

  reset();

  await api.enqueue(
    'boundary-valid',
    'TEST',
    'Exactly 15 minutes',
    nowSeconds - 900
  );

  await api.enqueue(
    'boundary-invalid',
    'TEST',
    'Over 15 minutes',
    nowSeconds - 901
  );

  assert.ok(
    api.state.outbox['boundary-valid']
  );

  assert.equal(
    api.state.outbox['boundary-invalid'],
    undefined
  );

  await api.flush();

  assert.equal(telegramCalls, 1);
  assert.equal(pushCalls, 1);

  console.log('PASS 9: Alert freshness boundary');

  console.log('');
  console.log('ALL 9 RELIABILITY TESTS PASSED');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
