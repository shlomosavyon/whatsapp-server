import cron from "node-cron";
import { getWhatsAppService } from './whatsapp-service';
import { notificationService } from './notification-service';

interface SchedulerConfig {
  enabled: boolean;
  dailyRosterTime: string;
  edgeFunctionUrl: string;
  webhookSecret: string;
}

interface RosterData {
  hasGame: boolean;
  date: string;
  timeRange: string;
  confirmedPlayers: Array<{ name: string }>;
  waitlistPlayers: Array<{ name: string }>;
  availablePlayers: Array<{ name: string }>;
  maxPlayers: number;
}

class NotificationScheduler {
  private dailyRosterTask: cron.ScheduledTask | null = null;
  private config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  startDailyRoster(): void {
    if (!this.config.enabled) {
      console.log('Scheduler is disabled');
      return;
    }

    if (this.dailyRosterTask) {
      this.dailyRosterTask.stop();
    }

    console.log(`Starting daily roster scheduler: ${this.config.dailyRosterTime}`);
    
    this.dailyRosterTask = cron.schedule(this.config.dailyRosterTime, async () => {
      console.log('Running daily roster notification...');
      await this.sendDailyRoster();
    }, {
      timezone: 'America/New_York'
    });

    console.log('Daily roster scheduler started successfully');
  }

  private async sendDailyRoster(): Promise<void> {
    try {
      const whatsapp = getWhatsAppService();
      
      if (!whatsapp.getConnectionStatus()) {
        console.error("WhatsApp is not connected. Cannot send daily roster.");
        return;
      }

      const response = await fetch(`${this.config.edgeFunctionUrl}/get-roster`, {
        method: 'GET',
        headers: {
          'x-webhook-secret': this.config.webhookSecret
        }
      });

      if (!response.ok) {
        console.error('Failed to fetch roster data:', response.statusText);
        return;
      }

      const rosterData: RosterData = await response.json();

      if (!rosterData.hasGame) {
        console.log('No game scheduled, skipping daily roster');
        return;
      }

      const message = notificationService.generateDailyRosterNotification(rosterData);
      
      await whatsapp.sendMessage(message);
      console.log('Daily roster sent successfully');
    } catch (error) {
      console.error('Error sending daily roster:', error);
    }
  }

  async triggerDailyRosterNow(): Promise<void> {
    console.log('Manually triggering daily roster...');
    await this.sendDailyRoster();
  }

  stopDailyRoster(): void {
    if (this.dailyRosterTask) {
      this.dailyRosterTask.stop();
      console.log('Daily roster scheduler stopped');
    }
  }
}

let schedulerInstance: NotificationScheduler | null = null;

export function getScheduler(config?: SchedulerConfig): NotificationScheduler {
  if (!schedulerInstance && config) {
    schedulerInstance = new NotificationScheduler(config);
  }
  
  if (!schedulerInstance) {
    throw new Error('Scheduler not initialized. Provide config on first call.');
  }
  
  return schedulerInstance;
}

export { NotificationScheduler };
