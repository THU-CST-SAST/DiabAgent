import {cogiMetrics} from './cogi.mjs';

/** TITR is 70..140 mg/dL inclusive; the weighted score is exploratory, not COGI. */
export function titrMetrics(values) {
  const cogi=cogiMetrics(values);
  if(cogi.no_data)return {version:'TITR-70-140/v1',n:0,titr_percent:null,exploratory_score:null,no_data:true};
  const titr_percent=100*values.filter(g=>g>=70&&g<=140).length/values.length;
  const contributions={titr:.50*titr_percent,hypo:.35*cogi.subscores.hypo,gv:.15*cogi.subscores.gv};
  return {version:'TITR-70-140/v1',n:values.length,titr_percent,
    exploratory_version:'exploratory-TITR-weighted-50-35-15/v1',
    exploratory_score:Object.values(contributions).reduce((a,b)=>a+b,0),
    subscores:{titr:titr_percent,hypo:cogi.subscores.hypo,gv:cogi.subscores.gv},contributions,
    original_cogi:cogi.score,tbr70_percent:cogi.tbr70_percent,sd_mgdl:cogi.sd_mgdl};
}
