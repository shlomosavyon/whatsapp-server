import makeWASocket, { DisconnectReason, useMultiFileAuthState, WASocket, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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
  private latestQR: string | null = null;

  constructor(config: WhatsAppConfig) {
    this.config = config;
    this.ensureSessionDirectory();
  }

  private ensureSessionDirectory(): void {
    if (!existsSync(this.config.sessionPath)) {
      mkdirSync(this.config.sessionPath, { recursive: true });
    }
  }

  private clearSession(): void {
    try {
      rmSync(this.config.sessionPath, { recursive: true, force: true });
      mkdirSync(this.config.sessionPath, { recursive: true });
      console.log('Cleared old session data for fresh QR');
    } catch (e) {
      console.log('No old session to clear');
    }
  }

  getLatestQR(): string | null {
    return this.latestQR;
  }

  async connect(): Promise<void> {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.end(undefined);
      } catch (e) {
        console.log('Error closing existing socket:', e);
      }
      this.sock = null;
    }

    this.latestQR = null;
    this.isConnected = false;

    this.clearSession();

    const { state, saveCreds } = await useMultiFileAuthState(this.config.sessionPath);

    const { version } = await fetchLatestBaileysVersion();
    console.log('Using WA version:', version);

    this.sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('QR code received and stored');
        this.latestQR = qr;
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed. Status code:', statusCode, 'Reconnecting:', shouldReconnect);
        
        if (shouldReconnect) {
          console.log('Auto-reconnecting...');
          const { state: newState, saveCreds: newSaveCreds } = await useMultiFileAuthState(this.config.sessionPath);
          this.sock = makeWASocket({
            auth: newState,
            version,
            printQRInTerminal: false,
          });
          this.sock.ev.on('creds.update', newSaveCreds);
          this.sock.ev.on('connection.update', async (u) => {
            if (u.connection === 'open') {
              console.log('Reconnected successfully');
              this.isConnected = true;
            } else if (u.connection === 'close') {
              console.log('Reconnect failed');
              this.isConnected = false;
            }
          });
        } else {
          this.isConnected = false;
        }
      } else if (connection === 'open') {
        console.log('WhatsApp connection established');
        this.isConnected = true;
        this.latestQR = null;
        await this.findGroupId();
      }
    });
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
    // Keep for compatibility
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {
        console.log('Error during logout:', e);
      }
      this.isConnected = false;
      this.sock = null;
      this.latestQR = null;
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
