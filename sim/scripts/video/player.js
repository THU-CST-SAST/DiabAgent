// Demo player for sweet-sim run records (format sweet-sim.run/v1): draws one 1280x720 frame for a
// given simulated minute. Used interactively (play / pause / scrub / pick an instance) and by
// scripts/demo-video.mjs, which loads this page with ?record=1 and records the canvas.
// window.RUNS (array of run records) is injected by the generator.
const W=1280,H=720,FONT='-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif';
const C={page:'#f6f7f9',surface:'#ffffff',ink:'#1f2328',ink2:'#57606a',muted:'#8c959f',grid:'#e6e8eb',line:'#d0d7de',
  truth:'#2f5d9e',reading:'#c4651a',band:'#e7f2ea',lowtint:'#fbeceb',low:'#b42318',high:'#9a6700',ok:'#1a7f37',chip:'#eef1f5',hi:'#fff4d6'};
const L={
  group:{child:'儿童',adolescent:'青少年',adult:'成人',older:'老年'},sex:{male:'男',female:'女'},
  bmi:{normal:'正常体重',overweight:'超重',obese:'肥胖'},carb:{typical:'计碳一般',accurate:'计碳准确',poor:'计碳较差'},
  setup:{cgm:'实时 CGM',calibrated_cgm:'需指尖校准的 CGM',flash:'扫描式（瞬感）',meter_only:'仅指尖血糖仪'},
  controller:{manual:'无闭环（手动）',open:'开环建议',closed:'闭环',lgs:'低血糖暂停（LGS）'},
  pack:{high_fat_meals:'高脂餐',anaerobic_exercise:'无氧运动',alcohol:'饮酒',illness:'生病',sleep_loss:'睡眠不足',menstrual:'月经周期',
    stress:'压力',occlusion_faults:'管路堵塞',unannounced_meals:'未报告进食',activity:'运动',signal_gaps:'CGM中断',compression_low:'压迫伪低',sensor_bias:'测量偏差',calibration_error:'校准异常',infusion_deficit:'无报警送达不足',sensor_drift:'渐进测量偏差'},
  event:{meal:'进食',exercise:'运动',stress:'压力',alcohol:'饮酒',alcohol_effect:'酒精作用',illness:'生病',sleep_loss:'睡眠不足',
    basal_injection:'长效注射',occlusion:'管路堵塞',smbg_routine:'例行指尖血',scan_routine:'例行扫描',record:'可见事件报告',sensor_drift:'测量漂移',infusion_deficit:'送达不足',sensor_calibration_error:'错误校准',infusion_recovery:'输注恢复'},
  action:{BOLUS:'大剂量',INGEST_CARBS:'补糖',TEMP_BASAL:'临时基础率',CANCEL_TEMP_BASAL:'取消临时基础率',BASAL_INJECTION:'长效注射',
    EXTENDED_BOLUS:'方波大剂量',SUSPEND_PUMP:'暂停泵',RESUME_PUMP:'恢复泵',CHANGE_INFUSION_SET:'更换管路',MEASURE_BG:'测指尖血',SCAN:'扫描',
    CALIBRATE_CGM:'校准 CGM',SET_TEMP_TARGET:'临时目标',SET_LOOP_MODE:'切换闭环模式',SUSPEND_LOOP:'暂停闭环',SET_PROFILE:'调整档案'},
  source:{cgm:'CGM',meter:'指尖',flash_scan:'扫描'},policy:{patient:'自我管理患者基线',oref0:'oref0 基线',wait:'不干预',recorded:'录制的决策',omniscient:'全知信息决策',causal:'因果最优决策'},
};
const pad2=n=>String(n).padStart(2,'0');
// Display units: data stay in mg/dL; mmol/L = mg/dL / 18.016 (clinical thresholds 3.9 / 10.0 / 3.0 / 13.9).
const MGDL_PER_MMOL=18.016;
let UNITS=new URLSearchParams(location.search).get('units')==='mgdl'?'mgdl':'mmol';
const UL=()=>UNITS==='mmol'?'mmol/L':'mg/dL';
const fmtG=v=>v==null?'–':UNITS==='mmol'?(v/MGDL_PER_MMOL).toFixed(1):String(Math.round(v));
const TH=()=>UNITS==='mmol'?{low:'3.9',vlow:'3.0',high:'10.0',vhigh:'13.9'}:{low:'70',vlow:'54',high:'180',vhigh:'250'};
const isfText=isf=>UNITS==='mmol'?`${(isf/MGDL_PER_MMOL).toFixed(1)} mmol/L/U`:`${isf} mg/dL/U`;
// Rationales of the built-in baseline policies, shown in Chinese; free-text rationales pass through.
const why=s=>s==null||s==='wait'?null:String(s).replace(/^meal bolus (\d+(?:\.\d+)?) g$/,'按报告的 $1 g 碳水给餐时大剂量')
  .replace(/^treat low$/,'血糖低于 70，补 15 g 糖').replace(/^correction$/,'血糖高于 250，给校正剂量');
const pct=v=>v==null?'–':(v*100).toFixed(v>0&&v<0.1?1:0)+'%';

// ---- data helpers ---------------------------------------------------------------------------
function prepare(run) {
  const startLocal=Date.parse(run.start)+run.utc_offset_minutes*60000,t0=new Date(startLocal);
  run._startMin=t0.getUTCHours()*60+t0.getUTCMinutes();
  const values=[...run.truth,...run.readings].map(p=>p[1]).filter(Number.isFinite);
  run._ymin=Math.min(40,Math.floor(Math.min(...values)/10)*10-10);
  run._ymax=Math.max(400,Math.ceil(Math.max(...values)/50)*50+20);
  run._feed=[];
  for(const e of run.events) {
    if(e.type==='smbg_routine'||e.type==='scan_routine'||e.type==='alcohol_effect')continue;
    run._feed.push({m:e.m,kind:'event',text:eventText(e),hidden:hiddenEvent(e)});
  }
  for(const [m,type,amt,why0] of run.treatments)
    run._feed.push({m,kind:'action',text:`${L.action[type]??type}${amt!=null?' '+amt+(type==='INGEST_CARBS'?' g':type==='TEMP_BASAL'?' U/h':' U'):''}`,why:why(why0)});
  run._feed.sort((a,b)=>a.m-b.m||(a.kind==='event'?-1:1));
  run._lanes=[];
  const lanes=new Map();
  for(const e of run.events){if(['meal','smbg_routine','scan_routine','basal_injection'].includes(e.type))continue;
    const k=e.type==='alcohol_effect'?'alcohol':e.type;if(!lanes.has(k))lanes.set(k,[]);lanes.get(k).push(e);}
  run._lanes=[...lanes].map(([k,items])=>({label:L.event[k]??k,items}));
  return run;
}
  function hiddenEvent(e){return e.type==='meal'?!e.announced:['occlusion','alcohol_effect','sensor_bias','sensor_drift','infusion_deficit','sensor_calibration_error'].includes(e.type)||e.announced===false;}
function eventText(e) {
  if(e.type==='meal')return `进食 ${e.grams} g`+(e.announced?`（报告 ${e.reported} g）`:'（未报告）');
  if(e.type==='exercise')return `${e.kind==='anaerobic'?'无氧':'有氧'}运动 ${e.end?Math.round(e.end-e.m)+' 分钟':''}`;
  if(e.type==='basal_injection')return `长效注射${e.units?' '+Number(e.units).toFixed(1)+' U':''}`;
  if(e.type==='illness')return `开始生病（胰岛素需求上升）`;
  if(e.type==='sleep_loss')return `睡眠不足（胰岛素敏感性下降）`;
  if(e.type==='alcohol')return `饮酒（数小时后血糖可能偏低）`;
  if(e.type==='stress')return `压力（肝糖输出增加）`;
  if(e.type==='occlusion')return `输注管路堵塞（泵尚未报警）`;
  if(e.type==='sensor_bias')return '传感器数值偏差开始（不改变真实血糖）';
  if(e.type==='sensor_drift')return '渐进传感器偏差开始（不改变真实血糖）';
  if(e.type==='infusion_deficit')return '实际送达不足开始（泵账本仍正常、无即时报警）';
  if(e.type==='sensor_calibration_error')return '错误校准影响传感器读数';
  if(e.type==='infusion_recovery')return '输注故障解除';
  if(e.type==='record')return e.text??'已确认的事件记录';
  return L.event[e.type]??e.type;
}
function at(series,m){ // last value at or before m
  let lo=0,hi=series.length-1,best=null;
  while(lo<=hi){const mid=(lo+hi)>>1;if(series[mid][0]<=m){best=series[mid];lo=mid+1;}else hi=mid-1;}
  return best;
}
function clock(run,m){const t=run._startMin+m,day=Math.floor(t/1440)+1,mm=((t%1440)+1440)%1440;return {day,text:`${pad2(Math.floor(mm/60))}:${pad2(Math.floor(mm%60))}`};}

// ---- drawing --------------------------------------------------------------------------------
let ctx;
function font(size,weight=400){ctx.font=`${weight} ${size}px ${FONT}`;}
function text(s,x,y,{size=14,weight=400,color=C.ink,align='left'}={}){font(size,weight);ctx.fillStyle=color;ctx.textAlign=align;ctx.fillText(s,x,y);}
function wrap(s,x,y,maxW,{size=13,color=C.ink2,lineH=18,maxLines=3,weight=400}={}) {
  font(size,weight);ctx.fillStyle=color;ctx.textAlign='left';
  let line='',lines=0;
  for(const ch of String(s)) {
    if(ctx.measureText(line+ch).width>maxW&&line){
      if(lines===maxLines-1){ctx.fillText(line.slice(0,-1)+'…',x,y);return y+lineH;}
      ctx.fillText(line,x,y);y+=lineH;lines++;line=ch.trim()?ch:'';}
    else line+=ch;
  }
  if(line)ctx.fillText(line,x,y);return y+lineH;
}
function rrect(x,y,w,h,r,fill,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();}}

function drawFrame(run,m,{endCard=0}={}) {
  const Hm=run.hours*60;
  const modern=!!run.metrics.dynamic,low=modern?4*MGDL_PER_MMOL:70,high=modern?8*MGDL_PER_MMOL:180;
  ctx.fillStyle=C.page;ctx.fillRect(0,0,W,H);
  // header
  text('Sweet Sim 仿真演示',24,38,{size:22,weight:700});
  text(`${run.id} · ${L.policy[run.policy]??run.policy} · 仅为仿真`,232,38,{size:14,color:C.ink2});
  const ck=clock(run,m);
  text(`第 ${ck.day} 天`,W-150,38,{size:16,color:C.ink2,align:'right'});
  text(ck.text,W-24,40,{size:30,weight:700,align:'right'});
  rrect(24,54,W-48,4,2,C.grid);rrect(24,54,(W-48)*Math.min(1,m/Hm),4,2,C.truth);

  // left panel: instance
  const P=run.person,T=run.therapy,S=run.sensors;
  rrect(24,72,360,404,8,C.surface,C.line);
  let y=98;
  const section=(title)=>{text(title,40,y,{size:12,weight:600,color:C.muted});y+=20;};
  section('人');
  text(`${L.group[P.group]??P.group} · ${L.sex[P.sex]??P.sex} · ${P.age} 岁`,40,y,{size:17,weight:600});y+=22;
  text(`${P.weight} kg · ${L.bmi[P.bmi]??P.bmi}${P.tdd?` · 每日胰岛素 ${P.tdd} U`:''}`,40,y,{size:13,color:C.ink2});y+=19;
  text(`敏感性 ×${P.sensitivity} · ${P.dawn==='present'?'有':'无'}黎明现象 · ${L.carb[P.carb_counting]??''}`,40,y,{size:13,color:C.ink2});y+=26;
  section('给药');
  y=wrap(T.mode==='pump'?`胰岛素泵 ${T.device}`:`餐时笔 ${T.device}`,40,y,328,{size:13,color:C.ink,maxLines:2});
  y=wrap(T.insulin+(T.mode==='mdi'?` ＋ 长效 ${T.basal_insulin}（${T.basal_device}）`:''),40,y,328,{size:13,maxLines:2});y+=6;
  section('传感器');
  y=wrap(`${L.setup[S.setup]}：${[S.cgm,S.meter].filter(Boolean).join(' ＋ ')}`,40,y,328,{size:13,color:C.ink,maxLines:3});y+=6;
  section('闭环 / 事件包');
  text(L.controller[run.controller]??run.controller,40,y,{size:13});y+=8;
  let cx=40;y+=6;
  for(const p of run.packs.length?run.packs:['__none']) {
    const label=p==='__none'?'仅日常事件':(L.pack[p]??p);font(12);const w=ctx.measureText(label).width+16;
    if(cx+w>368){cx=40;y+=24;}
    rrect(cx,y,w,20,10,C.chip);text(label,cx+8,y+14,{size:12});cx+=w+6;
  }

  // left panel: live values
  const g=at(run.truth,m),rd=at(run.readings,m),iob=at(run.series.iob,m),cob=at(run.series.cob,m),bas=at(run.series.basal??[],m);
  rrect(24,488,360,208,8,C.surface,C.line);
  text('真实血糖（智能体看不到）',40,514,{size:12,weight:600,color:C.muted});
  const gv=g?g[1]:null,state=gv==null?'':gv<3*MGDL_PER_MMOL?'严重低值':gv<low?'低于评分目标':gv>12*MGDL_PER_MMOL?'很高':gv>high?'高于评分目标':'目标范围内';
  text(fmtG(gv),40,566,{size:46,weight:700,color:gv==null?C.ink:gv<low?C.low:gv>high?C.high:C.ink});
  font(46,700);text(UL(),40+ctx.measureText(fmtG(gv)).width+8,566,{size:14,color:C.ink2});
  text(state,40,590,{size:13,weight:600,color:gv<low?C.low:gv>high?C.high:C.ok});
  text('可见读数',214,514,{size:12,weight:600,color:C.muted});
  if(rd){text(fmtG(rd[1]),214,556,{size:30,weight:700,color:C.reading});
    text(`${L.source[rd[2]]??rd[2]} · ${Math.max(0,Math.round(m-rd[0]))} 分钟前`,214,580,{size:12,color:C.ink2});}
  else text('暂无读数',214,556,{size:16,color:C.muted});
  text(`IOB ${iob?iob[1].toFixed(2):'–'} U`,40,630,{size:15,weight:600});
  text(`COB ${cob?Math.round(cob[1]):'–'} g`,190,630,{size:15,weight:600});
  text(T.mode==='pump'?`当前基础率 ${bas?bas[1].toFixed(2):'–'} U/h`:`长效 ${T.basal_dose??'–'} U/天 @ ${(T.basal_times??[]).join('、')}`,40,660,{size:13,color:C.ink2});
  text(`档案：ISF ${isfText(run.profile.isf)} · 碳水比 ${run.profile.cr} g/U · 目标 ${fmtG(run.profile.target)}`,40,684,{size:12,color:C.muted});

  // chart
  const X0=410,X1=W-24,Y0=78,Y1=392,ymin=run._ymin,ymax=run._ymax;
  rrect(X0-14,72,X1-X0+28,404,8,C.surface,C.line);
  const x=mm=>X0+30+mm/Hm*(X1-X0-40),yv=v=>Y0+(1-(Math.min(ymax,Math.max(ymin,v))-ymin)/(ymax-ymin))*(Y1-Y0);
  ctx.fillStyle=C.band;ctx.fillRect(x(0),yv(high),x(Hm)-x(0),yv(low)-yv(high));
  ctx.fillStyle=C.lowtint;ctx.fillRect(x(0),yv(low),x(Hm)-x(0),yv(ymin)-yv(low));
  ctx.strokeStyle=C.grid;ctx.lineWidth=1;
  const ticks=modern?[4,8,12,20].map(v=>[v*MGDL_PER_MMOL,UNITS==='mmol'?v.toFixed(1):String(Math.round(v*MGDL_PER_MMOL))]):UNITS==='mmol'?[3.9,10,13.9,20].map(v=>[v*MGDL_PER_MMOL,v.toFixed(1)]):[[70,'70'],[180,'180'],[250,'250'],[350,'350']];
  for(const [v,lab] of ticks){ctx.beginPath();ctx.moveTo(x(0),yv(v));ctx.lineTo(x(Hm),yv(v));ctx.stroke();text(lab,x(0)-6,yv(v)+4,{size:11,color:C.muted,align:'right'});}
  text(UL(),x(0)-6,Y0+10,{size:10,color:C.muted,align:'right'});
  const step=Hm<=1440?180:Hm<=2880?360:1440;   // multi-day runs: one tick per day, labelled D<n>
  for(let mm=0;mm<=Hm;mm+=step)text(Hm>2880?`D${clock(run,mm).day}`:clock(run,mm).text,x(mm),Y1+16,{size:11,color:C.muted,align:'center'});
  // future area dimmed
  ctx.fillStyle='rgba(246,247,249,.55)';ctx.fillRect(x(m),Y0-4,x(Hm)-x(m),Y1-Y0+8);
  // truth line up to m
  ctx.strokeStyle=C.truth;ctx.lineWidth=2.2;ctx.lineJoin='round';ctx.beginPath();let started=false;
  for(const [mm,v] of run.truth){if(mm>m)break;if(!started){ctx.moveTo(x(mm),yv(v));started=true;}else ctx.lineTo(x(mm),yv(v));}
  ctx.stroke();
  // readings
  const dense=run.readings.length>100;
  for(const [mm,v] of run.readings){if(mm>m)break;ctx.beginPath();ctx.arc(x(mm),yv(v),dense?1.8:3.6,0,7);ctx.fillStyle=C.reading;ctx.fill();}
  // treatments (above) and meals (bottom of plot)
  for(const [mm,type] of run.treatments){if(mm>m)break;
    if(type==='INGEST_CARBS'){ctx.beginPath();ctx.arc(x(mm),Y1-8,4,0,7);ctx.fillStyle=C.low;ctx.fill();}
    else {ctx.beginPath();ctx.moveTo(x(mm)-5,Y0+2);ctx.lineTo(x(mm),Y0+10);ctx.lineTo(x(mm)+5,Y0+2);ctx.closePath();ctx.fillStyle=type==='TEMP_BASAL'||type==='CANCEL_TEMP_BASAL'?C.muted:C.ink2;ctx.fill();}}
  for(const e of run.events){if(e.type!=='meal'||e.m>m)continue;ctx.beginPath();ctx.arc(x(e.m),Y1-8,5,0,7);
    ctx.fillStyle=e.announced?C.ink2:C.surface;ctx.fill();ctx.strokeStyle=C.ink2;ctx.lineWidth=1.5;ctx.stroke();}
  // cursor
  ctx.strokeStyle=C.ink;ctx.setLineDash([4,4]);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x(m),Y0-4);ctx.lineTo(x(m),Y1+4);ctx.stroke();ctx.setLineDash([]);
  // legend
  const lg=[[C.truth,'line','真实血糖'],[C.reading,'dot','可见读数'],[C.ink2,'tri','胰岛素'],[C.ink2,'ring','进食（空心=未报告）'],[C.low,'dot','补糖']];
  let lx=X0+30;
  for(const [col,kind,label] of lg){ctx.fillStyle=col;ctx.strokeStyle=col;
    if(kind==='line'){ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(lx,Y1+34);ctx.lineTo(lx+16,Y1+34);ctx.stroke();}
    else if(kind==='tri'){ctx.beginPath();ctx.moveTo(lx+3,Y1+30);ctx.lineTo(lx+8,Y1+38);ctx.lineTo(lx+13,Y1+30);ctx.closePath();ctx.fill();}
    else if(kind==='ring'){ctx.beginPath();ctx.arc(lx+8,Y1+34,4.5,0,7);ctx.lineWidth=1.5;ctx.stroke();}
    else {ctx.beginPath();ctx.arc(lx+8,Y1+34,4,0,7);ctx.fill();}
    text(label,lx+22,Y1+38,{size:12,color:C.ink2});font(12);lx+=22+ctx.measureText(label).width+18;}
  // event lanes
  let ly=Y1+52;
  for(const ln of run._lanes.slice(0,2)){text(ln.label,X0+24,ly+9,{size:11,color:C.muted,align:'right'});
    for(const e of ln.items){if(e.m>m)continue;const x2=x(Math.min(m,e.end??e.m+6));rrect(x(e.m),ly,Math.max(4,x2-x(e.m)),11,3,'rgba(140,149,159,.55)');}
    ly+=15;}

  // feed
  rrect(X0-14,488,X1-X0+28,208,8,C.surface,C.line);
  text('事件与操作',X0,514,{size:12,weight:600,color:C.muted});
  const items=run._feed.filter(f=>f.m<=m).slice(-5);
  let fy=540;
  for(let i=items.length-1;i>=0;i--) {
    const f=items[i],age=m-f.m,fresh=age<Hm/48;   // highlight for ~30 sim-minutes per day
    if(fresh)rrect(X0-6,fy-17,X1-X0+12,f.why?50:26,6,C.hi);
    const ct=clock(run,f.m).text;
    text(ct,X0,fy,{size:13,weight:600,color:C.ink2});
    text(f.kind==='action'?'操作':'事件',X0+52,fy,{size:12,color:f.kind==='action'?C.truth:C.muted});
    wrap(f.text,X0+90,fy,X1-X0-105-(f.hidden?40:0),{size:14,weight:600,maxLines:1});
    if(f.hidden)text('隐藏',X1-8,fy,{size:12,color:C.low,align:'right'});
    if(f.why){wrap(f.why,X0+90,fy+20,X1-X0-110,{size:12,maxLines:1});fy+=22;}
    fy+=30;if(fy>690)break;
  }
  if(!items.length)text('（还没有事件）',X0,546,{size:13,color:C.muted});

  // end card
  if(endCard>0) {
    ctx.fillStyle=`rgba(31,35,40,${0.35*endCard})`;ctx.fillRect(0,0,W,H);
    ctx.globalAlpha=endCard;rrect(W/2-330,H/2-150,660,300,12,C.surface,C.line);
    const M=run.metrics;
    text(`${run.hours} 小时结果`,W/2,H/2-102,{size:22,weight:700,align:'center'});
    const t=TH();
    const cells=M.dynamic?[
      [(M.scoring_version??'METRICS-v0.3')+' 综合分',M.score.toFixed(3)],['安全性',M.dynamic.safety_pass?'通过':'严重低血糖'],
      ['TIR 4–8 mmol/L',pct(M.dynamic.tir_4_8)],['预估糖化 GMI',M.dynamic.gmi_percent.toFixed(2)+'%'],
      ['平稳性 CV',pct(M.dynamic.cv)],['快速变化时间',pct(M.dynamic.fast_roc_fraction)],
    ]:[[`TIR ${t.low}–${t.high}`,pct(M.tir)],[`低于 ${t.low}`,pct(M.tbr)],[`低于 ${t.vlow}`,pct(M.tbr54)],[`高于 ${t.high}`,pct(M.tar)],
      ['平均血糖',M.mean?fmtG(M.mean)+' '+UL():'–'],['总胰岛素',M.insulin!=null?M.insulin.toFixed(1)+' U':'–']];
    cells.forEach(([k,v],i)=>{const cxx=W/2-220+(i%3)*220,cy=H/2-30+Math.floor(i/3)*90;
      text(v,cxx,cy,{size:28,weight:700,align:'center'});text(k,cxx,cy+24,{size:13,color:C.ink2,align:'center'});});
    ctx.globalAlpha=1;
  }
}

// ---- page modes -----------------------------------------------------------------------------
const params=new URLSearchParams(location.search);
const canvas=document.getElementById('c');ctx=canvas.getContext('2d');
const runs=window.RUNS.map(prepare);
let cur=runs[Math.max(0,runs.findIndex(r=>r.id===params.get('id')))];

if(params.get('record')) record();
else if(params.get('t')!=null){document.getElementById('controls').style.display='none';drawFrame(cur,Number(params.get('t')));}
else interactive();

function interactive() {
  const sel=document.getElementById('run'),play=document.getElementById('play'),scrub=document.getElementById('scrub'),speed=document.getElementById('speed');
  const units=document.getElementById('units');units.value=UNITS;units.onchange=()=>{UNITS=units.value;};
  sel.innerHTML=runs.map(r=>`<option value="${r.id}">${r.id} · ${L.group[r.person.group]}${L.sex[r.person.sex]} · ${r.therapy.device}</option>`).join('');
  sel.value=cur.id;
  let m=0,playing=true,last=performance.now();
  sel.onchange=()=>{cur=runs.find(r=>r.id===sel.value);m=0;playing=true;};
  play.onclick=()=>{playing=!playing;if(m>=cur.hours*60)m=0;};
  scrub.oninput=()=>{m=Number(scrub.value)/1000*cur.hours*60;};
  function tick(now) {
    const dt=(now-last)/1000;last=now;
    if(playing){m+=dt*Number(speed.value);if(m>=cur.hours*60){m=cur.hours*60;playing=false;}}
    play.textContent=playing?'暂停':'播放';scrub.value=String(Math.round(m/(cur.hours*60)*1000));
    drawFrame(cur,m,{endCard:!playing&&m>=cur.hours*60?1:0});
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function record() {
  document.getElementById('controls').style.display='none';
  const fps=Number(params.get('fps')??30),seconds=Number(params.get('seconds')??45),hold=3,Hm=cur.hours*60;
  const types=['video/mp4;codecs=avc1.42E01F','video/mp4','video/webm;codecs=vp9','video/webm'];
  const mime=types.find(t=>MediaRecorder.isTypeSupported(t));
  const stream=canvas.captureStream(0),track=stream.getVideoTracks()[0];
  const rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:Number(params.get('kbps')??6000)*1000}),chunks=[];
  rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  const done=new Promise(r=>rec.onstop=r);
  drawFrame(cur,0);rec.start(1000);
  const total=Math.round((seconds+hold)*fps),t0=performance.now();
  for(let i=0;i<total;i++) {
    const v=i/fps,m=Math.min(Hm,v/seconds*Hm),end=v>seconds?Math.min(1,(v-seconds)/0.8):0;
    drawFrame(cur,m,{endCard:end});track.requestFrame();
    const wait=t0+(i+1)*1000/fps-performance.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));
  }
  rec.stop();await done;
  const blob=new Blob(chunks,{type:mime});
  await fetch(`/upload?id=${encodeURIComponent(cur.id)}&ext=${mime.startsWith('video/mp4')?'mp4':'webm'}`,{method:'POST',body:blob});
}
