// Background tasks (WordPress cron equivalent). Started by src/index.js only — tests and scripts
// that just load the app don't run timers. With several server processes, run tasks in one of them
// (set SCHEDULER=off on the others).
const tasks = [
  { name: 'scheduled sales', everyMs: 5 * 60 * 1000, run: () => require('../services/scheduled-sales').runScheduledSales() },
  { name: 'email queue', everyMs: 30 * 1000, run: () => require('../services/email/mailer').processQueue() },
];

function start() {
  if (String(process.env.SCHEDULER || 'on').toLowerCase() === 'off') return;
  for (const t of tasks) {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { await t.run(); } catch (e) { console.error(`[scheduler] ${t.name} failed:`, e.message); } finally { busy = false; }
    };
    setTimeout(tick, 5000);
    setInterval(tick, t.everyMs).unref();
  }
}

module.exports = { start };
