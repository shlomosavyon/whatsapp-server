Here's `docs/whatsapp-server/src/notification-service.ts`:

```typescript
export class NotificationService {
  private websiteUrl = 'https://friendswithkings.com/calendar';

  // Generates morning roster message with confirmed players, open spots, and waitlist
  generateDailyRoster(game: GameData, allPlayers: Player[]): string {
    // "🃏 Good morning! Tonight's Game - Monday, January 20..."
    // Lists confirmed players, open spots, tags available players
  }

  // Generates cancellation notification with optional waitlist promotion
  generateCancellationNotification(
    cancelledPlayerName, promotedPlayerName, remainingSpots, currentCount, maxPlayers
  ): string {
    // "❌ Player Update - X has dropped out. ✅ Y moved from waitlist!"
  }

  // Generates signup notification
  generateSignupNotification(playerName, currentCount, maxPlayers): string {
    return `🎰 *${playerName}* just signed up! (${currentCount}/${maxPlayers} players)`;
  }

  generateOneSeatLeftNotification(): string {
    return `⚠️ *One seat left!* Last chance to join tonight's game.`;
  }

  generateTableFullNotification(): string {
    return `✅ *Table is now FULL!* All seats are taken. See you tonight! 🃏`;
  }
}

export const notificationService = new NotificationService();
```

The file is 101 lines. It formats all WhatsApp notification messages — daily roster, signups, cancellations, and capacity alerts.

Show get-roster edge function
Show Dockerfile
Show whatsapp-webhook edge function