
const fs = require('node:fs');
const path = require('node:path');
const E = require('./engine');
const L = require('./levels');
const cfg = require('./config.json');
const webpush = require('web-push');

const live = process.env.SEND_ALERTS === 'true';
const testMode = process.env.NOTIFICATION_TEST === 'true';

const file = process.env.STATE_FILE ||
  (live ? 'state.json' : 'state-test.json');

const persist =
  live || process.env.DRY_RUN_SAVE === 'true';

if (!live && path.basename(file).toLowerCase() === 'state.json') {
  throw Error('Dry run must use separate state');
}

if (testMode && (!live || file !== 'state-notification-test.json')) {
  throw Error('Notification test requires isolated live test state');
}

let state = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : { items: {}, history: [] };

if (live && state.dryRun === true) {
  throw Error('Refusing dry-run state in live mode');
}

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const fmt = value =>
  Number.isFinite(value) ? value.toFixed(2) : 'N/A';

const trendLabel = value =>
  value === 1 ? 'BULLISH' :
  value === -1 ? 'BEARISH' : 'NEUTRAL';

function save() {
  if (persist) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(state));
    fs.renameSync(file + '.tmp', file);
  }
}

async function retry(channel, fn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fn();
      console.log(channel + ': SUCCESS');
      return true;
    } catch (err) {
      const status = Number(err.statusCode || 0);

      console.error(
        channel + ': FAILED',
        'Attempt:', attempt,
        'Status:', status || 'Network/configuration'
      );

      const permanent =
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429;

      if (status === 410 && channel === 'MOBILE PUSH') {
        console.error('Mobile push subscription expired');
      }

      if (permanent || attempt === 3) {
        return false;
      }

      await sleep(attempt * 2000);
    }
  }

  return false;
}

async function notify(title, body, delivery = {}) {
  if (!live) {
    console.log('TEST MODE:', title);
    return true;
  }

  const results = await Promise.all([
    delivery.telegram ? true : retry('TELEGRAM', async () => {
      const response = await fetch(
        'https://api.telegram.org/bot' +
        process.env.TELEGRAM_BOT_TOKEN +
        '/sendMessage',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: title + '\n' + body
          }),
          signal: AbortSignal.timeout(20000)
        }
      );

      const data = await response.json();

      if (!response.ok || !data.ok) {
        const error = new Error('Telegram failed');
        error.statusCode =
          data.error_code || response.status;
        throw error;
      }

      delivery.telegram = true;
      save();
    }),

    delivery.push ? true : retry('MOBILE PUSH', async () => {
      webpush.setVapidDetails(
        'https://asstrades-ship-it.github.io/btc-ema-pro-v6/',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );

      const subscription = JSON.parse(
        process.env.WEB_PUSH_SUBSCRIPTION
      );

      await webpush.sendNotification(
        subscription,
        JSON.stringify({
          title,
          body,
          url: 'https://asstrades-ship-it.github.io/btc-ema-pro-v6/'
        }),
        {
          TTL: 300,
          timeout: 20000
        }
      );

      delivery.push = true;
      save();
    })
  ]);

  delivery.telegram = results[0];
  delivery.push = results[1];

  if (!results[0] || !results[1]) {
    console.error(
      'Delivery summary:',
      'Telegram:', results[0] ? 'OK' : 'FAILED',
      'Mobile:', results[1] ? 'OK' : 'FAILED'
    );

    process.exitCode = 1;
  }

  return results.every(Boolean);
}

async function flush() {
  state.outbox ||= {};

  for (const [id, msg] of Object.entries(state.outbox)) {
    if (
      !msg.createdAt ||
      Date.now() - msg.createdAt > 30 * 60000
    ) {
      console.log('Expired pending alert', id);
      delete state.outbox[id];
      save();
      continue;
    }

    msg.delivery ||= {};

    if (await notify(msg.title, msg.body, msg.delivery)) {
      delete state.outbox[id];
    }

    save();
  }
}

async function enqueue(id, title, body) {
  state.outbox ||= {};

  state.outbox[id] ||= {
    title,
    body,
    delivery: {},
    createdAt: Date.now()
  };

  save();
}

async function main() {
  console.log('BTC EMA PRO V6.1 Stage 9 Monitor');

  state.items ||= {};
  state.history ||= [];
  state.checkpoints ||= {};
  state.outbox ||= {};
  state.errors = [];

  console.log('Live notifications:', live);

  await flush();

  for (const symbol of cfg.markets) {
    let trendRows, daily, intra;

    try {
      [trendRows, daily, intra] = await Promise.all(
        ['15m', '1d', '5m'].map(t =>
          E.candles(symbol, t, { allowStale: true })
        )
      );

      E.analyze(trendRows, '15m', 0);

    } catch {
      state.errors.push(symbol + ' trend unavailable');
      console.error(symbol, 'trend unavailable');
      process.exitCode = 1;
      continue;
    }

    for (const cp of L.checkpoints(
      intra,
      Math.floor(Date.now() / 1000)
    )) {
      const id = symbol + ' ' + cp.end;

      if (
        cp.status === 'PENDING' ||
        cp.status === 'DATA UNAVAILABLE' ||
        state.checkpoints[id] ||
        Date.now() / 1000 - cp.end > 900
      ) {
        continue;
      }

      await enqueue(
        'checkpoint ' + id,
        'V6.1 ' + cp.n + 'm direction',
        symbol + ' | ' + cp.status + ' | informational only'
      );

      state.checkpoints[id] = true;
      save();
    }

    const timeframes =
      cfg.mode === 'all'
        ? Object.keys(E.frames)
        : [cfg.mode === 'fixed' ? '15m' : cfg.entry];

    for (const tf of timeframes) {
      const key = symbol + ' ' + tf;

      try {
        const rows =
          tf === '5m' ? intra :
          tf === '15m' ? trendRows :
          tf === '1d' ? daily :
          await E.candles(symbol, tf, {
            allowStale: true
          });

        if (rows.length < 200) {
          state.errors.push(key + ' insufficient history');
          continue;
        }

        const expected =
          Math.floor(
            (Date.now() / 1000 - 5) / E.frames[tf]
          ) * E.frames[tf] - E.frames[tf];

        if (rows.at(-1).time !== expected) {
          state.errors.push(
            key + ' stale or closed; alerts paused'
          );
          continue;
        }

        const prior = state.items[key] || {};

        const pending = rows
          .map((r, i) => i)
          .filter(i =>
            i >= 199 &&
            rows[i].time + E.frames[tf] >=
              Date.now() / 1000 - 86400 &&
            rows[i].time >
              (prior.time ?? rows.at(-2).time)
          );

        for (const i of pending) {
          const t = rows[i].time + E.frames[tf];

          const tr = trendRows.filter(
            r => r.time + 900 <= t
          );

          if (
            tr.length < 50 ||
            t - (tr.at(-1).time + 900) >= 900 ||
            !tr.slice(-50).every(
              (r, j, arr) =>
                !j || r.time - arr[j - 1].time === 900
            )
          ) {
            continue;
          }

          const a = L.evaluate(
            rows.slice(0, i + 1),
            tf,
            E.analyze(tr, '15m', 0).trend,
            L.context(daily, intra, t - 1),
            cfg
          );

          const old = state.items[key] || {};

          let pos = old.position || null;

          const previousPosition = pos
            ? JSON.parse(JSON.stringify(pos))
            : null;

          const events = (a.falseBreakouts || [])
            .map(x => 'FALSE BREAKOUT ' + x.name);

          const candle = rows[i];

          if (pos && !Array.isArray(pos.hit)) {
            pos.hit = [];
          }

          if (pos) {
            const stopHit =
              (
                (pos.dir === 1
                  ? candle.low
                  : candle.high) - pos.stop
              ) * pos.dir <= 0;

            const finalTargetHit =
              (
                (pos.dir === 1
                  ? candle.high
                  : candle.low) - pos.targets[2]
              ) * pos.dir >= 0;

            if (stopHit) {
              events.push('EXIT STOP');
              pos = null;

            } else if (finalTargetHit) {
              for (let j = 0; j < 2; j++) {
                if (!pos.hit.includes(j)) {
                  events.push('TARGET ' + (j + 1) + 'R');
                }
              }

              events.push('EXIT 3R');
              pos = null;

            } else {
              for (let j = 0; j < 2; j++) {
                const targetHit =
                  (
                    (pos.dir === 1
                      ? candle.high
                      : candle.low) - pos.targets[j]
                  ) * pos.dir >= 0;

                if (targetHit && !pos.hit.includes(j)) {
                  pos.hit.push(j);
                  events.push('TARGET ' + (j + 1) + 'R');
                }
              }
            }
          }

          if (
            a.signalDir &&
            Number.isFinite(a.atr) &&
            a.atr > 0 &&
            (!pos || pos.dir !== a.signalDir)
          ) {
            if (pos) {
              events.push('EXIT REVERSE');
            }

            const risk = a.atr * 1.5;

            pos = {
              dir: a.signalDir,
              entry: a.price,
              stop: a.price - a.signalDir * risk,
              targets: [1, 2, 3].map(
                n => a.price + a.signalDir * risk * n
              ),
              hit: []
            };

            events.push(
              a.strength + ' ' +
              (a.signalDir === 1 ? 'BUY' : 'SELL')
            );
          }

          state.items[key] = {
            ...a,
            position: pos
          };

          if (events.length) {
            let body =
              key + ' | $' + fmt(a.price);

            if (
              previousPosition &&
              events.some(e => e.startsWith('EXIT'))
            ) {
              const exitPrice =
                events.includes('EXIT STOP')
                  ? previousPosition.stop
                  : events.includes('EXIT 3R')
                    ? previousPosition.targets[2]
                    : a.price;

              body +=
                '\nPrevious entry ' +
                fmt(previousPosition.entry) +
                ' | SL ' +
                fmt(previousPosition.stop) +
                ' | Targets ' +
                previousPosition.targets.map(fmt).join(' / ') +
                ' | Exit reference ' +
                fmt(exitPrice);
            }

            body +=
              '\n15m trend: ' +
              trendLabel(a.mainTrend) +
              ' | ' +
              a.matched.map(x => x.name).join(', ') +
              '\n';

            if (pos) {
              body +=
                'Entry ' + fmt(pos.entry) +
                ' SL ' + fmt(pos.stop) +
                ' Targets ' +
                pos.targets.map(fmt).join(' / ');
            }

            state.history.unshift({
              key,
              time: a.time,
              events,
              body
            });

            console.log(key, events.join(' / '));

            await enqueue(
              key + ' ' + a.time,
              'V6.1 ' + events.join(' / '),
              body
            );
          }

          state.history = state.history.slice(0, 300);
          save();
        }

      } catch (err) {
        state.errors.push(key + ' analysis or state error');
        console.error(key, 'Analysis or state error');
        process.exitCode = 1;
      }
    }
  }

  await flush();

  state.lastRun = new Date().toISOString();
  state.dryRun = !live;

  save();

  console.log('Monitoring completed');
}

// ISOLATED NOTIFICATION TEST

async function notificationTest() {
  if (!live) {
    throw Error('SEND_ALERTS must be true');
  }

  if (file !== 'state-notification-test.json') {
    throw Error('Notification test requires isolated state');
  }

  const title = 'BTC EMA PRO V6.1 - TEST ONLY';

  const body =
    'Background notification test\n' +
    'Telegram and Mobile Push\n' +
    'Time: ' +
    new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata'
    }) +
    ' IST\n' +
    'No trading signal. No order placed.';

  console.log('Starting V6.1 notification test');

  state.notificationTest = {
    startedAt: new Date().toISOString(),
    delivery: {}
  };

  save();

  const success = await notify(
    title,
    body,
    state.notificationTest.delivery
  );

  state.notificationTest.success = success;
  state.notificationTest.completedAt =
    new Date().toISOString();

  save();

  if (!success) {
    throw Error('Notification delivery incomplete');
  }

  console.log('V6.1 NOTIFICATION TEST PASSED');
}

// START MONITOR OR NOTIFICATION TEST

if (require.main === module) {
  const task = testMode
    ? notificationTest()
    : main();

  task.catch(() => {
    console.error('Monitor execution failed');
    process.exitCode = 1;
  });
}
