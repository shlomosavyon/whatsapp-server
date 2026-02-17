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

function verifyWebhookSecret(req: any, res: any, next: any) {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
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
    const { cancelledPlayerName, promotedPlayerName, remainingSpots, currentCount, maxPlayers } = req.body;

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const message = notificationService.generateCancellationNotification(
      cancelledPlayerName,
      promotedPlayerName,
      remainingSpots,
      currentCount,
      maxPlayers
    );

    const success = await whatsapp.sendMessage(message);
    res.json({ success, message: 'Notification sent' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhook/player-signup', verifyWebhookSecret, async (req, res) => {
  try {
    const { playerName, currentCount, maxPlayers } = req.body;

    const whatsapp = getWhatsAppService();
    if (!whatsapp.getConnectionStatus()) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const message = notificationService.generateSignupNotification(
      playerName,
      currentCount,
      maxPlayers
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
// Uses a simple secret key in the URL to prevent abuse
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

    // Fetch today's calendar data from Supabase edge function
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
    const calendarUrl = `${EDGE_FUNCTION_BASE_URL}/calendar-data?date=${dateStr}`;

    const calResp = await fetch(calendarUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!calResp.ok) {
      return res.status(500).json({ error: 'Failed to fetch calendar data', status: calResp.status });
    }

    const calData: any = await calResp.json();

    // Find today's game(s)
    const todayGames = (calData.dates || []).filter((d: any) => d.date === dateStr);

    if (todayGames.length === 0) {
      return res.json({ success: true, message: 'No game today', sent: false });
    }

    for (const game of todayGames) {
      const confirmed = (game.signups || []).filter((s: any) => s.status === 'confirmed');
      const capacity = game.max_players || 9;
      const spotsLeft = Math.max(capacity - confirmed.length, 0);
      const tableName = game.table?.name || 'Poker';

      // Format date as M/D
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Auto-reconnect WhatsApp on server startup
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
