const fs = require('node:fs');
const E = require('./engine');
const L = require('./levels');
const cfg = require('./config.json');
const webpush = require('web-push');

const live = process.env.SEND_ALERTS === 'true';
const file = process.env.STATE_FILE || (live ? 'state.json' : 'state-test.json');
if (!live && require('node:path').basename(file).toLowerCase() === 'state.json') throw Error('Dry run must use separate state');
const persist = process.env.SEND_ALERTS === 'true' || process.env.DRY_RUN_SAVE === 'true';

let state = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : { items: {}, history: [] };

if (live && state.dryRun === true) throw Error('Refusing dry-run state in live mode');

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
      delivery.telegram=true;save();
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
      delivery.push=true;save();
    })
  ]);

  delivery.telegram = results[0]; delivery.push = results[1];
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

function save(){if(persist){fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file);}}
async function flush(){for(const [id,msg] of Object.entries(state.outbox)){if(!msg.createdAt || Date.now()-msg.createdAt>30*60000){console.log("Expired pending alert",id);delete state.outbox[id];save();continue;}if(await notify(msg.title,msg.body,msg.delivery))delete state.outbox[id];save();}}
async function enqueue(id,title,body){state.outbox[id] ||= {title,body,delivery:{},createdAt:Date.now()};save();}
async function main() {
  console.log('BTC EMA PRO V6.1 Stage 9 Monitor'); state.items ||= {}; state.history ||= []; state.errors=[];
  console.log('Live notifications:', live);
  state.outbox ||= {}; await flush();

  for (const symbol of cfg.markets) {
    let trend, trendRows, daily, intra;

    try {
      [trendRows,daily,intra]=await Promise.all(['15m','1d','5m'].map(t=>E.candles(symbol,t,{allowStale:true})));
      trend=E.analyze(trendRows,'15m',0).trend;
    } catch {
      state.errors.push(symbol+' trend unavailable'); console.error(symbol, 'trend unavailable');
      process.exitCode = 1;
      continue;
    }

    state.items ||= {}; state.history ||= []; state.checkpoints ||= {};
    for(const cp of L.checkpoints(intra,Math.floor(Date.now()/1000))){
      const id=symbol+' '+cp.end;
      if(cp.status==='PENDING'||cp.status==='DATA UNAVAILABLE'||state.checkpoints[id]||Date.now()/1000-cp.end>900)continue;
      await enqueue('checkpoint '+id,'V6.1 '+cp.n+'m direction',symbol+' | '+cp.status+' | informational only');
      state.checkpoints[id]=true;
      save();
    }
    for (const tf of (cfg.mode==='all'?Object.keys(E.frames):[cfg.mode==='fixed'?'15m':cfg.entry])) {
      const key = symbol + ' ' + tf;

      try {
        const rows = tf==='5m'?intra:tf==='15m'?trendRows:tf==='1d'?daily:await E.candles(symbol,tf,{allowStale:true});
        if(rows.length<200){state.errors.push(key+' insufficient history');continue;}
        if(rows.at(-1).time!==Math.floor((Date.now()/1000-5)/E.frames[tf])*E.frames[tf]-E.frames[tf]){state.errors.push(key+' stale or closed; alerts paused');continue;}
        const prior=state.items[key]||{};
        const pending=rows.map((r,i)=>i).filter(i=>i>=199&&rows[i].time+E.frames[tf]>=Date.now()/1000-86400&&rows[i].time>(prior.time??rows.at(-2).time));
        for(const i of pending){
        const t=rows[i].time+E.frames[tf];
        const tr=trendRows.filter(r=>r.time+900<=t);
        if(tr.length<50||t-(tr.at(-1).time+900)>=900||!tr.slice(-50).every((r,j,arr)=>!j||r.time-arr[j-1].time===900))continue;
        const a=L.evaluate(rows.slice(0,i+1),tf,E.analyze(tr,'15m',0).trend,L.context(daily,intra,t-1),cfg);
        const old=state.items[key]||{};
        let pos = old.position || null;
        const previousPosition=pos?JSON.parse(JSON.stringify(pos)):null;
        const events = (a.falseBreakouts||[]).map(x=>'FALSE BREAKOUT '+x.name);
        const candle=rows[i];
        if(pos && !Array.isArray(pos.hit))pos.hit=[];

        if (pos) {
          if (( (pos.dir===1?candle.low:candle.high) - pos.stop) * pos.dir <= 0) {
            events.push('EXIT STOP');
            pos = null;

          } else if (
            ((pos.dir===1?candle.high:candle.low) - pos.targets[2]) * pos.dir >= 0
          ) {
            for(let j=0;j<2;j++)if(!pos.hit.includes(j))events.push('TARGET '+(j+1)+'R');
            events.push('EXIT 3R');
            pos = null;

          } else {
            for (let j = 0; j < 2; j++) {
              if (
                ((pos.dir===1?candle.high:candle.low) - pos.targets[j]) * pos.dir >= 0 &&
                !pos.hit.includes(j)
              ) {
                pos.hit.push(j);
                events.push('TARGET ' + (j + 1) + 'R');
              }
            }
          }
        }

        if (
          a.signalDir && Number.isFinite(a.atr) && a.atr>0 &&
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
            a.strength+' '+(a.signalDir === 1 ? 'BUY' : 'SELL')
          );
        }

        

        state.items[key] = {
          ...a,
          position: pos
        };

        if (events.length) {
          const body =
            key + ' | $' + a.price + (previousPosition&&events.some(e=>e.startsWith('EXIT'))?'\nPrevious entry '+previousPosition.entry+' | SL '+previousPosition.stop+' | Targets '+previousPosition.targets.join(' / ')+' | Exit reference '+(events.includes('EXIT STOP')?previousPosition.stop:events.includes('EXIT 3R')?previousPosition.targets[2]:a.price):'') + '\n15m trend: '+a.mainTrend+' | '+a.matched.map(x=>x.name).join(', ')+'\n' +
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

          await enqueue(key+' '+a.time,'V6.1 '+events.join(' / '),body);
        }

        state.history = state.history.slice(0, 300);

        save();
        }

      } catch (err) {
        state.errors.push(key+' analysis or state error'); console.error(key, 'Analysis or state error');
        process.exitCode = 1;
      }
    }
  }

  await flush(); state.lastRun=new Date().toISOString();state.dryRun=!live;save();console.log('Monitoring completed');
}

if(require.main===module)main().catch(() => {
  console.error('Monitor execution failed');
  process.exitCode = 1;
});
