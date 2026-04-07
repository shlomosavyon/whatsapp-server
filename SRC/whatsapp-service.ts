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
    private groupCache: Map<string, string> = new Map();
    private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 10;

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

    private startKeepAlive(): void {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(async () => {
            if (this.sock && this.isConnected) {
                try {
                    await this.sock.sendPresenceUpdate('available');
                } catch (e) {
                    console.log('[KeepAlive] Presence update failed, connection may be lost');
                }
            }
        }, 25 * 1000);
        console.log('[KeepAlive] Started - pinging every 25 seconds');
    }

    private stopKeepAlive(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
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
        this.stopKeepAlive();
        this.reconnectAttempts = 0;

        this.clearSession();

        const { state, saveCreds } = await useMultiFileAuthState(this.config.sessionPath);

        const { version } = await fetchLatestBaileysVersion();
        console.log('Using WA version:', version);

        this.sock = makeWASocket({
            auth: state,
            version: version as any,
            printQRInTerminal: false,
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000,
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.setupConnectionHandler(version);
    }

    private setupConnectionHandler(version: any): void {
        if (!this.sock) return;

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('QR code received and stored');
                this.latestQR = qr;
            }

            if (connection === 'close') {
                this.isConnected = false;
                this.stopKeepAlive();
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed. Status code:', statusCode, 'Reconnecting:', shouldReconnect);

                if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
                    console.log(`[Reconnect] Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay/1000}s...`);

                    setTimeout(async () => {
                        try {
                            const { state: newState, saveCreds: newSaveCreds } = await useMultiFileAuthState(this.config.sessionPath);
                            this.sock = makeWASocket({
                                auth: newState,
                                version: version as any,
                                printQRInTerminal: false,
                                keepAliveIntervalMs: 30000,
                                connectTimeoutMs: 60000,
                            });
                            this.sock.ev.on('creds.update', newSaveCreds);
                            this.setupConnectionHandler(version);
                        } catch (err) {
                            console.error('[Reconnect] Failed to create new socket:', err);
                        }
                    }, delay);
                } else if (!shouldReconnect) {
                    console.log('Logged out. QR scan needed via /api/whatsapp/connect');
                    this.isConnected = false;
                } else {
                    console.log(`[Reconnect] Max attempts (${this.maxReconnectAttempts}) reached. QR scan may be needed.`);
                    this.isConnected = false;
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connection established');
                this.isConnected = true;
                this.latestQR = null;
                this.reconnectAttempts = 0;
                this.startKeepAlive();
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
        this.reconnectAttempts = 0;

        const { state, saveCreds } = await useMultiFileAuthState(this.config.sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            auth: state,
            version: version as any,
            printQRInTerminal: false,
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000,
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
                this.reconnectAttempts = 0;
                this.startKeepAlive();
                await this.findGroupId();
            }

            if (connection === 'close') {
                this.isConnected = false;
                this.stopKeepAlive();
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
                    console.log(`[Auto-reconnect] Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay/1000}s...`);
                    setTimeout(() => this.autoReconnect(), delay);
                } else {
                    console.log('Logged out or max retries reached. QR scan needed via /api/whatsapp/connect');
                    this.isConnected = false;
                }
            }
        });
    }

    private async findGroupId(groupName?: string): Promise<string | null> {
        if (!this.sock) return null;

        const targetName = groupName || this.config.groupName;

        const cached = this.groupCache.get(targetName.toLowerCase());
        if (cached) {
            console.log(`Using cached group ID for "${targetName}": ${cached}`);
            if (!groupName) {
                this.groupId = cached;
            }
            return cached;
        }

        try {
            const groups = await this.sock.groupFetchAllParticipating();

            console.log('Available WhatsApp groups:');
            Object.entries(groups).forEach(([, group]) => {
                console.log(`- ${(group as any).subject} (ID: ${(group as any).id})`);
            });

            Object.entries(groups).forEach(([id, group]) => {
                const subject = (group as any).subject;
                this.groupCache.set(subject.toLowerCase(), id);
            });

            const targetGroup = Object.entries(groups).find(
                ([, group]) => (group as any).subject.toLowerCase() === targetName.toLowerCase()
            );

            if (targetGroup) {
                const foundId = targetGroup[0];
                console.log(`Found group "${targetName}" with ID: ${foundId}`);

                if (!groupName) {
                    this.groupId = foundId;
                    const configPath = path.join(this.config.sessionPath, 'group-config.json');
                    writeFileSync(configPath, JSON.stringify({ groupId: this.groupId }));
                }

                return foundId;
            } else {
                console.error(`Group "${targetName}" not found`);
                return null;
            }
        } catch (error) {
            console.error('Error fetching groups:', error);
            return null;
        }
    }

    async sendMessageWithAttachment(
        message: string | null,
        attachment: { data: Buffer; mimetype: string; filename: string } | null,
        groupName?: string
    ): Promise<boolean> {
        if (!this.isConnected || !this.sock) {
            console.error('WhatsApp is not connected');
            return false;
        }

        let targetGroupId: string | null = null;
        if (groupName) {
            targetGroupId = this.groupCache.get(groupName.toLowerCase()) || await this.findGroupId(groupName);
        } else {
            if (!this.groupId) {
                const configPath = path.join(this.config.sessionPath, 'group-config.json');
                if (existsSync(configPath)) {
                    const savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
                    this.groupId = savedConfig.groupId;
                }
            }
            targetGroupId = this.groupId;
        }

        if (!targetGroupId) {
            console.error('Group not found');
            return false;
        }

        try {
            if (attachment) {
                const { data, mimetype, filename } = attachment;
                let content: any;
                if (mimetype.startsWith('image/')) {
                    content = { image: data, ...(message ? { caption: message } : {}) };
                } else if (mimetype.startsWith('video/')) {
                    content = { video: data, ...(message ? { caption: message } : {}) };
                } else if (mimetype.startsWith('audio/')) {
                    content = { audio: data, mimetype };
                } else {
                    content = { document: data, mimetype, fileName: filename, ...(message ? { caption: message } : {}) };
                }
                await this.sock.sendMessage(targetGroupId, content);
                if (mimetype.startsWith('audio/') && message) {
                    await this.sock.sendMessage(targetGroupId, { text: message });
                }
            } else if (message) {
                await this.sock.sendMessage(targetGroupId, { text: message });
            }
            console.log(`Message sent successfully to ${groupName || this.config.groupName}`);
            return true;
        } catch (error) {
            console.error('Error sending message with attachment:', error);
            return false;
        }
    }

    async sendMessage(message: string, groupName?: string): Promise<boolean> {
        if (!this.isConnected || !this.sock) {
            console.error('WhatsApp is not connected');
            return false;
        }

        let targetGroupId: string | null = null;

        if (groupName) {
            targetGroupId = this.groupCache.get(groupName.toLowerCase()) || null;
            if (!targetGroupId) {
                targetGroupId = await this.findGroupId(groupName);
            }
            if (!targetGroupId) {
                console.error(`Group "${groupName}" not found`);
                return false;
            }
        } else {
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
            targetGroupId = this.groupId;
        }

        try {
            await this.sock.sendMessage(targetGroupId!, { text: message });
            console.log(`Message sent successfully to ${groupName || this.config.groupName}`);
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
        this.stopKeepAlive();
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
