interface Player {
  id: string;
  display_name: string | null;
  phone_number: string;
}

interface GameData {
  date: string;
  time: string;
  confirmedPlayers: Player[];
  waitlist: Player[];
  maxPlayers: number;
}

export class NotificationService {
  private websiteUrl = 'https://friendswithkings.com/calendar';

  generateDailyRoster(game: GameData, allPlayers: Player[]): string {
    const dayName = new Date(game.date).toLocaleDateString('en-US', { weekday: 'long' });
    const dateStr = new Date(game.date).toLocaleDateString('en-US', { 
      month: 'long', 
      day: 'numeric' 
    });

    let message = `🃏 *Good morning!*\n\n`;
    message += `*Tonight's Game - ${dayName}, ${dateStr}*\n`;
    message += `🕐 ${game.time}\n\n`;

    message += `*Confirmed Players (${game.confirmedPlayers.length}/${game.maxPlayers}):*\n`;
    game.confirmedPlayers.forEach((player, index) => {
      const name = player.display_name || player.phone_number.slice(-4);
      message += `${index + 1}. ${name}\n`;
    });

    const openSpots = game.maxPlayers - game.confirmedPlayers.length;
    if (openSpots > 0) {
      const confirmedIds = new Set(game.confirmedPlayers.map(p => p.id));
      const waitlistIds = new Set(game.waitlist.map(p => p.id));
      const availablePlayers = allPlayers.filter(
        p => !confirmedIds.has(p.id) && !waitlistIds.has(p.id)
      );

      if (availablePlayers.length > 0) {
        message += `\n🎯 *${openSpots} seat${openSpots > 1 ? 's' : ''} available!*\n\n`;
        message += `Hey `;
        message += availablePlayers.slice(0, 5).map(p => p.display_name || 'player').join(', ');
        if (availablePlayers.length > 5) message += ` and ${availablePlayers.length - 5} more`;
        message += ` - spots are open! First come, first serve.\n\n`;
        message += `👉 Sign up here: ${this.websiteUrl}`;
      }
    }

    if (game.waitlist.length > 0) {
      message += `\n\n*Waitlist (${game.waitlist.length}):*\n`;
      game.waitlist.forEach((player, index) => {
        const name = player.display_name || player.phone_number.slice(-4);
        message += `${index + 1}. ${name}\n`;
      });
    }

    return message;
  }

  generateCancellationNotification(
    cancelledPlayerName: string,
    promotedPlayerName: string | null,
    remainingSpots: number,
    currentCount: number,
    maxPlayers: number
  ): string {
    let message = `❌ *Player Update*\n\n`;
    message += `${cancelledPlayerName} has dropped out. (${currentCount}/${maxPlayers})\n`;

    if (promotedPlayerName) {
      message += `\n✅ ${promotedPlayerName} has been moved from waitlist!\n`;
    } else if (remainingSpots > 0) {
      message += `\n🎯 *${remainingSpots} seat${remainingSpots > 1 ? 's' : ''} now available!*\n`;
      message += `\n👉 Sign up here: ${this.websiteUrl}`;
    }

    return message;
  }

  generateSignupNotification(
    playerName: string,
    currentCount: number,
    maxPlayers: number
  ): string {
    return `🎰 *${playerName}* just signed up! (${currentCount}/${maxPlayers} players)`;
  }

  generateOneSeatLeftNotification(): string {
    return `⚠️ *One seat left!* Last chance to join tonight's game.\n\n👉 ${this.websiteUrl}`;
  }

  generateTableFullNotification(): string {
    return `✅ *Table is now FULL!* All seats are taken. See you tonight! 🃏`;
  }
}

export const notificationService = new NotificationService();
