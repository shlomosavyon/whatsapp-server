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
              await this.findGroupId();
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
  async autoReconnect(): Promise<void> {
    const credsPath = path.join(this.config.sessionPath, 'creds.json');
    if (!existsSync(credsPath)) {
      console.log('No saved WhatsApp session. QR scan needed via /api/whatsapp/connect');
      return;
    }

    console.log('Found saved WhatsApp session, auto-reconnecting...');
    this.isConnected = false;
    this.latestQR = null;

    const { state, saveCreds } = await useMultiFileAuthState(this.config.sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('Session expired. QR scan needed via /api/whatsapp/connect');
        return;
      }

      if (connection === 'open') {
        console.log('WhatsApp auto-reconnected successfully!');
        this.isConnected = true;
        await this.findGroupId();
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('Auto-reconnect closed. Status:', statusCode, 'Retry:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(() => this.autoReconnect(), 5000);
        } else {
          this.isConnected = false;
        }
      }
    });
  }
