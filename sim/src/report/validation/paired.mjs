// Paired-variant evidence (Exp1 observation scaling, Exp4 backends / insulins) computed directly from
// trial dirs (sweet-sim.trial/v1 trial.json with base_env / ladder / level / level_index / agent /
// reward), so the page works while jobs are still running and without paired-analysis output.
// Statistics: per-base means, percentile bootstrap over base environments; trend = mean per-base
// Spearman rho(level_index, reward) with bootstrap CI.
import {bootMean,spearman,fin,mean} from './util.mjs';

/** rows: [{experiment, base_env, level, level_index, agent, reward}] -> per experiment analysis. */
export function analyzeLadders(rows,experiments) {
  const out=[];
  for(const e of experiments) {
    const rs=rows.filter(r=>r.experiment===e.id);
    const agents=[...new Set(rs.map(r=>r.agent))].sort(agentOrder);
    const levels=e.levels??[];
    const res={id:e.id,title:e.title,factor:e.factor,levels,reference_level:e.reference_level,expected_trend:e.expected_trend??null,
      design_notes:e.design_notes??null,planned_bases:e.base_envs?.length??null,trials:rs.length,agents:[]};
    for(const a of agents) {
      const byBase=new Map();
      for(const r of rs.filter(r=>r.agent===a&&fin(r.reward))){const m=byBase.get(r.base_env)??new Map();(m.get(r.level)??m.set(r.level,[]).get(r.level)).push(r.reward);byBase.set(r.base_env,m);}
      const base=[...byBase.entries()].map(([b,m])=>[b,new Map([...m].map(([l,v])=>[l,mean(v)]))]);
      const lv=levels.map(L=>({level:L.level,level_index:L.level_index,label:L.label,...bootMean(base.map(([,m])=>m.get(L.level)))}));
      const ref=e.reference_level;
      const diffs=levels.filter(L=>L.level!==ref).map(L=>({level:L.level,label:L.label,...bootMean(base.filter(([,m])=>fin(m.get(L.level))&&fin(m.get(ref))).map(([,m])=>m.get(L.level)-m.get(ref)))}));
      const complete=base.filter(([,m])=>levels.every(L=>fin(m.get(L.level))));
      const rhos=complete.map(([,m])=>{const ys=levels.map(L=>m.get(L.level));return Math.max(...ys)-Math.min(...ys)<1e-12?0:spearman(levels.map(L=>L.level_index),ys);}).filter(fin);
      const trend=bootMean(rhos);
      let maxDev=0;for(const [,m] of complete){const ys=levels.map(L=>m.get(L.level));maxDev=Math.max(maxDev,Math.max(...ys)-Math.min(...ys));}
      const exp=e.expected_trend;
      let verdict='insufficient';
      if(trend.n>=3&&fin(trend.lo)) {
        if(exp===1||exp===-1)verdict=trend.lo*exp>0&&trend.hi*exp>0?'expected':trend.lo*exp<0&&trend.hi*exp<0?'reversed':'no_effect';
        else verdict=diffs.some(d=>fin(d.lo)&&(d.lo>0||d.hi<0))?'differs':'no_difference';
      }
      const first=lv[0]?.mean,last=lv[lv.length-1]?.mean;
      res.agents.push({agent:a,bases:base.length,complete_bases:complete.length,levels:lv,diffs,trend,verdict,first_to_last:fin(first)&&fin(last)?last-first:null,max_within_base_range:maxDev});
    }
    out.push(res);
  }
  return out;
}

const ORDER=['wait','patient','oref0','causal','omniscient','oracle'];
export function agentOrder(a,b){const i=ORDER.indexOf(a),j=ORDER.indexOf(b);return (i<0?99:i)-(j<0?99:j)||String(a).localeCompare(String(b));}
