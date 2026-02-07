import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  WASocket
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';

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

  constructor(config: WhatsAppConfig) {
    this.config = config;
    this.ensureSessionDirectory();
  }

  private ensureSessionDirectory(): void {
    if (!fs.existsSync(this.config.sessionPath)) {
      fs.mkdirSync(this.config.sessionPath, { recursive: true });
    }
  }

  async connect(): Promise<string | null> {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.sessionPath);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    let qrCode: string | null = null;

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        if (this.qrCallback) {
          this.qrCallback(qr);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = 
          (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log('Connection closed. Reconnecting:', shouldReconnect);

        if (shouldReconnect) {
          await this.connect();
        } else {
          this.isConnected = false;
        }
      } else if (connection === 'open') {
        console.log('WhatsApp connection established');
        this.isConnected = true;
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
      Object.entries(groups).forEach(([id, group]) => {
        console.log(`- ${group.subject} (ID: ${id})`);
      });

      const targetGroup = Object.entries(groups).find(
        ([_, group]) => group.subject.toLowerCase() === this.config.groupName.toLowerCase()
      );

      if (targetGroup) {
        this.groupId = targetGroup[0];
        console.log(`Found group "${this.config.groupName}" with ID: ${this.groupId}`);

        const configPath = path.join(this.config.sessionPath, 'group-config.json');
        fs.writeFileSync(configPath, JSON.stringify({ groupId: this.groupId }));
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
      if (fs.existsSync(configPath)) {
        const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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

  setQRCallback(callback: (qr: string) => void): void {
    this.qrCallback = callback;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
      this.isConnected = false;
      this.sock = null;
    }
  }
}

let whatsappService: WhatsAppService | null = null;

export function getWhatsAppService(): WhatsAppService {
  if (!whatsappService) {
    whatsappService = new WhatsAppService({
      sessionPath: './whatsapp-session',
      groupName: process.env.WHATSAPP_GROUP_NAME || 'Tomer Table'
    });
  }
  return whatsappService;
}

export { WhatsAppService };
