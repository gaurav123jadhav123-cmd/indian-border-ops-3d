const { getTerrainHeight, MAP_HALF_SIZE } = require('./terrainHeight');
const { WEAPON_STATS, applyDamage } = require('./ballistics');

const BOT_WEAPONS = ['sig716', 'ak203', 'insas', 'tavor', 'asmi', 'svd'];
const BHARAT_NAMES = ['BOT_Arjun', 'BOT_Vikram', 'BOT_Karan', 'BOT_Rohan', 'BOT_Kabir'];
const OPFOR_NAMES = ['BOT_Viper01', 'BOT_Viper02', 'BOT_Viper03', 'BOT_Viper04', 'BOT_Viper05'];

class BotManager {
  constructor(room) {
    this.room = room;
    this.seq = 1;
  }

  syncBotCount(targetTotal = 10) {
    const all = Array.from(this.room.players.values());
    const humans = all.filter((p) => !p.isBot);
    if (humans.length === 0) return;

    let currentTotal = all.length;
    if (currentTotal > targetTotal) {
      const bots = all.filter((p) => p.isBot);
      for (const b of bots) {
        if (currentTotal <= targetTotal) break;
        this.room.players.delete(b.id);
        currentTotal--;
      }
      return;
    }

    while (currentTotal < targetTotal) {
      const bharatCount = Array.from(this.room.players.values()).filter((p) => p.team === 'bharat').length;
      const opforCount = Array.from(this.room.players.values()).filter((p) => p.team === 'opfor').length;
      const team = bharatCount <= opforCount ? 'bharat' : 'opfor';
      this.spawnBot(team);
      currentTotal++;
    }
  }

  spawnBot(team) {
    const id = `bot_${this.seq++}`;
    const names = team === 'bharat' ? BHARAT_NAMES : OPFOR_NAMES;
    const callsign = names[(this.seq - 2) % names.length];
    const spawn = this.room.getSpawnPoint(team, true);
    const primary = BOT_WEAPONS[Math.floor(Math.random() * BOT_WEAPONS.length)];

    const bot = {
      id,
      isBot: true,
      callsign,
      team,
      mode: this.room.mode,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: team === 'bharat' ? 0 : Math.PI,
      pitch: 0,
      stance: 'stand',
      lean: 0,
      sprinting: true,
      hp: 100,
      armor: 50,
      boost: 0,
      alive: true,
      respawnAt: 0,
      kills: 0,
      deaths: 0,
      streak: 0,
      activeSlot: 'primary',
      loadout: { primary, secondary: 'pistol9mm', launcher: 'carlGustaf' },
      ammo: { primary: WEAPON_STATS[primary].magSize, secondary: 13, launcher: 1 },
      inventory: { frag: 1, smoke: 1, bandage: 2, firstAid: 1, medkit: 0, energyDrink: 1 },
      lastShotAt: 0,
      aiTargetId: null,
      aiWayX: (Math.random() - 0.5) * 65,
      aiWayZ: (Math.random() - 0.5) * 35,
      aiNextThinkAt: 0
    };

    this.room.players.set(id, bot);
  }

  update(now) {
    const allPlayers = Array.from(this.room.players.values());

    for (const bot of allPlayers) {
      if (!bot.isBot || !bot.alive) continue;

      if (now >= bot.aiNextThinkAt) {
        bot.aiNextThinkAt = now + 260 + Math.random() * 180;
        let nearest = null;
        let bestDist = 85;

        for (const other of allPlayers) {
          if (other.id === bot.id || !other.alive) continue;
          if (this.room.mode === 'TDM' && other.team === bot.team) continue;
          const d = Math.hypot(other.x - bot.x, other.z - bot.z);
          if (d < bestDist) {
            bestDist = d;
            nearest = other;
          }
        }
        bot.aiTargetId = nearest ? nearest.id : null;

        if (!nearest && Math.hypot(bot.aiWayX - bot.x, bot.aiWayZ - bot.z) < 6) {
          bot.aiWayX = (Math.random() - 0.5) * 70;
          bot.aiWayZ = (Math.random() - 0.5) * 40;
          bot.stance = Math.random() < 0.18 ? 'crouch' : 'stand';
        }
      }

      const target = bot.aiTargetId ? this.room.players.get(bot.aiTargetId) : null;
      if (target && target.alive) {
        const dx = target.x - bot.x;
        const dz = target.z - bot.z;
        const dist = Math.hypot(dx, dz) || 1;
        bot.yaw = Math.atan2(-dx, -dz);

        if (dist > 16) {
          bot.x += (dx / dist) * 0.22;
          bot.z += (dz / dist) * 0.22;
        } else {
          bot.x += (-dz / dist) * 0.09;
          bot.z += (dx / dist) * 0.09;
        }

        const stats = WEAPON_STATS[bot.loadout.primary] || WEAPON_STATS.sig716;
        if (now - bot.lastShotAt >= Math.max(460, stats.fireRateMs * 3.5)) {
          bot.lastShotAt = now;
          this.room.io.to(this.room.roomId).emit('shot_fired', {
            shooterId: bot.id,
            weaponId: bot.loadout.primary,
            origin: { x: bot.x, y: bot.y + 1.45, z: bot.z },
            dir: { x: dx / dist, y: (target.y - bot.y) / dist, z: dz / dist }
          });

          const hitChance = Math.max(0.18, 0.54 - dist * 0.0045);
          if (Math.random() < hitChance) {
            const headshot = Math.random() < 0.12;
            const dmg = Math.round(stats.damage * (headshot ? 1.45 : 0.72));
            applyDamage(target, dmg);
            if (target.hp <= 0) {
              this.room.registerKill(bot, target, stats.name, headshot);
            }
          }
        }
      } else {
        const dx = bot.aiWayX - bot.x;
        const dz = bot.aiWayZ - bot.z;
        const dist = Math.hypot(dx, dz) || 1;
        bot.yaw = Math.atan2(-dx, -dz);
        bot.x += (dx / dist) * 0.24;
        bot.z += (dz / dist) * 0.24;
      }

      bot.x = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, bot.x));
      bot.z = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, bot.z));
      bot.y = getTerrainHeight(bot.x, bot.z);
    }
  }
}

module.exports = { BotManager };
