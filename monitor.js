const fs = require('node:fs');
const E = require('./engine');
const webpush = require('web-push');

const file = 'state.json';

let state = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : { items: {}, history: [] };

const live = process.env.SEND_ALERTS === 'true';

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

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

      if (permanent || attempt === 3) {
        return false;
      }

      await sleep(attempt * 2000);
    }
  }

  return false;
}

async function notify(title, body) {
  if (!live) {
    console.log('TEST MODE:', title);
    return;
  }

  const results = await Promise.all([
    retry('TELEGRAM', async () => {
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
    }),

    retry('MOBILE PUSH', async () => {
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
    })
  ]);

  if (!results[0] || !results[1]) {
    console.error(
      'Delivery summary:',
      'Telegram:', results[0] ? 'OK' : 'FAILED',
      'Mobile:', results[1] ? 'OK' : 'FAILED'
    );

    process.exitCode = 1;
  }
}

async function main() {
  console.log('BTC EMA PRO V6 Monitor');
  console.log('Live notifications:', live);

  for (const symbol of E.markets) {
    let trend;

    try {
      trend = E.analyze(
        await E.candles(symbol, '15m'),
        '15m',
        0
      ).trend;
    } catch {
      console.error(symbol, 'trend unavailable');
      process.exitCode = 1;
      continue;
    }

    for (const tf of Object.keys(E.frames)) {
      const key = symbol + ' ' + tf;

      try {
        const a = E.analyze(
          await E.candles(symbol, tf),
          tf,
          trend
        );

        const old = state.items[key] || {};

        if (old.time === a.time) continue;

        let pos = old.position || null;
        const events = [];

        if (pos) {
          if ((a.price - pos.stop) * pos.dir <= 0) {
            events.push('EXIT STOP');
            pos = null;

          } else if (
            (a.price - pos.targets[2]) * pos.dir >= 0
          ) {
            events.push('EXIT 3R');
            pos = null;

          } else {
            for (let j = 0; j < 2; j++) {
              if (
                (a.price - pos.targets[j]) * pos.dir >= 0 &&
                !pos.hit.includes(j)
              ) {
                pos.hit.push(j);
                events.push('TARGET ' + (j + 1) + 'R');
              }
            }
          }
        }

        if (
          a.signalDir &&
          (!pos || pos.dir !== a.signalDir)
        ) {
          if (pos) events.push('EXIT REVERSE');

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
            a.signalDir === 1 ? 'BUY' : 'SELL'
          );
        }

        if (a.orb) events.push(a.orb);

        state.items[key] = {
          ...a,
          position: pos
        };

        if (events.length) {
          const body =
            key + ' | $' + a.price + '\n' +
            (
              pos
                ? `Entry ${pos.entry.toFixed(2)} ` +
                  `SL ${pos.stop.toFixed(2)} ` +
                  `Targets ${pos.targets.map(
                    x => x.toFixed(2)
                  ).join(' / ')}`
                : ''
            );

          state.history.unshift({
            key,
            time: a.time,
            events,
            body
          });

          console.log(key, events.join(' / '));

          await notify(
            'V6 ' + events.join(' / '),
            body
          );
        }

        state.history = state.history.slice(0, 300);

        fs.writeFileSync(
          file,
          JSON.stringify(state)
        );

      } catch (err) {
        console.error(key, 'Analysis or state error');
        process.exitCode = 1;
      }
    }
  }

  console.log('Monitoring completed');
}

main().catch(() => {
  console.error('Monitor execution failed');
  process.exitCode = 1;
});
