import cron from "node-cron";
 // WhatsApp disabled — stub to prevent import errors
 const getWhatsAppService = () => ({ getConnectionStatus: () => false, sendMessage: async (_msg: string) => false });
import { notificationService } from './notification-service.js';
 
 interface SchedulerConfig {
   enabled: boolean;
   dailyRosterTime: string;
  edgeFunctionUrl: string;
  webhookSecret: string;
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
 
        // Fetch roster data from edge function
        const response = await fetch(this.config.edgeFunctionUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-webhook-secret": this.config.webhookSecret,
          },
        });
 
        if (!response.ok) {
          console.error("Failed to fetch roster:", response.statusText);
         return;
       }
 
        const rosterData = await response.json() as any;
 
        if (!rosterData.hasGame) {
          console.log("No game scheduled for today");
          return;
        }
 
         const confirmedPlayers = rosterData.confirmedPlayers.map((p: { name: string; signed_up_at?: string }) => ({
           display_name: p.name,
           signed_up_at: p.signed_up_at,
         }));
         const waitlistPlayers = rosterData.waitlistPlayers.map((p: { name: string; added_at?: string }) => ({
           display_name: p.name,
           added_at: p.added_at,
         }));
         const availablePlayers = rosterData.availablePlayers.map((p: { name: string }) => ({
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
 
       const success = await whatsapp.sendMessage(message);
 
       if (success) {
          console.log("Daily roster sent successfully");
       } else {
          console.error("Failed to send daily roster");
       }
     } catch (error) {
        console.error("Error sending daily roster:", error);
     }
   }
 
   stop(): void {
     if (this.dailyRosterTask) {
       this.dailyRosterTask.stop();
       this.dailyRosterTask = null;
      console.log("Daily roster scheduler stopped");
     }
   }
 
   async triggerDailyRosterNow(): Promise<void> {
    console.log("Manually triggering daily roster...");
     await this.sendDailyRoster();
   }
 }
 
 let scheduler: NotificationScheduler | null = null;
 
 export function getScheduler(config?: SchedulerConfig): NotificationScheduler {
   if (!scheduler && config) {
     scheduler = new NotificationScheduler(config);
   }
   return scheduler!;
 }
 
 export { NotificationScheduler };