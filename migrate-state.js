
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// ==========================================
// V6 TO V6.1 STATE MIGRATION
// ==========================================

const sourceFile = path.resolve(
  process.argv[2] || 'state.json'
);

const outputFile = path.resolve(
  process.argv[3] || 'state-v61-migrated.json'
);

const VERSION = '6.1';

const activeMarkets = [
  'BTCUSD',
  'ETHUSD',
  'XAUTUSD',
  'SLVONUSD'
];

const optionalMarkets = [
  'SOLUSD',
  'XRPUSD',
  'OILUSD'
];

function hash(data) {
  return crypto
    .createHash('sha256')
    .update(data)
    .digest('hex');
}

function isObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function validatePosition(pos, key) {
  if (pos === null || pos === undefined) {
    return;
  }

  assert.ok(
    isObject(pos),
    key + ': Invalid position'
  );

  assert.ok(
    pos.dir === 1 || pos.dir === -1,
    key + ': Invalid direction'
  );

  assert.ok(
    Number.isFinite(pos.entry) &&
    pos.entry > 0,
    key + ': Invalid entry'
  );

  assert.ok(
    Number.isFinite(pos.stop) &&
    pos.stop > 0,
    key + ': Invalid stop loss'
  );

  assert.ok(
    Array.isArray(pos.targets) &&
    pos.targets.length === 3 &&
    pos.targets.every(
      n => Number.isFinite(n) && n > 0
    ),
    key + ': Invalid targets'
  );

  assert.ok(
    (pos.entry - pos.stop) * pos.dir > 0,
    key + ': Stop loss direction invalid'
  );

  for (let i = 0; i < 3; i++) {
    assert.ok(
      (pos.targets[i] - pos.entry) *
        pos.dir > 0,
      key + ': Target direction invalid'
    );

    if (i > 0) {
      assert.ok(
        (pos.targets[i] - pos.targets[i - 1]) *
          pos.dir > 0,
        key + ': Target order invalid'
      );
    }
  }

  if (pos.hit !== undefined) {
    assert.ok(
      Array.isArray(pos.hit) &&
      pos.hit.every(
        n => Number.isInteger(n) &&
          n >= 0 && n <= 2
      ),
      key + ': Invalid target history'
    );
  }
}

function migrate() {
  console.log('================================');
  console.log('BTC EMA PRO V6.1 STATE MIGRATION');
  console.log('================================');

  assert.notEqual(
    sourceFile,
    outputFile,
    'Source and output must be different'
  );

  assert.ok(
    fs.existsSync(sourceFile),
    'Source state file not found'
  );

  assert.ok(
    !fs.existsSync(outputFile),
    'Output already exists. Use a new filename.'
  );

  const original = fs.readFileSync(sourceFile);
  const originalHash = hash(original);

  const state = JSON.parse(
    original.toString('utf8')
  );

  assert.ok(
    isObject(state),
    'Invalid state structure'
  );

  assert.ok(
    isObject(state.items),
    'Invalid market records'
  );

  assert.ok(
    Array.isArray(state.history),
    'Invalid alert history'
  );

  assert.notEqual(
    state.dryRun,
    true,
    'Dry-run state cannot become production state'
  );

  assert.notEqual(
    state.stateVersion,
    VERSION,
    'State already migrated to V6.1'
  );

  const originalItemCount =
    Object.keys(state.items).length;

  const originalHistoryCount =
    state.history.length;

  let openPositions = 0;

  const positionReport = [];

  // ========================================
  // VALIDATE EXISTING MARKET RECORDS
  // ========================================

  for (
    const [key, item] of
    Object.entries(state.items)
  ) {
    assert.ok(
      isObject(item),
      key + ': Invalid market record'
    );

    assert.ok(
      Number.isInteger(item.time) &&
      item.time > 0,
      key + ': Invalid candle timestamp'
    );

    validatePosition(item.position, key);

    if (item.position) {
      openPositions++;

      if (!Array.isArray(item.position.hit)) {
        item.position.hit = [];
      }

      positionReport.push({
        market: key,
        direction:
          item.position.dir === 1
            ? 'LONG'
            : 'SHORT',
        entry: item.position.entry,
        stop: item.position.stop,
        targets: item.position.targets
      });
    }
  }

  // ========================================
  // VALIDATE AND PRESERVE ALERT HISTORY
  // ========================================

  for (const record of state.history) {
    assert.ok(
      isObject(record),
      'Invalid alert history record'
    );
  }

  // ========================================
  // VALIDATE EXISTING QUEUE
  // ========================================

  if (state.outbox !== undefined) {
    assert.ok(
      isObject(state.outbox),
      'Invalid notification outbox'
    );

    assert.equal(
      Object.keys(state.outbox).length,
      0,
      'Pending notifications require manual review'
    );
  }

  // ========================================
  // INITIALIZE V6.1 STATE
  // ========================================

  state.stateVersion = VERSION;

  state.outbox = {};

  if (state.checkpoints === undefined) {
    state.checkpoints = {};
  }

  assert.ok(
    isObject(state.checkpoints),
    'Invalid checkpoint records'
  );

  state.errors = [];

  state.dryRun = false;

  state.migration = {
    from: '6',
    to: VERSION,
    migratedAt: new Date().toISOString(),
    sourceSHA256: originalHash,
    preservedMarketRecords: originalItemCount,
    preservedHistoryRecords: originalHistoryCount,
    preservedOpenPositions: openPositions,
    activeMarkets,
    optionalMarkets
  };

  // ========================================
  // CREATE ORIGINAL STATE BACKUP
  // ========================================

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const backupFile =
    sourceFile + '.v6-backup-' + stamp;

  fs.writeFileSync(
    backupFile,
    original,
    { flag: 'wx' }
  );

  assert.equal(
    hash(fs.readFileSync(backupFile)),
    originalHash,
    'Backup verification failed'
  );

  // ========================================
  // WRITE SEPARATE MIGRATED STATE
  // ========================================

  fs.writeFileSync(
    outputFile,
    JSON.stringify(state),
    { flag: 'wx' }
  );

  const verified = JSON.parse(
    fs.readFileSync(outputFile, 'utf8')
  );

  assert.equal(
    verified.stateVersion,
    VERSION
  );

  assert.equal(
    Object.keys(verified.items).length,
    originalItemCount
  );

  assert.equal(
    verified.history.length,
    originalHistoryCount
  );

  assert.equal(
    Object.values(verified.items)
      .filter(item => item.position).length,
    openPositions
  );

  assert.equal(
    verified.dryRun,
    false
  );

  assert.equal(
    hash(fs.readFileSync(sourceFile)),
    originalHash,
    'Original state changed during migration'
  );

  // ========================================
  // MIGRATION REPORT
  // ========================================

  console.log('Original state: UNCHANGED');
  console.log('Backup: VERIFIED');
  console.log('State version:', VERSION);

  console.log(
    'Market records preserved:',
    originalItemCount
  );

  console.log(
    'History records preserved:',
    originalHistoryCount
  );

  console.log(
    'Open positions preserved:',
    openPositions
  );

  console.log(
    'Pending notifications:',
    Object.keys(verified.outbox).length
  );

  console.log(
    'Active markets:',
    activeMarkets.join(', ')
  );

  console.log(
    'Optional markets:',
    optionalMarkets.join(', ')
  );

  console.log(
    'Position report:',
    JSON.stringify(positionReport, null, 2)
  );

  console.log('Backup file:', backupFile);
  console.log('Migrated file:', outputFile);

  console.log('================================');
  console.log('V6.1 STATE MIGRATION PASSED');
  console.log('================================');
}

try {
  migrate();
} catch (error) {
  console.error(
    'STATE MIGRATION FAILED:',
    error.message
  );

  process.exitCode = 1;
}
