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

interface RosterPlayer {
  name: string;
  signedUpAt: string;
}

export class NotificationService {
  private websiteUrl = 'https://friendswithkings.com/calendar';

  private formatSignupTime(isoStr: string): string {
    if (!isoStr) return '';
    const dt = new Date(isoStr);
    // Convert to EST (UTC-5)
    const est = new Date(dt.getTime() - 5 * 60 * 60 * 1000);
    const month = est.getMonth() + 1;
    const day = est.getDate();
    const hours = est.getHours().toString().padStart(2, '0');
    const mins = est.getMinutes().toString().padStart(2, '0');
    return `${month}/${day} ${hours}:${mins}`;
  }

  private formatGameDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`;
  }

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

  generateDailyRosterNotification(rosterData: any): string {
    const dayName = new Date(rosterData.date).toLocaleDateString('en-US', { weekday: 'long' });
    const dateStr = new Date(rosterData.date).toLocaleDateString('en-US', { 
      month: 'long', 
      day: 'numeric' 
    });

    let message = `🃏 *Good morning!*\n\n`;
    message += `*Tonight's Game - ${dayName}, ${dateStr}*\n`;
    message += `🕐 ${rosterData.timeRange}\n\n`;
    
    message += `*Confirmed Players (${rosterData.confirmedPlayers.length}/${rosterData.maxPlayers}):*\n`;
    rosterData.confirmedPlayers.forEach((player: any, index: number) => {
      message += `${index + 1}. ${player.name}\n`;
    });

    const openSpots = rosterData.maxPlayers - rosterData.confirmedPlayers.length;
    
    if (openSpots > 0 && rosterData.availablePlayers.length > 0) {
      message += `\n🎯 *${openSpots} seat${openSpots > 1 ? 's' : ''} available!*\n\n`;
      message += `Hey `;
      message += rosterData.availablePlayers.slice(0, 5).map((p: any) => p.name).join(', ');
      if (rosterData.availablePlayers.length > 5) {
        message += ` and ${rosterData.availablePlayers.length - 5} more`;
      }
      message += ` - spots are open! First come, first serve.\n\n`;
      message += `👉 Sign up here: ${this.websiteUrl}`;
    }

    if (rosterData.waitlistPlayers.length > 0) {
      message += `\n\n*Waitlist (${rosterData.waitlistPlayers.length}):*\n`;
      rosterData.waitlistPlayers.forEach((player: any, index: number) => {
        message += `${index + 1}. ${player.name}\n`;
      });
    }

    return message;
  }

  generateCancellationNotification(
    cancelledPlayerName: string,
    roster: RosterPlayer[],
    currentCount: number,
    maxPlayers: number,
    gameDate: string,
    remainingSpots: number,
    promotedPlayerName: string | null
  ): string {
    const dateFmt = this.formatGameDate(gameDate);
    let message = `===========================\n`;
    message += `❌ ${cancelledPlayerName} dropped out.\n`;
    message += `Tonight's players (${currentCount}/${maxPlayers}) - ${dateFmt}:\n`;

    roster.forEach((p, i) => {
      message += `${i + 1}. ${p.name} - ${this.formatSignupTime(p.signedUpAt)}\n`;
    });

    if (promotedPlayerName) {
      message += `\n✅ ${promotedPlayerName} moved up from waitlist!\n`;
    }

    if (remainingSpots > 0) {
      message += `\n${remainingSpots} spot${remainingSpots > 1 ? 's' : ''} left — sign up: 10xx.com\n`;
    }

    message += `===========================`;
    return message;
  }

  generateSignupNotification(
    playerName: string,
    roster: RosterPlayer[],
    currentCount: number,
    maxPlayers: number,
    gameDate: string
  ): string {
    const dateFmt = this.formatGameDate(gameDate);
    let message = `===========================\n`;
    message += `🎰 ${playerName} signed up to tonight's game ${dateFmt}\n`;

    roster.forEach((p, i) => {
      message += `${i + 1}. ${p.name} - ${this.formatSignupTime(p.signedUpAt)}\n`;
    });

    if (currentCount >= maxPlayers) {
      message += `\nTable is full!\n`;
    }

    message += `===========================`;
    return message;
  }

  generateOneSeatLeftNotification(): string {
    return `⚠️ *One seat left!* Last chance to join tonight's game.\n\n👉 ${this.websiteUrl}`;
  }

  generateTableFullNotification(): string {
    return `✅ *Table is now FULL!* All seats are taken. See you tonight! 🃏`;
  }
}

export const notificationService = new NotificationService();
