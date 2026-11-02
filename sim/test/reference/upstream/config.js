import {z} from 'zod';
import {DEFAULT_PARAMETERS,basalFromInsulin} from '../../../model/Deichmann2023.ts';

const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const meal=z.object({time,carbsG:z.number().min(1).max(200),carbsJitterG:z.number().min(0).max(80),
  timeJitterMinutes:z.number().int().min(0).max(90),absorptionMinutes:z.number().min(5).max(240)}).strict();
export const configSchema=z.object({
  subject:z.object({sex:z.enum(['male','female']),ageYears:z.number().int().min(1).max(120),heightCm:z.number().min(30).max(260),weightKg:z.number().min(1).max(300)}).strict(),
  seed:z.number().int().min(0).max(4294967295),timezone:z.literal('Asia/Shanghai'),
  sampleMinutes:z.number().int().min(1).max(15),sensorNoiseMgdl:z.number().min(0).max(10),
  initialGlucoseMgdl:z.number().min(30).max(500),
  profile:z.object({basalUph:z.number().min(0).max(10),isfMgdlPerU:z.number().min(5).max(300),carbRatioGPerU:z.number().min(1).max(100),
    diaHours:z.number().min(5).max(12),targetMgdl:z.number().min(80).max(180),maxBasalUph:z.number().min(0).max(10),maxIobU:z.number().min(0).max(20)}).strict(),
  meals:z.object({breakfast:meal,lunch:meal,dinner:meal}).strict(),
  sleep:z.object({bedtime:time,wakeTime:time,jitterMinutes:z.number().int().min(0).max(90)}).strict(),
  activity:z.object({enabled:z.boolean(),probability:z.number().min(0).max(1),durationMinutes:z.number().int().min(5).max(120),accelerometerCounts:z.number().min(0).max(6539)}).strict(),
  stress:z.object({enabled:z.boolean(),probability:z.number().min(0).max(1),durationMinutes:z.number().int().min(5).max(240),hepaticDeltaMgdlPerMin:z.number().min(0).max(.5)}).strict(),
  loopMode:z.enum(['open','closed','lgs']),paused:z.boolean(),speed:z.number().min(0).max(60),
  tempTargets:z.object({meal:z.number().min(80).max(180),activity:z.number().min(80).max(200),hypo:z.number().min(80).max(200),durationMinutes:z.number().int().min(5).max(240)}).strict(),
}).strict().superRefine((c,ctx)=>{
  if(c.profile.maxBasalUph<c.profile.basalUph) ctx.addIssue({code:'custom',path:['profile','maxBasalUph'],message:'maxBasalUph must be >= basalUph'});
  for(const [name,m] of Object.entries(c.meals)) if(m.carbsJitterG>=m.carbsG)
    ctx.addIssue({code:'custom',path:['meals',name,'carbsJitterG'],message:'Meal jitter must be below nominal carbs'});
});
export const DEFAULT_CONFIG=configSchema.parse({
  subject:{sex:'male',ageYears:39,heightCm:170,weightKg:66},seed:20261013,timezone:'Asia/Shanghai',
  sampleMinutes:5,sensorNoiseMgdl:1.5,initialGlucoseMgdl:120,
  profile:{basalUph:basalFromInsulin({...DEFAULT_PARAMETERS,BW:66})*60/1e6,isfMgdlPerU:50,carbRatioGPerU:10,diaHours:5,targetMgdl:120,maxBasalUph:3,maxIobU:3},
  meals:{breakfast:{time:'08:00',carbsG:50,carbsJitterG:10,timeJitterMinutes:20,absorptionMinutes:40},
    lunch:{time:'12:30',carbsG:70,carbsJitterG:15,timeJitterMinutes:30,absorptionMinutes:55},
    dinner:{time:'19:00',carbsG:60,carbsJitterG:15,timeJitterMinutes:30,absorptionMinutes:65}},
  sleep:{bedtime:'23:00',wakeTime:'07:00',jitterMinutes:30},
  activity:{enabled:true,probability:.35,durationMinutes:30,accelerometerCounts:2095},
  stress:{enabled:false,probability:.15,durationMinutes:45,hepaticDeltaMgdlPerMin:.05},
  loopMode:'open',paused:false,speed:1,tempTargets:{meal:100,activity:150,hypo:140,durationMinutes:60},
});

export function mergeConfig(current,patch) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)) throw new Error('Config patch must be an object');
  const merge=(a,b)=>Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>[k,
    b[k]===undefined?a[k]:b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k])&&a[k]&&typeof a[k]==='object'?merge(a[k],b[k]):b[k]]));
  return configSchema.parse(merge(current,patch));
}
