import { ARSENAL, HEALING_ITEMS, STARTING_INVENTORY, SLOT_RULES, DEFAULT_LOADOUT } from '../shared/arsenal.js';

export const metaRoutes = [
  {
    method: 'GET',
    path: '/api/health',
    handler: async ({ services }) => ({
      body: {
        status: 'ok',
        service: 'indian-border-ops-backend',
        timestamp: new Date(services.now()).toISOString(),
        ...services.store.counts()
      }
    })
  },
  {
    method: 'GET',
    path: '/api/arsenal',
    limit: 'read',
    handler: async () => ({
      headers: { 'Cache-Control': 'public, max-age=300' },
      body: {
        weapons: ARSENAL,
        healing: HEALING_ITEMS,
        startingInventory: STARTING_INVENTORY,
        slotRules: SLOT_RULES,
        defaultLoadout: DEFAULT_LOADOUT
      }
    })
  }
];
