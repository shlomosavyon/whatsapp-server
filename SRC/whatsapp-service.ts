import makeWASocket, { DisconnectReason, useMultiFileAuthState, WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import path from 'path';

interface WhatsAppConfig {
  sessionPath: string;
  groupName: string;
}

class WhatsAppService {
  private sock: WASocket | null = null;
  private config: WhatsAppConfig;
  private groupId: string | null = null;
  private isConnected: boolean = false;
  private qrCallback: ((qr: string) => void) | null = null;
  private isConnecting: boolean = false;

  constructor(config: WhatsAppConfig) {
    this.config = config;
    this.ensureSessionDirectory();
  }

  private ensureSessionDirectory(): void {
    if (!existsSync(this.config.sessionPath)) {
      mkdirSync(this.config.sessionPath, { recursive: true });
    }
  }

  async connect(): Promise<string | null> {
    // Prevent multiple simultaneous connection attempts
    if (this.isConnecting) {
      console.log('Already connecting, skipping...');
      return null;
    }
    this.isConnecting = true;

    // Clear old session to force fresh QR
    if (!this.isConnected) {
      try {
        rmSync(this.config.sessionPath, { recursive: true, force: true });
        mkdirSync(this.config.sessionPath, { recursive: true });
        console.log('Cleared old session data for fresh QR');
      } catch (e) {
        console.log('No old session to clear');
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.config.sessionPath);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    this.sock.ev.on('creds.update', saveCreds);

    let qrCode: string | null = null;

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('QR code received');
        qrCode = qr;
        if (this.qrCallback) {
          this.qrCallback(qr);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed. Reconnecting:', shouldReconnect);
        this.isConnecting = false;
        if (shouldReconnect && this.isConnected) {
          // Only auto-reconnect if we were previously connected (not during initial QR phase)
          await this.connect();
        } else {
          this.isConnected = false;
        }
      } else if (connection === 'open') {
        console.log('WhatsApp connection established');
        this.isConnected = true;
        this.isConnecting = false;
        await this.findGroupId();
      }
    });

    return qrCode;
  }

  private async findGroupId(): Promise<void> {
    if (!this.sock) return;

    try {
      const groups = await this.sock.groupFetchAllParticipating();

      console.log('Available WhatsApp groups:');
      Object.entries(groups).forEach(([, group]) => {
        console.log(`- ${(group as any).subject} (ID: ${(group as any).id})`);
      });

      const targetGroup = Object.entries(groups).find(
        ([, group]) => (group as any).subject.toLowerCase() === this.config.groupName.toLowerCase()
      );

      if (targetGroup) {
        this.groupId = targetGroup[0];
        console.log(`Found group "${this.config.groupName}" with ID: ${this.groupId}`);

        const configPath = path.join(this.config.sessionPath, 'group-config.json');
        writeFileSync(configPath, JSON.stringify({ groupId: this.groupId }));
      } else {
        console.error(`Group "${this.config.groupName}" not found`);
      }
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  }

  async sendMessage(message: string): Promise<boolean> {
    if (!this.isConnected || !this.sock) {
      console.error('WhatsApp is not connected');
      return false;
    }

    if (!this.groupId) {
      const configPath = path.join(this.config.sessionPath, 'group-config.json');
      if (existsSync(configPath)) {
        const savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        this.groupId = savedConfig.groupId;
      } else {
        console.error('Group ID not found. Please reconnect.');
        return false;
      }
    }

    try {
      await this.sock.sendMessage(this.groupId!, { text: message });
      console.log('Message sent successfully');
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      return false;
    }
  }

  setQRCallback(callback: ((qr: string) => void)): void {
    this.qrCallback = callback;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
      this.isConnected = false;
      this.isConnecting = false;
      this.sock = null;
    }
  }
}

let whatsappService: WhatsAppService | null = null;

export function getWhatsAppService(): WhatsAppService {
  if (!whatsappService) {
    whatsappService = new WhatsAppService({
      sessionPath: './whatsapp-session',
      groupName: process.env.WHATSAPP_GROUP_NAME || 'Tomer Table',
    });
  }
  return whatsappService;
}

export { WhatsAppService };
