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
const EDGE_FUNCTION_BASE_URL = process.env.EDGE_FUNCTION_BASE_URL;
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

    // Set up QR callback BEFORE calling connect
    const qrPromise = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        console.log('QR timeout - no QR received in 60s');
        resolve(null);
      }, 60000);

      whatsapp.setQRCallback((qr: string) => {
        console.log('QR callback fired in server.ts');
        clearTimeout(timeout);
        resolve(qr);
      });
    });

    // Start the connection WITHOUT awaiting - let it run in background
    whatsapp.connect().catch((err: any) => {
      console.error('Connect error (background):', err);
    });

    // Wait for the QR code from the callback (up to 60s)
    const qrCode = await qrPromise;

    if (qrCode) {
      const qrCodeDataURL = await QRCode.toDataURL(qrCode);
      res.json({ qrCode: qrCodeDataURL });
    } else {
      res.json({ message: 'Already connected or connecting' });
    }
  } catch (error: any) {
    console.error('Connect error:', error);
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
    const success = await whatsapp.sendMessage("Test message from WhatsApp server");
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

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
