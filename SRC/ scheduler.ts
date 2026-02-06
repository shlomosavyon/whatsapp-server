
import cron from "node-cron";
import { getWhatsAppService } from './whatsapp-service';
import { notificationService } from './notification-service';

class NotificationScheduler {
  private dailyRosterTask: cron.ScheduledTask | null = null;
  private config: SchedulerConfig;

  // Runs daily at 6 AM EST (configured via cron expression)
  startDailyRoster(): void { ... }

  // Fetches roster from get-roster edge function, generates message, sends to WhatsApp
  private async sendDailyRoster(): Promise {
    const response = await fetch(this.config.edgeFunctionUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": this.config.webhookSecret,
      },
    });
    // ... processes rosterData and sends via WhatsApp
  }

  stop(): void { ... }

  // Manual trigger endpoint
  async triggerDailyRosterNow(): Promise { ... }
}

// Singleton pattern
export function getScheduler(config?: SchedulerConfig): NotificationScheduler { ... }
