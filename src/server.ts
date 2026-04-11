import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { getScheduler } from './scheduler.js';
import { notificationService } from './notification-service.js';
import { getTelegramService, getTelegramLog } from './telegram-service.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// FWK API integration — supports both house (Shlomo) and host (dedicated host account)
const FWK_API = 'https://api-v2.friendswithkings.com/api';

// House (Shlomo) credentials — full admin powers
const FWK_HOUSE_EMAIL = process.env.FWK_PROD_EMAIL || '';
const FWK_HOUSE_PASSWORD = process.env.FWK_PROD_PASSWORD || '';

// Host credentials — tables created with these allow all hosts to start/freeze/resume
const FWK_HOST_EMAIL = process.env.FWK_HOST_EMAIL || '';
const FWK_HOST_PASSWORD = process.env.FWK_HOST_PASSWORD || '';

// Separate token caches per role so we don't overwrite each other's tokens
const fwkTokenCaches: { [role: string]: { token: string; exp: number } | null } = {
  house: null,
  host: null,
};

async function getFwkToken(role: 'house' | 'host' = 'host'): Promise<string> {
  const cache = fwkTokenCaches[role];
  if (cache && Date.now() / 1000 < cache.exp - 60) {
    return cache.token;
  }

  const email = role === 'house' ? FWK_HOUSE_EMAIL : FWK_HOST_EMAIL;
  const password = role === 'house' ? FWK_HOUSE_PASSWORD : FWK_HOST_PASSWORD;

  if (!email || !password) {
    throw new Error(`FWK ${role} credentials not configured (set FWK_${role === 'house' ? 'PROD' : 'HOST'}_EMAIL and FWK_${role === 'house' ? 'PROD' : 'HOST'}_PASSWORD)`);
  }

  const res = await fetch(`${FWK_API}/User/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FWK ${role} login failed (${res.status}): ${text}`);
  }
  const data = await res.json() as any;
  const jwt = data.token || data.jwt || data;
  if (typeof jwt !== 'string') throw new Error(`Unexpected FWK login response: ${JSON.stringify(data).slice(0, 200)}`);
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    fwkTokenCaches[role] = { token: jwt, exp: payload.exp || Date.now() / 1000 + 3600 };
  } catch {
    fwkTokenCaches[role] = { token: jwt, exp: Date.now() / 1000 + 3600 };
  }
  return jwt;
}

// Scheduled message system
// Deduplication for webhook events (prevents double-sends)
const recentWebhookKeys = new Set<string>();
function isDuplicateWebhook(key: string, ttlMs = 30000): boolean {
  if (recentWebhookKeys.has(key)) return true;
  recentWebhookKeys.add(key);
  setTimeout(() => recentWebhookKeys.delete(key), ttlMs);
  return false;
}

// Environment variables
const EDGE_FUNCTION_BASE_URL = process.env.EDGE_FUNCTION_BASE_URL!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "default-secret";

// Simple auth middleware for webhooks
function verifyWebhookSecret(req: express.Request, res: express.Response, next: express.NextFunction) {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// WhatsApp endpoints removed — WhatsApp is fully disabled to prevent account bans.
// All notifications go through Telegram only.

// Legacy endpoint: still called by the Supabase database trigger (notify_whatsapp_on_signup).
// Routes signup/cancellation messages to Telegram instead of WhatsApp.
app.post('/api/whatsapp/test', async (req, res) => {
  try {
    const { message } = req.body;
    const msg = message || '';

    const tg = getTelegramService();
    let telegramSent = false;
    if (tg.isConfigured() && tg.hasDefaultChat()) {
      const result = await tg.sendMessage(msg, undefined, 'webhook');
      telegramSent = result.ok;
    }

    res.json({ success: telegramSent, telegram: telegramSent });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error sending message' });
  }
});

// Webhook: Player cancelled
app.post('/api/webhook/player-cancelled', verifyWebhookSecret, async (req, res) => {
  try {
    const { playerName, promotedPlayerName, remainingSpots, currentCount, maxPlayers } = req.body;
    const dedupKey = `cancelled:${playerName}`;
    if (isDuplicateWebhook(dedupKey)) return res.json({ success: true, duplicate: true });

    const message = notificationService.generateCancellationNotification(playerName, promotedPlayerName, remainingSpots, currentCount, maxPlayers);

    // Send via Telegram only
    const tg = getTelegramService();
    let telegramSent = false;
    if (tg.isConfigured() && tg.hasDefaultChat()) {
      const result = await tg.sendMessage(message, undefined, 'webhook');
      telegramSent = result.ok;
    }

    res.json({ success: telegramSent, telegram: telegramSent });
  } catch (error) {
    console.error('Error in player-cancelled webhook:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Webhook: Player signed up
app.post('/api/webhook/player-signup', verifyWebhookSecret, async (req, res) => {
  try {
    const { playerName, currentCount, maxPlayers, remainingSpots } = req.body;
    const dedupKey = `signup:${playerName}`;
    if (isDuplicateWebhook(dedupKey)) return res.json({ success: true, duplicate: true });

    let message = notificationService.generateSignupNotification(playerName, currentCount, maxPlayers);
    if (remainingSpots === 1) message += '\n\n' + notificationService.generateOneSeatLeftNotification();
    else if (remainingSpots === 0) message = notificationService.generateTableFullNotification();

    // Send via Telegram only
    const tg = getTelegramService();
    let telegramSent = false;
    if (tg.isConfigured() && tg.hasDefaultChat()) {
      const result = await tg.sendMessage(message, undefined, 'webhook');
      telegramSent = result.ok;
    }

    res.json({ success: telegramSent, telegram: telegramSent });
  } catch (error) {
    console.error('Error in player-signup webhook:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Manual trigger for daily roster
// WhatsApp send/schedule endpoints removed — all messaging goes through Telegram only.

// FWK: Set user privilege (Player/Host/House)
// Requires House-level credentials to execute.
// privilegeId: 1 = Player, 2 = Host, 3 = House
app.post('/api/fwk/set-user-privilege', async (req, res) => {
  try {
    const { userId, privilegeId } = req.body;
    if (!userId || typeof userId !== 'number') {
      return res.status(400).json({ error: 'userId (number) is required' });
    }
    if (!privilegeId || typeof privilegeId !== 'number' || ![1, 2, 3].includes(privilegeId)) {
      return res.status(400).json({ error: 'privilegeId must be 1 (Player), 2 (Host), or 3 (House)' });
    }

    const token = await getFwkToken('house');
    const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

    const apiRes = await fetch(`${FWK_API}/User/SetPrivilege`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, privilegeId }),
    });

    const text = await apiRes.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }

    console.log(`SetPrivilege: userId=${userId} privilegeId=${privilegeId} status=${apiRes.status} response=${text}`);

    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ success: false, error: data });
    }
    res.json({ success: true, userId, privilegeId, response: data });
  } catch (error) {
    console.error('SetPrivilege error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// FWK: Temporary promotion — promote player to host and schedule auto-demote
// Body: { userId: number, userName?: string, demoteAt?: ISO8601 }
// Default demoteAt is 9:00 AM next day (America/New_York)
interface PromotionRecord {
  userId: number;
  userName: string;
  promotedAt: string;
  demoteAt: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
}
const activePromotions = new Map<number, PromotionRecord>();

async function demoteUserToPlayer(userId: number): Promise<boolean> {
  try {
    const token = await getFwkToken('house');
    const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    const apiRes = await fetch(`${FWK_API}/User/SetPrivilege`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, privilegeId: 1 }),
    });
    console.log(`Auto-demote userId=${userId} status=${apiRes.status}`);
    return apiRes.ok;
  } catch (e) {
    console.error('Auto-demote error:', e);
    return false;
  }
}

app.post('/api/fwk/promote-player', async (req, res) => {
  try {
    const { userId, userName, demoteAt } = req.body;
    if (!userId || typeof userId !== 'number') {
      return res.status(400).json({ error: 'userId (number) is required' });
    }

    // Calculate demote time: default is tomorrow 9 AM in America/New_York
    let demoteTime: Date;
    if (demoteAt) {
      demoteTime = new Date(demoteAt);
      if (isNaN(demoteTime.getTime()) || demoteTime.getTime() < Date.now()) {
        return res.status(400).json({ error: 'demoteAt must be a valid future ISO timestamp' });
      }
    } else {
      // Default: 9 AM tomorrow in America/New_York
      const now = new Date();
      const nyNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const tomorrow9am = new Date(nyNow);
      tomorrow9am.setDate(tomorrow9am.getDate() + 1);
      tomorrow9am.setHours(9, 0, 0, 0);
      // Convert back to UTC for scheduling
      const offsetMs = tomorrow9am.getTime() - nyNow.getTime();
      demoteTime = new Date(now.getTime() + offsetMs);
    }

    // If user already promoted, clear the old timeout
    const existing = activePromotions.get(userId);
    if (existing) clearTimeout(existing.timeoutHandle);

    // Promote via SetPrivilege
    const token = await getFwkToken('house');
    const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    const apiRes = await fetch(`${FWK_API}/User/SetPrivilege`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, privilegeId: 2 }),
    });

    if (!apiRes.ok) {
      const text = await apiRes.text();
      return res.status(apiRes.status).json({ success: false, error: text });
    }

    // Schedule auto-demotion
    const delay = demoteTime.getTime() - Date.now();
    const timeoutHandle = setTimeout(async () => {
      await demoteUserToPlayer(userId);
      activePromotions.delete(userId);
    }, delay);

    const record: PromotionRecord = {
      userId,
      userName: userName || `User ${userId}`,
      promotedAt: new Date().toISOString(),
      demoteAt: demoteTime.toISOString(),
      timeoutHandle,
    };
    activePromotions.set(userId, record);

    console.log(`Promoted userId=${userId} (${record.userName}) to Host. Will auto-demote at ${record.demoteAt}`);
    res.json({
      success: true,
      userId,
      userName: record.userName,
      promotedAt: record.promotedAt,
      demoteAt: record.demoteAt,
    });
  } catch (error) {
    console.error('Promote player error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// List active promotions
app.get('/api/fwk/promotions', (req, res) => {
  const list = Array.from(activePromotions.values()).map(p => ({
    userId: p.userId,
    userName: p.userName,
    promotedAt: p.promotedAt,
    demoteAt: p.demoteAt,
  }));
  res.json(list);
});

// Cancel a promotion (manually demote)
app.post('/api/fwk/demote-player', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || typeof userId !== 'number') {
      return res.status(400).json({ error: 'userId (number) is required' });
    }

    const ok = await demoteUserToPlayer(userId);
    if (!ok) return res.status(500).json({ success: false, error: 'Demote API call failed' });

    const record = activePromotions.get(userId);
    if (record) {
      clearTimeout(record.timeoutHandle);
      activePromotions.delete(userId);
    }

    res.json({ success: true, userId });
  } catch (error) {
    console.error('Demote player error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// FWK: Create poker table (reusable function)
async function createFwkTable(title: string, role: 'house' | 'host' = 'host'): Promise<{ ok: boolean; status: number; data: any }> {
  const token = await getFwkToken(role);
  const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  const apiRes = await fetch(`${FWK_API}/Table/CreateTable`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title, roundTime: 8, betTime: 10, purchaseCardTime: 15, PurchaseWallStTime: 30,
      declarationTime: 10, DeclarationWallStTime: 20, garbageTime: 25, gameType: 1, isFreez: true,
      IsSupportVideo: true, price: 0, seatOption: 0, smallBlindBet: 1, bigBlindBet: 2, AllIn: true,
      CardByCard: { CardIndex: 0, sort: 2 }, DealerChoiceType: 0, declarationOption: 0,
    }),
  });
  const data = await apiRes.json() as any;
  return { ok: apiRes.ok, status: apiRes.status, data };
}

function todayTableTitle(): string {
  const now = new Date();
  // Use NY timezone date for the title
  const nyDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${String(nyDate.getMonth() + 1).padStart(2, '0')}-${String(nyDate.getDate()).padStart(2, '0')}-${nyDate.getFullYear()}`;
}

// Track all created tables (manual + scheduled) with timestamps for history view
interface AutoTableRecord {
  id: number | null;
  title: string;
  password: string | null;
  link: string | null;
  createdAt: string;
  createdBy: 'scheduled' | 'manual';
  createdAs: 'house' | 'host';
  status: 'success' | 'error';
  error?: string;
}
let lastAutoTable: AutoTableRecord | null = null;
const tableHistory: AutoTableRecord[] = [];
const TABLE_HISTORY_MAX = 50;

function recordTableCreation(record: AutoTableRecord) {
  tableHistory.unshift(record);
  if (tableHistory.length > TABLE_HISTORY_MAX) {
    tableHistory.length = TABLE_HISTORY_MAX;
  }
  if (record.createdBy === 'scheduled') {
    lastAutoTable = record;
  }
}

// FWK: Create poker table endpoint
// Default role is 'host' so hosts (Larry, Tomer) can start the table.
// Pass { role: "house" } in the body to create as Shlomo (house) instead.
app.post('/api/fwk/create-table', async (req, res) => {
  try {
    const { title, role } = req.body;
    const tableRole: 'house' | 'host' = role === 'house' ? 'house' : 'host';
    const tableTitle = title || todayTableTitle();
    const result = await createFwkTable(tableTitle, tableRole);
    console.log(`Table created as ${tableRole}: ${tableTitle}, status=${result.status}`);

    // Record in history
    const tableId = result.data?.id ?? result.data?.tableId ?? null;
    const password = result.data?.password ?? null;
    recordTableCreation({
      id: tableId,
      title: tableTitle,
      password,
      link: tableId ? `https://app.friendswithkings.com/app/table/${tableId}?password=${password || 'direct'}` : null,
      createdAt: new Date().toISOString(),
      createdBy: 'manual',
      createdAs: tableRole,
      status: result.ok ? 'success' : 'error',
      error: result.ok ? undefined : `HTTP ${result.status}: ${JSON.stringify(result.data)}`,
    });

    res.status(result.status).json({ ...result.data, createdAs: tableRole });
  } catch (error) {
    console.error('Create table error:', error);
    recordTableCreation({
      id: null,
      title: req.body?.title || todayTableTitle(),
      password: null,
      link: null,
      createdAt: new Date().toISOString(),
      createdBy: 'manual',
      createdAs: req.body?.role === 'house' ? 'house' : 'host',
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Get table creation history
app.get('/api/fwk/table-history', (req, res) => {
  res.json(tableHistory);
});

async function runScheduledTableCreation(): Promise<AutoTableRecord> {
  const title = todayTableTitle();
  console.log(`[SCHEDULED] Creating table: ${title}`);

  try {
    const result = await createFwkTable(title, 'host');
    if (!result.ok) {
      const record: AutoTableRecord = {
        id: null,
        title,
        password: null,
        link: null,
        createdAt: new Date().toISOString(),
        createdBy: 'scheduled',
        createdAs: 'host',
        status: 'error',
        error: `FWK API returned ${result.status}: ${JSON.stringify(result.data)}`,
      };
      console.error('[SCHEDULED] Table creation failed:', record.error);
      recordTableCreation(record);
      return record;
    }

    const tableId = result.data?.id ?? result.data?.tableId ?? null;
    const password = result.data?.password ?? null;
    const record: AutoTableRecord = {
      id: tableId,
      title,
      password,
      link: tableId ? `https://app.friendswithkings.com/app/table/${tableId}?password=${password || 'direct'}` : null,
      createdAt: new Date().toISOString(),
      createdBy: 'scheduled',
      createdAs: 'host',
      status: 'success',
    };
    console.log(`[SCHEDULED] Table created: id=${tableId}, title=${title}`);
    recordTableCreation(record);
    return record;
  } catch (error) {
    const record: AutoTableRecord = {
      id: null,
      title,
      password: null,
      link: null,
      createdAt: new Date().toISOString(),
      createdBy: 'scheduled',
      createdAs: 'host',
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    console.error('[SCHEDULED] Exception during table creation:', error);
    recordTableCreation(record);
    return record;
  }
}

// ==========================================================================
// Telegram automated sends (roster + table link)
// ==========================================================================

// Helper: fetch roster and send via Telegram
async function sendRosterViaTelegram(source: string = 'roster'): Promise<boolean> {
  const tg = getTelegramService();
  if (!tg.isConfigured() || !tg.hasDefaultChat()) {
    console.log('[TELEGRAM ROSTER] Skipped — Telegram not fully configured');
    return false;
  }

  try {
    const response = await fetch(`${EDGE_FUNCTION_BASE_URL}/get-roster`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': WEBHOOK_SECRET,
      },
    });

    if (!response.ok) {
      console.error(`[TELEGRAM ROSTER] Failed to fetch roster: ${response.statusText}`);
      return false;
    }

    const rosterData = await response.json() as any;
    if (!rosterData.hasGame) {
      console.log('[TELEGRAM ROSTER] No game scheduled for today — skipping');
      return false;
    }

    const confirmedPlayers = rosterData.confirmedPlayers.map((p: any) => ({
      display_name: p.name,
      signed_up_at: p.signed_up_at,
    }));
    const waitlistPlayers = rosterData.waitlistPlayers.map((p: any) => ({
      display_name: p.name,
      added_at: p.added_at,
    }));
    const availablePlayers = rosterData.availablePlayers.map((p: any) => ({
      display_name: p.name,
    }));

    const message = notificationService.generateDailyRoster(
      {
        date: rosterData.date,
        time: rosterData.timeRange,
        confirmedPlayers,
        waitlist: waitlistPlayers,
        maxPlayers: rosterData.maxPlayers,
      },
      availablePlayers
    );

    const result = await tg.sendMessage(message, undefined, source);
    console.log(`[TELEGRAM ROSTER] ${result.ok ? 'Sent' : 'Failed'}: ${result.error || 'OK'}`);
    return result.ok;
  } catch (error) {
    console.error('[TELEGRAM ROSTER] Exception:', error);
    return false;
  }
}

// Schedule: send roster at 6:00 AM America/New_York
const roster6amCron = cron.schedule('0 6 * * *', async () => {
  console.log('[CRON] 6:00 AM roster send triggered');
  await sendRosterViaTelegram('6am-roster');
}, { timezone: 'America/New_York' });
console.log('Scheduled Telegram roster: 6:00 AM America/New_York daily');

// Schedule: send roster at 12:00 PM America/New_York
const roster12pmCron = cron.schedule('0 12 * * *', async () => {
  console.log('[CRON] 12:00 PM roster send triggered');
  await sendRosterViaTelegram('12pm-roster');
}, { timezone: 'America/New_York' });
console.log('Scheduled Telegram roster: 12:00 PM America/New_York daily');

// Schedule: create table daily at 7:30 PM America/New_York
// After creation, send the table link to Telegram
const autoTableCron = cron.schedule('30 19 * * *', async () => {
  const record = await runScheduledTableCreation();

  // Send table link to Telegram if creation succeeded
  if (record.status === 'success' && record.link) {
    const tg = getTelegramService();
    if (tg.isConfigured() && tg.hasDefaultChat()) {
      const message = `🃏 Tonight's poker table is ready!\n\nJoin here: ${record.link}\n\nTable: ${record.title} (ID: ${record.id})`;
      const result = await tg.sendMessage(message, undefined, '7:30pm-table');
      console.log(`[CRON] Table link sent to Telegram: ${result.ok ? 'OK' : result.error}`);
    }
  }
}, { timezone: 'America/New_York' });
console.log('Scheduled auto-table creation + Telegram link: 7:30 PM America/New_York daily');

// ==========================================================================
// Auto-cleanup of unused tables at 1 AM NY time
// ==========================================================================

interface TableCleanupRecord {
  tableId: number;
  title: string;
  action: 'deleted' | 'kept' | 'delete-failed';
  reason: string;
  checkedAt: string;
  playersCount?: number;
  step?: number;
}

const cleanupHistory: TableCleanupRecord[] = [];
const CLEANUP_HISTORY_MAX = 50;

function recordCleanup(record: TableCleanupRecord) {
  cleanupHistory.unshift(record);
  if (cleanupHistory.length > CLEANUP_HISTORY_MAX) {
    cleanupHistory.length = CLEANUP_HISTORY_MAX;
  }
}

// Fetch table details from FWK to check if it was used
async function getFwkTableDetails(tableId: number): Promise<{ ok: boolean; data: any; error?: string }> {
  try {
    const token = await getFwkToken('house');
    const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    const res = await fetch(`${FWK_API}/Table/GetTable?tableId=${tableId}`, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, data: null, error: `HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, data: null, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Delete a table on FWK
// TODO: The exact endpoint is not yet known. The user will capture it via
// DevTools by deleting a test table and watching the Network tab. Once known,
// update the URL/method/body below. Candidates:
//   POST /api/Table/DeleteTable   body: { tableId }
//   POST /api/Table/Delete/{id}
//   DELETE /api/Table/{id}
async function deleteFwkTable(tableId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await getFwkToken('house');
    const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

    // Try the most likely candidate first
    const res = await fetch(`${FWK_API}/Table/DeleteTable`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Decide whether a table was actually used for a game
// Returns { used, playersCount, step, reason }
function wasTableUsed(tableData: any): { used: boolean; playersCount: number; step: number; reason: string } {
  const players = Array.isArray(tableData?.players) ? tableData.players : [];
  const playersCount = players.length;
  const step = typeof tableData?.step === 'number' ? tableData.step : 0;

  // If a game was started (step > 0), the table was used
  if (step > 0) {
    return { used: true, playersCount, step, reason: `Game in progress or finished (step=${step})` };
  }

  // If nobody joined, definitely unused
  if (playersCount === 0) {
    return { used: false, playersCount, step, reason: 'No players ever joined' };
  }

  // Players joined but game never started — still counts as "unused" for auto-cleanup
  return { used: false, playersCount, step, reason: `${playersCount} player(s) joined but game never started` };
}

// Main cleanup function — runs at 1 AM NY time
async function runTableCleanup(): Promise<TableCleanupRecord[]> {
  console.log('[CLEANUP] Starting 1 AM unused-tables cleanup');
  const results: TableCleanupRecord[] = [];

  // Find all scheduled tables created in the last 12 hours
  const now = Date.now();
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  const candidateTables = tableHistory.filter(
    (t) =>
      t.createdBy === 'scheduled' &&
      t.status === 'success' &&
      t.id !== null &&
      now - new Date(t.createdAt).getTime() < TWELVE_HOURS_MS
  );

  console.log(`[CLEANUP] Found ${candidateTables.length} candidate table(s) to check`);

  for (const table of candidateTables) {
    if (!table.id) continue;

    const details = await getFwkTableDetails(table.id);
    if (!details.ok) {
      const record: TableCleanupRecord = {
        tableId: table.id,
        title: table.title,
        action: 'kept',
        reason: `Could not fetch table details: ${details.error}`,
        checkedAt: new Date().toISOString(),
      };
      console.warn(`[CLEANUP] Keeping table ${table.id}: ${record.reason}`);
      recordCleanup(record);
      results.push(record);
      continue;
    }

    const usage = wasTableUsed(details.data);

    if (usage.used) {
      const record: TableCleanupRecord = {
        tableId: table.id,
        title: table.title,
        action: 'kept',
        reason: usage.reason,
        checkedAt: new Date().toISOString(),
        playersCount: usage.playersCount,
        step: usage.step,
      };
      console.log(`[CLEANUP] Keeping table ${table.id}: ${record.reason}`);
      recordCleanup(record);
      results.push(record);
      continue;
    }

    // Table was not used — delete it
    const deleteResult = await deleteFwkTable(table.id);
    const record: TableCleanupRecord = {
      tableId: table.id,
      title: table.title,
      action: deleteResult.ok ? 'deleted' : 'delete-failed',
      reason: deleteResult.ok
        ? `Unused table deleted (${usage.reason})`
        : `Delete failed: ${deleteResult.error}`,
      checkedAt: new Date().toISOString(),
      playersCount: usage.playersCount,
      step: usage.step,
    };
    console.log(`[CLEANUP] Table ${table.id}: ${record.action} — ${record.reason}`);
    recordCleanup(record);
    results.push(record);
  }

  console.log(`[CLEANUP] Done. ${results.length} table(s) processed`);
  return results;
}

// Schedule: cleanup at 1:00 AM America/New_York daily
const cleanupCron = cron.schedule('0 1 * * *', async () => {
  await runTableCleanup();
}, { timezone: 'America/New_York' });
console.log('Scheduled table cleanup: 1:00 AM America/New_York daily');

// Endpoint: get cleanup history
app.get('/api/fwk/cleanup-history', (req, res) => {
  res.json(cleanupHistory);
});

// Endpoint: manually trigger cleanup now (for testing)
app.post('/api/fwk/run-cleanup-now', async (req, res) => {
  try {
    const results = await runTableCleanup();
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ==========================================================================

// Endpoint: get last auto-created table
app.get('/api/fwk/last-auto-table', (req, res) => {
  res.json(lastAutoTable || { message: 'No auto-created table yet' });
});

// Endpoint: manually trigger the scheduled job (for testing)
app.post('/api/fwk/run-scheduled-table-now', async (req, res) => {
  try {
    const record = await runScheduledTableCreation();
    res.json(record);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ==========================================================================
// Telegram Bot Integration
// ==========================================================================

// Telegram: status check
app.get('/api/telegram/status', async (req, res) => {
  const tg = getTelegramService();
  if (!tg.isConfigured()) {
    return res.json({ configured: false, message: 'TELEGRAM_BOT_TOKEN not set' });
  }
  const botInfo = await tg.getMe();
  res.json({
    configured: true,
    hasDefaultChat: tg.hasDefaultChat(),
    defaultChatId: tg.getDefaultChatId() || null,
    bot: botInfo ? { id: botInfo.id, name: botInfo.first_name, username: botInfo.username } : null,
  });
});

// Telegram: discover groups the bot has been added to
app.get('/api/telegram/discover-groups', async (req, res) => {
  const tg = getTelegramService();
  if (!tg.isConfigured()) {
    return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  }
  const groups = await tg.discoverGroups();
  res.json({ groups });
});

// Telegram: send a message to the default group (or specify chatId)
app.post('/api/telegram/send', async (req, res) => {
  try {
    const { message, chatId } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const tg = getTelegramService();
    const result = await tg.sendMessage(message, chatId || undefined);
    if (result.ok) {
      res.json({ success: true, messageId: result.messageId });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Telegram: send roster to default group
app.post('/api/telegram/send-roster-now', async (req, res) => {
  try {
    const tg = getTelegramService();
    if (!tg.isConfigured() || !tg.hasDefaultChat()) {
      return res.status(400).json({ error: 'Telegram not fully configured (need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)' });
    }

    // Fetch roster and send via Telegram
    const scheduler = getScheduler({
      enabled: true,
      dailyRosterTime: '0 6 * * *',
      edgeFunctionUrl: `${EDGE_FUNCTION_BASE_URL}/get-roster`,
      webhookSecret: WEBHOOK_SECRET,
    });

    // Fetch roster data
    const response = await fetch(`${EDGE_FUNCTION_BASE_URL}/get-roster`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': WEBHOOK_SECRET,
      },
    });

    if (!response.ok) {
      return res.status(500).json({ error: `Failed to fetch roster: ${response.statusText}` });
    }

    const rosterData = await response.json() as any;
    if (!rosterData.hasGame) {
      return res.json({ success: true, message: 'No game scheduled for today' });
    }

    const confirmedPlayers = rosterData.confirmedPlayers.map((p: any) => ({
      display_name: p.name,
      signed_up_at: p.signed_up_at,
    }));
    const waitlistPlayers = rosterData.waitlistPlayers.map((p: any) => ({
      display_name: p.name,
      added_at: p.added_at,
    }));
    const availablePlayers = rosterData.availablePlayers.map((p: any) => ({
      display_name: p.name,
    }));

    const message = notificationService.generateDailyRoster(
      {
        date: rosterData.date,
        time: rosterData.timeRange,
        confirmedPlayers,
        waitlist: waitlistPlayers,
        maxPlayers: rosterData.maxPlayers,
      },
      availablePlayers
    );

    const result = await tg.sendMessage(message);
    if (result.ok) {
      res.json({ success: true, message: 'Roster sent to Telegram' });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Telegram send-roster error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Telegram: message log for admin panel
app.get('/api/telegram/log', (req, res) => {
  res.json(getTelegramLog());
});

// Telegram: group members
app.get('/api/telegram/members', async (req, res) => {
  const tg = getTelegramService();
  if (!tg.isConfigured() || !tg.hasDefaultChat()) {
    return res.status(400).json({ error: 'Telegram not configured' });
  }
  const [members, count] = await Promise.all([
    tg.getKnownMembers(),
    tg.getChatMemberCount(),
  ]);
  res.json({ totalCount: count, members });
});

// Telegram: generate invite link for the group
app.get('/api/telegram/invite-link', async (req, res) => {
  const tg = getTelegramService();
  if (!tg.isConfigured() || !tg.hasDefaultChat()) {
    return res.status(400).json({ error: 'Telegram not configured' });
  }
  try {
    const apiRes = await fetch(
      `${TELEGRAM_API}/bot${process.env.TELEGRAM_BOT_TOKEN}/exportChatInviteLink`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tg.getDefaultChatId() }),
      }
    );
    const data = await apiRes.json() as any;
    if (data.ok) {
      res.json({ success: true, inviteLink: data.result });
    } else {
      res.status(500).json({ success: false, error: data.description });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

const TELEGRAM_API = 'https://api.telegram.org';

// ==========================================================================

// Serve the FWK API reference document as rendered HTML
// This is served from the Railway server so it doesn't require GitHub access
app.get('/docs/fwk-api', async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Try a few possible locations for the markdown file
    const candidates = [
      path.join(__dirname, '..', 'FWK_API_REFERENCE.md'),
      path.join(__dirname, '..', '..', 'FWK_API_REFERENCE.md'),
      path.join(process.cwd(), 'FWK_API_REFERENCE.md'),
      '/app/FWK_API_REFERENCE.md',
    ];

    let markdown: string | null = null;
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          markdown = fs.readFileSync(p, 'utf-8');
          break;
        }
      } catch { /* try next */ }
    }

    if (!markdown) {
      return res.status(404).send('<h1>FWK API Reference not found</h1><p>The document file could not be located on the server.</p>');
    }

    // Escape HTML special chars in the markdown so we can safely embed it in a script tag
    const escapedMarkdown = markdown
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FWK API Reference</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-dark.min.css">
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  body {
    background: #0d1117;
    color: #c9d1d9;
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .markdown-body {
    max-width: 980px;
    margin: 0 auto;
    padding: 40px 60px;
    box-sizing: border-box;
  }
  @media (max-width: 767px) {
    .markdown-body { padding: 20px; }
  }
  .header {
    background: #161b22;
    border-bottom: 1px solid #30363d;
    padding: 12px 24px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .header a {
    color: #58a6ff;
    text-decoration: none;
    font-size: 14px;
  }
  .header a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="header">
  <a href="https://friendswithkings.com/admin">← Back to Admin</a>
</div>
<article class="markdown-body" id="content">Loading...</article>
<script>
  const markdown = \`${escapedMarkdown}\`;
  document.getElementById('content').innerHTML = marked.parse(markdown);
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('Error serving FWK API doc:', error);
    res.status(500).send(`<h1>Error</h1><pre>${error instanceof Error ? error.message : 'Unknown error'}</pre>`);
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`FWK server running on port ${PORT}`);
  console.log('WhatsApp fully disabled. All notifications go through Telegram.');
});
