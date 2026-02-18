import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { getWhatsAppService } from './whatsapp-service.js';
import { getScheduler } from './scheduler.js';
import { notificationService } from './notification-service.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));
const EDGE_FUNCTION_BASE_URL = process.env.EDGE_FUNCTION_BASE_URL || 'https://ghpudjkbskkhjhtoedxa.supabase.co/functions/v1';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "default-secret";

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

// Helper: fetch today's roster from calendar-data edge function
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

// Helper: check if a date string is today
function isToday(dateStr: string): boolean {
  if (!dateStr) return true; // if no date provided, assume today
  const today = new Date().toISOString().split('T')[0];
  return dateStr === today;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.post('/api/whatsapp/test', async (req, res) => {
  try {
    const whatsapp = getWhatsAppService();
    const { message } = req.body || {};
    const success = await whatsapp.sendMessage(message || "Test message from WhatsApp server");
    res.json({ success, message: 'Test message sent' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhook/player-cancelled', verifyWebhookSecret, async (req, res) => {
  try {
    const { cancelledPlayerName, promotedPlayerName, remainingSpots, currentCount, maxPlayers, date } = req.body;

    // Only send WhatsApp for today's game
    if (date && !isToday(date)) {
      return res.json({ success: true, message: 'Future game - no WhatsApp sent', skipped: true });
    }

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    // Fetch current roster for today
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

    // Only send WhatsApp for today's game
    if (date && !isToday(date)) {
      return res.json({ success: true, message: 'Future game - no WhatsApp sent', skipped: true });
    }

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    // Fetch current roster for today
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
      const capacity = game.max_players || 9;
      const spotsLeft = Math.max(capacity - confirmed.length, 0);
      const tableName = game.table?.name || 'Poker';

      const gameDate = new Date(game.date + 'T12:00:00');
      const month = gameDate.getMonth() + 1;
      const day = gameDate.getDate();

      let playerList = '';
      confirmed.sort((a: any, b: any) => new Date(a.signed_up_at).getTime() - new Date(b.signed_up_at).getTime());
      confirmed.forEach((s: any, i: number) => {
        const firstName = (s.nickname || 'Unknown').split(' ')[0];
        playerList += `${i + 1}. ${firstName}\n`;
      });

      const msg = `*Tonight's Game - ${month}/${day}*\n`
        + `${tableName}\n`
        + `${confirmed.length}/${capacity} players | ${spotsLeft} spots left\n\n`
        + (playerList || 'No signups yet\n')
        + `\nIf you need to cancel, click 10xx.com`;

      await whatsapp.sendMessage(msg);
    }

    res.json({ success: true, message: 'Morning roster sent', games: todayGames.length });
  } catch (error: any) {
    console.error('Morning roster error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cron endpoint for noon reminder - called by cron-job.org at 12 PM
app.get('/api/cron/noon-reminder', async (req, res) => {
  try {
    if (req.query.key !== CRON_SECRET) {
      return res.status(401).json({ error: 'Invalid key' });
    }

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

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
      const capacity = game.max_players || 9;
      const spotsLeft = Math.max(capacity - confirmed.length, 0);
      const tableName = game.table?.name || 'Poker';

      const gameDate = new Date(game.date + 'T12:00:00');
      const month = gameDate.getMonth() + 1;
      const day = gameDate.getDate();

      let playerList = '';
      confirmed.sort((a: any, b: any) => new Date(a.signed_up_at).getTime() - new Date(b.signed_up_at).getTime());
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

      let msg = `*Noon Update - Tonight's Game ${month}/${day}*\n`
        + `${tableName}\n`
        + `${confirmed.length}/${capacity} players | ${spotsLeft} spots left\n\n`
        + `*Signed up:*\n`
        + (playerList || 'No signups yet\n');

      if (notSignedUp.length > 0 && spotsLeft > 0) {
        const names = notSignedUp.map(n => n.split(' ')[0]).join(', ');
        msg += `\n${names} - we have ${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left! Sign up here: 10xx.com`;
      } else if (spotsLeft === 0) {
        msg += `\nTable is full! Waitlist available at 10xx.com`;
      }

      await whatsapp.sendMessage(msg);
    }

    res.json({ success: true, message: 'Noon reminder sent', games: todayGames.length });
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

  if (EDGE_FUNCTION_BASE_URL && WEBHOOK_SECRET) {
    const scheduler = getScheduler({
      enabled: true,
      dailyRosterTime: '0 6 * * *',
      edgeFunctionUrl: EDGE_FUNCTION_BASE_URL,
      webhookSecret: WEBHOOK_SECRET,
    });
    scheduler.startDailyRoster();
  }
});
