import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { getWhatsAppService } from './whatsapp-service.js';
import { getScheduler } from './scheduler.js';
import { notificationService } from './notification-service.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('.'));
const EDGE_FUNCTION_BASE_URL = process.env.EDGE_FUNCTION_BASE_URL || 'https://ghpudjkbskkhjhtoedxa.supabase.co/functions/v1';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "default-secret";

// Deduplication: ignore identical webhook events within 30 seconds
const recentEvents = new Map<string, number>();
function isDuplicate(key: string): boolean {
  const now = Date.now();
  const last = recentEvents.get(key);
  if (last && now - last < 30_000) return true;
  recentEvents.set(key, now);
  // Clean up old entries
  for (const [k, t] of recentEvents) {
    if (now - t > 30_000) recentEvents.delete(k);
  }
  return false;
}

const ALL_PLAYERS = [
  'Avrum', 'Carl', 'Danny', 'David', 'Don', 'Dov',
  'Itzik', 'Larry', 'Liron', 'Mark', 'Shlomo S',
  'Shlomo T', 'Tom', 'Tomer', 'Yair', 'Zaken'
];

function verifyWebhookSecret(req: any, res: any, next: any) {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function fetchTodayRoster(): Promise<{ roster: any[], gameDate: string, maxPlayers: number, spotsLeft: number } | null> {
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  const calendarUrl = `${EDGE_FUNCTION_BASE_URL}/calendar-data?date=${dateStr}`;

  try {
    const calResp = await fetch(calendarUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!calResp.ok) return null;

    const calData: any = await calResp.json();
    const todayGames = (calData.dates || []).filter((d: any) => d.date === dateStr);
    if (todayGames.length === 0) return null;

    const game = todayGames[0];
    const confirmed = (game.signups || []).filter((s: any) => s.status === 'confirmed');
    confirmed.sort((a: any, b: any) => new Date(a.signed_up_at).getTime() - new Date(b.signed_up_at).getTime());

    const roster = confirmed.map((s: any) => ({
      name: (s.nickname || 'Unknown').split(' ')[0],
      signedUpAt: s.signed_up_at
    }));

    const maxPlayers = game.max_players || 9;
    const spotsLeft = Math.max(maxPlayers - confirmed.length, 0);

    return { roster, gameDate: dateStr, maxPlayers, spotsLeft };
  } catch (error) {
    console.error('Error fetching today roster:', error);
    return null;
  }
}

function isToday(dateStr: string): boolean {
  if (!dateStr) return true;
  const today = new Date().toISOString().split('T')[0];
  return dateStr === today;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/whatsapp/health', (req, res) => {
  const whatsapp = getWhatsAppService();
  if (whatsapp.getConnectionStatus()) {
    res.json({ status: 'ok', whatsapp: 'connected' });
  } else {
    res.status(503).json({ status: 'error', whatsapp: 'disconnected' });
  }
});

// DEBUG endpoint - shows raw API data including waitlist
app.get('/api/debug/roster', async (req, res) => {
  try {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const calendarUrl = `${EDGE_FUNCTION_BASE_URL}/calendar-data?date=${dateStr}`;
    const calResp = await fetch(calendarUrl, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    const calData: any = await calResp.json();
    const todayGames = (calData.dates || []).filter((d: any) => d.date === dateStr);

    if (todayGames.length === 0) {
      return res.json({ message: 'No game today', dateStr, rawDates: calData.dates?.map((d: any) => d.date) });
    }

    const game = todayGames[0];
    const allSignups = (game.signups || []).filter((s: any) => s.status === 'confirmed');
    allSignups.sort((a: any, b: any) => new Date(a.signed_up_at).getTime() - new Date(b.signed_up_at).getTime());
    const capacity = game.max_players || 9;

    res.json({
      dateStr,
      max_players: game.max_players,
      capacity,
      total_confirmed: allSignups.length,
      api_waitlist: game.waitlist || [],
      api_waitlist_count: game.waitlist_count,
      playing: allSignups.map((s: any) => ({ nickname: s.nickname, status: s.status, signed_up_at: s.signed_up_at })),
      all_statuses: (game.signups || []).map((s: any) => ({ nickname: s.nickname, status: s.status }))
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    const whatsapp = getWhatsAppService();
    whatsapp.connect().catch((err: any) => {
      console.error('Connect error:', err);
    });
    res.json({ message: 'Connection started. Poll /api/whatsapp/qr for QR code.' });
  } catch (error: any) {
    console.error('Connect error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/qr', async (req, res) => {
  try {
    const whatsapp = getWhatsAppService();
    const qr = whatsapp.getLatestQR();
    if (qr) {
      const qrCodeDataURL = await QRCode.toDataURL(qr);
      res.json({ qrCode: qrCodeDataURL });
    } else if (whatsapp.getConnectionStatus()) {
      res.json({ connected: true });
    } else {
      res.json({ waiting: true });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/status', (req, res) => {
  const whatsapp = getWhatsAppService();
  const isConnected = whatsapp.getConnectionStatus();
  res.json({ connected: isConnected });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const whatsapp = getWhatsAppService();
    await whatsapp.disconnect();
    res.json({ message: 'Disconnected successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Scheduled messages ──────────────────────────────────────────────────────
interface ScheduledJob {
  id: string;
  message: string | null;
  attachment: { data: string; mimetype: string; filename: string } | null; // base64 data
  group: string | null;
  sendAt: string; // ISO string
  timer: ReturnType<typeof setTimeout>;
}

const scheduledJobs = new Map<string, ScheduledJob>();

app.post('/api/whatsapp/schedule', async (req, res) => {
  try {
    const { message, attachment, sendAt, group } = req.body;

    if (!message && !attachment) {
      return res.status(400).json({ error: 'Provide a message, an attachment, or both' });
    }
    if (!sendAt) {
      return res.status(400).json({ error: 'sendAt is required' });
    }

    const sendTime = new Date(sendAt);
    const delay = sendTime.getTime() - Date.now();
    if (delay < 0) {
      return res.status(400).json({ error: 'sendAt must be in the future' });
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const timer = setTimeout(async () => {
      console.log(`[Scheduler] Sending scheduled message ${id}`);
      const whatsapp = getWhatsAppService();
      const job = scheduledJobs.get(id);
      if (!job) return;

      const attachmentBuf = job.attachment
        ? { data: Buffer.from(job.attachment.data, 'base64'), mimetype: job.attachment.mimetype, filename: job.attachment.filename }
        : null;

      await whatsapp.sendMessageWithAttachment(job.message, attachmentBuf, job.group || undefined);
      scheduledJobs.delete(id);
    }, delay);

    const job: ScheduledJob = { id, message: message || null, attachment: attachment || null, group: group || null, sendAt, timer };
    scheduledJobs.set(id, job);

    console.log(`[Scheduler] Scheduled message ${id} for ${sendAt}`);
    res.json({ success: true, id, sendAt });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/scheduled', (req, res) => {
  const jobs = Array.from(scheduledJobs.values()).map(({ id, message, attachment, group, sendAt }) => ({
    id,
    message,
    hasAttachment: !!attachment,
    attachmentFilename: attachment?.filename || null,
    group,
    sendAt,
  }));
  res.json({ jobs });
});

app.delete('/api/whatsapp/scheduled/:id', (req, res) => {
  const { id } = req.params;
  const job = scheduledJobs.get(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  clearTimeout(job.timer);
  scheduledJobs.delete(id);
  res.json({ success: true });
});
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/whatsapp/test', async (req, res) => {
  try {
    const whatsapp = getWhatsAppService();
    const { message, group } = req.body || {};
    const success = await whatsapp.sendMessage(message || "Test message from WhatsApp server", group || undefined);
    res.json({ success, message: `Message sent to ${group || 'default group'}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhook/player-cancelled', verifyWebhookSecret, async (req, res) => {
  try {
    const { cancelledPlayerName, promotedPlayerName, remainingSpots, currentCount, maxPlayers, date } = req.body;

    if (date && !isToday(date)) {
      return res.json({ success: true, message: 'Future game - no WhatsApp sent', skipped: true });
    }

    const dedupKey = `cancelled:${cancelledPlayerName}:${date || 'today'}`;
    if (isDuplicate(dedupKey)) {
      console.log(`[Dedup] Skipping duplicate cancellation event for ${cancelledPlayerName}`);
      return res.json({ success: true, message: 'Duplicate event ignored' });
    }

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const todayData = await fetchTodayRoster();
    const roster = todayData?.roster || [];
    const gameDate = todayData?.gameDate || new Date().toISOString().split('T')[0];
    const spots = todayData?.spotsLeft ?? remainingSpots;

    const message = notificationService.generateCancellationNotification(
      cancelledPlayerName,
      roster,
      currentCount,
      maxPlayers,
      gameDate,
      spots,
      promotedPlayerName
    );

    const success = await whatsapp.sendMessage(message);
    res.json({ success, message: 'Notification sent' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhook/player-signup', verifyWebhookSecret, async (req, res) => {
  try {
    const { playerName, currentCount, maxPlayers, date } = req.body;

    if (date && !isToday(date)) {
      return res.json({ success: true, message: 'Future game - no WhatsApp sent', skipped: true });
    }

    const dedupKey = `signup:${playerName}:${date || 'today'}`;
    if (isDuplicate(dedupKey)) {
      console.log(`[Dedup] Skipping duplicate signup event for ${playerName}`);
      return res.json({ success: true, message: 'Duplicate event ignored' });
    }

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const todayData = await fetchTodayRoster();
    const roster = todayData?.roster || [];
    const gameDate = todayData?.gameDate || new Date().toISOString().split('T')[0];

    const message = notificationService.generateSignupNotification(
      playerName,
      roster,
      currentCount,
      maxPlayers,
      gameDate
    );

    const success = await whatsapp.sendMessage(message);
    res.json({ success, message: 'Notification sent' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/send-roster-now', verifyWebhookSecret, async (req, res) => {
  try {
    const scheduler = getScheduler();
    await scheduler.triggerDailyRosterNow();
    res.json({ success: true, message: 'Daily roster triggered' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Cron endpoint for morning roster - called by cron-job.org at 6 AM
// Add &group=Calendar to test to Calendar group
const CRON_SECRET = process.env.CRON_SECRET || 'fwk2026';
app.get('/api/cron/morning-roster', async (req, res) => {
  try {
    if (req.query.key !== CRON_SECRET) {
      return res.status(401).json({ error: 'Invalid key' });
    }

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const targetGroup = req.query.group as string | undefined;

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const calendarUrl = `${EDGE_FUNCTION_BASE_URL}/calendar-data?date=${dateStr}`;

    const calResp = await fetch(calendarUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!calResp.ok) {
      return res.status(500).json({ error: 'Failed to fetch calendar data', status: calResp.status });
    }

    const calData: any = await calResp.json();
    const todayGames = (calData.dates || []).filter((d: any) => d.date === dateStr);

    if (todayGames.length === 0) {
      return res.json({ success: true, message: 'No game today', sent: false });
    }

    for (const game of todayGames) {
      const confirmed = (game.signups || []).filter((s: any) => s.status === 'confirmed');
      confirmed.sort((a: any, b: any) => new Date(a.signed_up_at).getTime() - new Date(b.signed_up_at).getTime());
      const capacity = game.max_players || 9;
      const spotsLeft = Math.max(capacity - confirmed.length, 0);

      // Waitlist comes from the API's separate waitlist array
      const waitlisted = game.waitlist || [];

      const gameDate = new Date(game.date + 'T12:00:00');
      const month = gameDate.getMonth() + 1;
      const day = gameDate.getDate();

      let playerList = '';
      confirmed.forEach((s: any, i: number) => {
        const firstName = (s.nickname || 'Unknown').split(' ')[0];
        playerList += `${i + 1}. ${firstName}\n`;
      });

      let waitlistText = '';
      if (waitlisted.length > 0) {
        waitlistText = `\n*Waitlist:*\n`;
        waitlisted.forEach((s: any, i: number) => {
          const firstName = (s.nickname || 'Unknown').split(' ')[0];
          waitlistText += `${i + 1}. ${firstName}\n`;
        });
      }

      const msg = `===================\n`
        + `*Tonight's Game - ${month}/${day}*\n`
        + `${confirmed.length}/${capacity} players | ${spotsLeft} spots left\n\n`
        + (playerList || 'No signups yet\n')
        + waitlistText
        + `\nIf you need to cancel, click 10xx.com\n`
        + `===================`;

      await whatsapp.sendMessage(msg, targetGroup || undefined);
    }

    res.json({ success: true, message: `Morning roster sent to ${targetGroup || 'default group'}`, games: todayGames.length });
  } catch (error: any) {
    console.error('Morning roster error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cron endpoint for noon reminder - called by cron-job.org at 12 PM
// Add &group=Calendar to test to Calendar group
app.get('/api/cron/noon-reminder', async (req, res) => {
  try {
    if (req.query.key !== CRON_SECRET) {
      return res.status(401).json({ error: 'Invalid key' });
    }

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const targetGroup = req.query.group as string | undefined;

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const calendarUrl = `${EDGE_FUNCTION_BASE_URL}/calendar-data?date=${dateStr}`;

    const calResp = await fetch(calendarUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!calResp.ok) {
      return res.status(500).json({ error: 'Failed to fetch calendar data', status: calResp.status });
    }

    const calData: any = await calResp.json();
    const todayGames = (calData.dates || []).filter((d: any) => d.date === dateStr);

    if (todayGames.length === 0) {
      return res.json({ success: true, message: 'No game today', sent: false });
    }

    for (const game of todayGames) {
      const confirmed = (game.signups || []).filter((s: any) => s.status === 'confirmed');
      confirmed.sort((a: any, b: any) => new Date(a.signed_up_at).getTime() - new Date(b.signed_up_at).getTime());
      const capacity = game.max_players || 9;
      const spotsLeft = Math.max(capacity - confirmed.length, 0);

      // Waitlist comes from the API's separate waitlist array
      const waitlisted = game.waitlist || [];

      const gameDate = new Date(game.date + 'T12:00:00');
      const month = gameDate.getMonth() + 1;
      const day = gameDate.getDate();

      let playerList = '';
      confirmed.forEach((s: any, i: number) => {
        const firstName = (s.nickname || 'Unknown').split(' ')[0];
        playerList += `${i + 1}. ${firstName}\n`;
      });

      const signedUpNames = confirmed.map((s: any) => {
        const nick = (s.nickname || '').trim();
        return nick;
      });

      const notSignedUp = ALL_PLAYERS.filter(player => {
        return !signedUpNames.some((signed: string) => {
          const signedFirst = signed.split(' ')[0].toLowerCase();
          const playerFirst = player.split(' ')[0].toLowerCase();
          return signedFirst === playerFirst || signed.toLowerCase() === player.toLowerCase();
        });
      });

      let waitlistText = '';
      if (waitlisted.length > 0) {
        waitlistText = `\n*Waitlist:*\n`;
        waitlisted.forEach((s: any, i: number) => {
          const firstName = (s.nickname || 'Unknown').split(' ')[0];
          waitlistText += `${i + 1}. ${firstName}\n`;
        });
      }

      let msg = `===================\n`
        + `*Noon Update - Tonight's Game ${month}/${day}*\n`
        + `${confirmed.length}/${capacity} players | ${spotsLeft} spots left\n\n`
        + `*Signed up:*\n`
        + (playerList || 'No signups yet\n')
        + waitlistText;

      if (notSignedUp.length > 0 && spotsLeft > 0) {
        const names = notSignedUp.map(n => n.split(' ')[0]).join(', ');
        msg += `\n${names} - we have ${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left! Sign up here: 10xx.com`;
      } else if (spotsLeft === 0) {
        msg += `\nTable is full! Waitlist available at 10xx.com`;
      }

      msg += `\n===================`;

      await whatsapp.sendMessage(msg, targetGroup || undefined);
    }

    res.json({ success: true, message: `Noon reminder sent to ${targetGroup || 'default group'}`, games: todayGames.length });
  } catch (error: any) {
    console.error('Noon reminder error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  const whatsapp = getWhatsAppService();
  whatsapp.autoReconnect().catch((err: any) => {
    console.error('WhatsApp auto-reconnect error:', err);
  });

  setInterval(() => {
    const wa = getWhatsAppService();
    if (!wa.getConnectionStatus()) {
      console.log('[Auto-heal] WhatsApp disconnected, attempting auto-reconnect...');
      wa.autoReconnect().catch((err: any) => {
        console.error('[Auto-heal] Auto-reconnect failed:', err);
      });
    }
  }, 2 * 60 * 1000);
});
