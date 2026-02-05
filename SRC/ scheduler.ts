Here's `docs/whatsapp-server/src/scheduler.ts`:

```typescript
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
```

The file is 128 lines. It uses `node-cron` to schedule the 6 AM EST daily roster message, fetching data from the `get-roster` edge function and sending it via WhatsApp.

Show notification-service.ts
Show get-roster edge function
Show Dockerfile