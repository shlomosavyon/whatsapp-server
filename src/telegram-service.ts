/**
 * Telegram Bot Service
 *
 * Uses the official Telegram Bot API via plain HTTP fetch.
 * No extra npm packages needed — just the bot token.
 *
 * API reference: https://core.telegram.org/bots/api
 */

import { supabase } from './supabase-client.js';

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramConfig {
  botToken: string;
  defaultChatId?: string;
}

interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

// Message log for admin panel visibility
interface TelegramLogEntry {
  timestamp: string;
  type: 'text' | 'photo' | 'document';
  chatId: string;
  message: string;
  status: 'sent' | 'failed';
  messageId?: number;
  error?: string;
  source: string; // e.g., 'manual', '6am-roster', '12pm-roster', '7:30pm-table', 'webhook'
}

const messageLog: TelegramLogEntry[] = [];
const MESSAGE_LOG_MAX = 100;

function logMessage(entry: TelegramLogEntry) {
  messageLog.unshift(entry);
  if (messageLog.length > MESSAGE_LOG_MAX) {
    messageLog.length = MESSAGE_LOG_MAX;
  }
}

export function getTelegramLog(): TelegramLogEntry[] {
  return messageLog;
}

class TelegramService {
  private config: TelegramConfig;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  private get baseUrl(): string {
    return `${TELEGRAM_API}/bot${this.config.botToken}`;
  }

  // Send a text message to a chat (group or user)
  async sendMessage(text: string, chatId?: string, source: string = 'manual'): Promise<TelegramSendResult> {
    const targetChatId = chatId || this.config.defaultChatId;
    if (!targetChatId) {
      return { ok: false, error: 'No chat ID specified and no default configured' };
    }

    try {
      const res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      });

      const data = await res.json() as any;
      if (!data.ok) {
        console.error('Telegram sendMessage failed:', data.description);
        logMessage({
          timestamp: new Date().toISOString(),
          type: 'text',
          chatId: targetChatId,
          message: text.substring(0, 500),
          status: 'failed',
          error: data.description,
          source,
        });
        return { ok: false, error: data.description || 'Unknown Telegram error' };
      }

      console.log(`Telegram message sent to ${targetChatId}: ${text.substring(0, 50)}...`);
      logMessage({
        timestamp: new Date().toISOString(),
        type: 'text',
        chatId: targetChatId,
        message: text.substring(0, 500),
        status: 'sent',
        messageId: data.result?.message_id,
        source,
      });
      return { ok: true, messageId: data.result?.message_id };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Telegram sendMessage exception:', msg);
      logMessage({
        timestamp: new Date().toISOString(),
        type: 'text',
        chatId: targetChatId,
        message: text.substring(0, 500),
        status: 'failed',
        error: msg,
        source,
      });
      return { ok: false, error: msg };
    }
  }

  // Send a photo with optional caption
  async sendPhoto(photoUrl: string, caption?: string, chatId?: string): Promise<TelegramSendResult> {
    const targetChatId = chatId || this.config.defaultChatId;
    if (!targetChatId) {
      return { ok: false, error: 'No chat ID specified' };
    }

    try {
      const res = await fetch(`${this.baseUrl}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChatId,
          photo: photoUrl,
          caption: caption || undefined,
          parse_mode: 'HTML',
        }),
      });

      const data = await res.json() as any;
      if (!data.ok) {
        return { ok: false, error: data.description };
      }
      return { ok: true, messageId: data.result?.message_id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Send a document (file) with optional caption
  async sendDocument(documentUrl: string, caption?: string, chatId?: string): Promise<TelegramSendResult> {
    const targetChatId = chatId || this.config.defaultChatId;
    if (!targetChatId) {
      return { ok: false, error: 'No chat ID specified' };
    }

    try {
      const res = await fetch(`${this.baseUrl}/sendDocument`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChatId,
          document: documentUrl,
          caption: caption || undefined,
          parse_mode: 'HTML',
        }),
      });

      const data = await res.json() as any;
      if (!data.ok) {
        return { ok: false, error: data.description };
      }
      return { ok: true, messageId: data.result?.message_id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Get recent updates — useful for discovering the chat ID after bot is added to a group
  async getUpdates(): Promise<any[]> {
    try {
      const res = await fetch(`${this.baseUrl}/getUpdates?limit=50`);
      const data = await res.json() as any;
      if (!data.ok) {
        console.error('Telegram getUpdates failed:', data.description);
        return [];
      }
      return data.result || [];
    } catch (error) {
      console.error('Telegram getUpdates error:', error);
      return [];
    }
  }

  // Get bot info to verify the token works
  async getMe(): Promise<any> {
    try {
      const res = await fetch(`${this.baseUrl}/getMe`);
      const data = await res.json() as any;
      return data.ok ? data.result : null;
    } catch {
      return null;
    }
  }

  // Discover group chat IDs from recent updates
  async discoverGroups(): Promise<Array<{ chatId: string; title: string; type: string }>> {
    const updates = await this.getUpdates();
    const groups = new Map<string, { chatId: string; title: string; type: string }>();

    for (const update of updates) {
      const msg = update.message || update.my_chat_member?.chat;
      if (msg?.chat?.type === 'group' || msg?.chat?.type === 'supergroup') {
        const chatId = String(msg.chat.id);
        if (!groups.has(chatId)) {
          groups.set(chatId, {
            chatId,
            title: msg.chat.title || 'Unknown',
            type: msg.chat.type,
          });
        }
      }
    }

    return Array.from(groups.values());
  }

  // Get group member count
  async getChatMemberCount(chatId?: string): Promise<number> {
    const targetChatId = chatId || this.config.defaultChatId;
    if (!targetChatId) return 0;
    try {
      const res = await fetch(`${this.baseUrl}/getChatMemberCount?chat_id=${targetChatId}`);
      const data = await res.json() as any;
      return data.ok ? data.result : 0;
    } catch {
      return 0;
    }
  }

  // Get group admins (includes creator) — these are the only members we can list via API
  async getChatAdministrators(chatId?: string): Promise<any[]> {
    const targetChatId = chatId || this.config.defaultChatId;
    if (!targetChatId) return [];
    try {
      const res = await fetch(`${this.baseUrl}/getChatAdministrators?chat_id=${targetChatId}`);
      const data = await res.json() as any;
      return data.ok ? data.result : [];
    } catch {
      return [];
    }
  }

  // Scan recent updates for new_chat_members and build a member list
  // This catches people who joined via invite link
  async getKnownMembers(chatId?: string): Promise<Array<{ id: number; firstName: string; lastName?: string; username?: string; joinedAt?: string }>> {
    const targetChatId = chatId || this.config.defaultChatId;
    const members = new Map<number, { id: number; firstName: string; lastName?: string; username?: string; joinedAt?: string }>();
    const leftMemberIds = new Set<number>();

    // First add admins (always available)
    const admins = await this.getChatAdministrators(targetChatId);
    for (const admin of admins) {
      const u = admin.user;
      if (!u.is_bot) {
        members.set(u.id, {
          id: u.id,
          firstName: u.first_name,
          lastName: u.last_name,
          username: u.username,
        });
      }
    }

    // Then scan updates for new_chat_members events
    const updates = await this.getUpdates();
    for (const update of updates) {
      const msg = update.message;
      if (!msg) continue;
      const chat = msg.chat;
      if (targetChatId && String(chat?.id) !== String(targetChatId)) continue;

      // Track new members joining
      if (msg.new_chat_members) {
        for (const u of msg.new_chat_members) {
          if (!u.is_bot) {
            members.set(u.id, {
              id: u.id,
              firstName: u.first_name,
              lastName: u.last_name,
              username: u.username,
              joinedAt: new Date(msg.date * 1000).toISOString(),
            });
          }
        }
      }

      // Track anyone who sends a message (they're definitely a member)
      if (msg.from && !msg.from.is_bot) {
        if (!members.has(msg.from.id)) {
          members.set(msg.from.id, {
            id: msg.from.id,
            firstName: msg.from.first_name,
            lastName: msg.from.last_name,
            username: msg.from.username,
          });
        }
      }

      // Track left members
      if (msg.left_chat_member && !msg.left_chat_member.is_bot) {
        leftMemberIds.add(msg.left_chat_member.id);
        members.delete(msg.left_chat_member.id);
      }
    }

    // Persist discovered members to Supabase and merge with previously-seen members
    await this.syncMembersToSupabase(targetChatId!, members, leftMemberIds);
    const persisted = await this.getPersistedMembers(targetChatId!);

    // Merge: persisted as base, live data overwrites for freshness
    const merged = new Map<number, { id: number; firstName: string; lastName?: string; username?: string; joinedAt?: string }>();
    for (const m of persisted) {
      merged.set(m.id, m);
    }
    members.forEach((member, id) => {
      merged.set(id, member);
    });
    leftMemberIds.forEach(id => {
      merged.delete(id);
    });

    return Array.from(merged.values());
  }

  private async syncMembersToSupabase(
    chatId: string,
    members: Map<number, { id: number; firstName: string; lastName?: string; username?: string; joinedAt?: string }>,
    leftMemberIds: Set<number>
  ): Promise<void> {
    try {
      if (members.size > 0) {
        const rows = Array.from(members.values()).map(m => ({
          id: m.id,
          chat_id: chatId,
          first_name: m.firstName,
          last_name: m.lastName || null,
          username: m.username || null,
          joined_at: m.joinedAt || null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
        }));
        await supabase
          .from('telegram_members')
          .upsert(rows, { onConflict: 'id,chat_id' });
      }

      if (leftMemberIds.size > 0) {
        await supabase
          .from('telegram_members')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('chat_id', chatId)
          .in('id', Array.from(leftMemberIds));
      }
    } catch (err) {
      console.error('[telegram] Failed to sync members to Supabase:', err);
    }
  }

  private async getPersistedMembers(chatId: string): Promise<Array<{ id: number; firstName: string; lastName?: string; username?: string; joinedAt?: string }>> {
    try {
      const { data, error } = await supabase
        .from('telegram_members')
        .select('id, first_name, last_name, username, joined_at')
        .eq('chat_id', chatId)
        .eq('is_active', true);

      if (error || !data) return [];

      return data.map(row => ({
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name || undefined,
        username: row.username || undefined,
        joinedAt: row.joined_at || undefined,
      }));
    } catch {
      return [];
    }
  }

  // Check if bot token is configured
  isConfigured(): boolean {
    return !!this.config.botToken;
  }

  // Check if a default chat ID is set
  hasDefaultChat(): boolean {
    return !!this.config.defaultChatId;
  }

  getDefaultChatId(): string | undefined {
    return this.config.defaultChatId;
  }

  setDefaultChatId(chatId: string): void {
    this.config.defaultChatId = chatId;
  }
}

// Singleton
let telegramService: TelegramService | null = null;

export function getTelegramService(): TelegramService {
  if (!telegramService) {
    telegramService = new TelegramService({
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      defaultChatId: process.env.TELEGRAM_CHAT_ID || '',
    });
  }
  return telegramService;
}

export { TelegramService, TelegramSendResult };
