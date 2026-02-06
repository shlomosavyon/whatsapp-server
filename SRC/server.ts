import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { getWhatsAppService } from './whatsapp-service';
import { getScheduler } from './scheduler.js';
import { notificationService } from './notification-service';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables
const EDGE_FUNCTION_BASE_URL = process.env.EDGE_FUNCTION_BASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "default-secret";

// Simple auth middleware for webhooks
function verifyWebhookSecret(req: any, res: any, next: any) {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Routes:
// GET  /health - Health check
// POST /api/whatsapp/connect - Connect & get QR code
// GET  /api/whatsapp/status - Check connection status
// POST /api/whatsapp/disconnect - Disconnect WhatsApp
// POST /api/whatsapp/test - Send test message
// POST /api/webhook/player-cancelled - Webhook for cancellations
// POST /api/webhook/player-signup - Webhook for signups
// POST /api/whatsapp/send-roster-now - Manual roster trigger

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// WhatsApp endpoints
app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    const whatsapp = getWhatsAppService();
    const qrCode = await whatsapp.connect();
    
    if (qrCode) {
      const qrCodeDataURL = await QRCode.toDataURL(qrCode);
      res.json({ qrCode: qrCodeDataURL });
    } else {
      res.json({ message: 'Already connected or connecting' });
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
    const success = await whatsapp.sendMessage('Test message from WhatsApp server! 🎉');
    res.json({ success, message: 'Test message sent' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoints
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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize scheduler if configured
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
