import type { ArchetypeInput } from './types.js';

const BALANCED_TRAIN_RATIO = Object.freeze({
  rifle: 4,
  at_infantry: 2,
  scout: 1,
  medium_tank: 2,
  heavy_tank: 1,
  howitzer: 1,
  at_gun: 1,
  aa_gun: 1,
  fighter: 1,
  bomber: 1,
  engineer: 1,
  supply_truck: 2,
});

export const ECONOMY_ARCHETYPES: Readonly<Record<'four' | 'two' | 'one', ArchetypeInput>> = Object.freeze({
  four: Object.freeze({
    id: 'four_sessions',
    nameKo: '하루 4회',
    sessionsPerDay: 4,
    trainRatio: BALANCED_TRAIN_RATIO,
  }),
  two: Object.freeze({
    id: 'two_sessions',
    nameKo: '하루 2회',
    sessionsPerDay: 2,
    trainRatio: BALANCED_TRAIN_RATIO,
  }),
  one: Object.freeze({
    id: 'one_session',
    nameKo: '하루 1회(강건성)',
    sessionsPerDay: 1,
    trainRatio: BALANCED_TRAIN_RATIO,
  }),
});
