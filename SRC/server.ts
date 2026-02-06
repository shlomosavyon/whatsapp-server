
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { getWhatsAppService } from './whatsapp-service';
import { getScheduler } from './scheduler';
import { notificationService } from './notification-service';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables
const EDGE_FUNCTION_BASE_URL = process.env.EDGE_FUNCTION_BASE_URL!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "default-secret";

// Simple auth middleware for webhooks
function verifyWebhookSecret(req, res, next) {
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
