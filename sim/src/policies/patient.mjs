// Self-managing patient baseline: boluses announced meals by the profile carb ratio (plus half a
// correction above 150 mg/dL), treats lows below 70 with 15 g, corrects above 250 at most every 3 h.
// Reads observations only; works for pumps and pens. A built-in loop, if enabled, runs inside World.

const roundTo=(u,spec)=>{const s=spec?.step;u=Math.min(u,spec?.max??u);return s?Math.floor(u/s+1e-9)*s:u;};

/** Returns a stateful policy obs -> {action, rationale}. */
export function patientPolicy() {
  let lastRescue=-Infinity,lastBolus=-Infinity;
  return obs=>{
    const t=Date.parse(obs.virtual_time),p=obs.profile,s=obs.action_specs;
    const g=obs.glucose&&obs.glucose.age_minutes<=15?obs.glucose.value_mg_dl:null;
    const grams=obs.events.filter(e=>e.type==='meal_announced').reduce((a,e)=>a+(e.grams??0),0);
    if(grams>0&&s.BOLUS) {
      let u=grams/p.carb_ratio_g_per_u;if(g&&g>150)u+=(g-p.target_mg_dl)/p.isf_mg_dl_per_u*0.5;
      u=roundTo(u,s.BOLUS.units);
      if(u>0){lastBolus=t;return {action:{type:'BOLUS',units:Number(u.toFixed(3))},rationale:`meal bolus ${grams} g`};}
    }
    if(g!=null&&g<70&&t-lastRescue>=45*60000&&s.INGEST_CARBS){lastRescue=t;return {action:{type:'INGEST_CARBS',grams:15},rationale:'treat low'};}
    if(g!=null&&g>250&&t-lastBolus>=3*3600000&&s.BOLUS) {
      const u=roundTo((g-p.target_mg_dl)/p.isf_mg_dl_per_u*0.6,s.BOLUS.units);
      if(u>0){lastBolus=t;return {action:{type:'BOLUS',units:Number(u.toFixed(3))},rationale:'correction'};}
    }
    return {action:{type:'WAIT'},rationale:'wait'};
  };
}
