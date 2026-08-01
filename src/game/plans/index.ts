import type { CastlePlan, PlanId, PlanSource } from '../types';
import { compilePlan } from '../grid';
import { COMPACT } from './compact';
import { LABYRINTH } from './labyrinth';
import { OPEN } from './open';

export const PLANS: PlanSource[] = [COMPACT, LABYRINTH, OPEN];

const cache = new Map<PlanId, CastlePlan>();

export function getPlan(id: PlanId): CastlePlan {
  const hit = cache.get(id);
  if (hit) return hit;
  const src = PLANS.find((p) => p.id === id) ?? COMPACT;
  const compiled = compilePlan(src);
  cache.set(id, compiled);
  return compiled;
}

export function planList(): { id: PlanId; name: string; blurb: string }[] {
  return PLANS.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb }));
}
