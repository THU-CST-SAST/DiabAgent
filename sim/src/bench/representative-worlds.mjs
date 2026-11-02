import assert from 'node:assert/strict';

/** Select by scenario/demographic/device identity only; no score or response inputs. */
export function representativeSkillWorlds(tasks) {
  const ids=[...new Set(tasks.map(t=>t.task_id))],groups=Object.groupBy(ids,id=>id.slice(0,3));
  const codes=Object.keys(groups).sort();assert.equal(codes.length,32);
  const special={a01:'child-male-typical-pump-pct',a02:'adult-female-typical-pump-combo',
    c01:'child-male-typical-pens',d02:'adolescent-female-typical-pump-abs',h02:'older-male-typical-pump-pct'};
  const ages={child:0,adolescent:0,adult:0,older:0},sexes={male:0,female:0},selected=[];
  function choose(index) {
    if(index===codes.length)return Object.values(ages).every(n=>n===8)&&sexes.male===16&&sexes.female===16;
    const code=codes[index];
    const candidates=groups[code].filter(id=>!special[code]||id.includes(special[code])).sort((a,b)=>{
      const [,aa,as]=a.split('-'),[,ba,bs]=b.split('-');return ages[aa]-ages[ba]||sexes[as]-sexes[bs]||a.localeCompare(b);
    });
    for(const id of candidates) {
      const [,age,sex]=id.split('-');if(ages[age]>=8||sexes[sex]>=16)continue;
      ages[age]++;sexes[sex]++;selected.push(id);
      if(choose(index+1))return true;
      selected.pop();ages[age]--;sexes[sex]--;
    }
    return false;
  }
  assert(choose(0));assert.equal(new Set(selected).size,32);
  const accepted=tasks.filter(t=>selected.includes(t.task_id));assert.equal(accepted.length,64);
  return {worlds:32,trajectories:64,parallel:2,selection_uses_scores:false,age_counts:ages,sex_counts:sexes,
    selected_worlds:selected,tasks:accepted,no_second_representative_without_new_decision:true,no_extra_repeats:true};
}
