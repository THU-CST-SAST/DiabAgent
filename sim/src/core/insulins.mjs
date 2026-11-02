// Insulin catalog, loaded from knowledge/insulins.json (values, fits and evidence live there).
// Rapid/ultra-rapid/regular insulins use the kernel's subcutaneous route with fitted rate
// scalings; long-acting insulins use a separate lag -> depot chain. Plasma insulin is treated
// as equally potent for every product.
import {KNOWLEDGE} from '../knowledge.mjs';

export const INSULINS=KNOWLEDGE.insulins;
const byClass=(...classes)=>Object.keys(INSULINS).filter(k=>classes.includes(INSULINS[k].class));
export const PUMP_INSULINS=byClass('rapid','ultra_rapid');
export const BOLUS_PEN_INSULINS=byClass('rapid','ultra_rapid','regular');
export const BASAL_PEN_INSULINS=byClass('long');

export function insulin(name) {
  const i=INSULINS[name];if(!i)throw new Error(`Unknown insulin ${name}`);return i;
}
