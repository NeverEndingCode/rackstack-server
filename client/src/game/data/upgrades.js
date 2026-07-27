// Upgrade/shard-upgrade defs have no client-only presentation fields (no
// Icon, unlike data/tiers.js) - straight re-export of the shared source of
// truth so the reducer (server) and this UI never see divergent numbers.
export { UPGRADE_DEFS, SINGULARITY_DEFS } from '@shared/gameData.js';
