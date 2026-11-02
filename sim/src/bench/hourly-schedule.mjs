const MINUTE=60000;

/** Prompt word for a fixed interval: 'hourly' at 60 min (the registered default wording), else 'N-minute'. */
export const intervalWord=minutes=>minutes===60?'hourly':`${minutes}-minute`;

/**
 * Fixed slots never move when an optional follow-up is taken. intervalMinutes (default 60) sets the
 * fixed grid; the extra-decision cap per local date is independent of the interval.
 */
export class HourlySchedule {
  constructor({start,end,offsetMs=0,extraLimit=6,intervalMinutes=60}) {
    if(!Number.isFinite(start)||!(end>start)||!Number.isInteger(extraLimit)||extraLimit<0||extraLimit>288
      ||!Number.isInteger(intervalMinutes)||intervalMinutes<5||intervalMinutes%5!==0)
      throw Error('Invalid hourly schedule');
    this.start=start;this.end=end;this.offsetMs=offsetMs;this.extraLimit=extraLimit;
    this.intervalMinutes=intervalMinutes;this.interval=intervalMinutes*MINUTE;
    this.fixed=0;this.extras={};
  }
  date(t){return new Date(t+this.offsetMs).toISOString().slice(0,10);}
  isFixed(t){const k=(t-this.start)/this.interval;return Math.abs(k-Math.round(k))<1e-8;}
  canExtra(t){return (this.extras[this.date(t)]??0)<this.extraLimit;}
  nextFixed(t){return Math.min(this.end,this.start+(Math.floor((t-this.start)/this.interval+1e-8)+1)*this.interval);}
  begin(t) {
    if(this.isFixed(t)){this.fixed++;return 'fixed';}
    if(!this.canExtra(t))throw Error('Extra decision budget exceeded');
    const date=this.date(t);this.extras[date]=(this.extras[date]??0)+1;
    return 'extra';
  }
  window(t,waitMinutes) {
    return {fixed:this.nextFixed(t),requested:t+Math.max(5,waitMinutes)*MINUTE};
  }
  due(t,window,wake=false) {
    return t>=window.fixed-1e-6||(this.canExtra(t)&&(t>=window.requested-1e-6||wake));
  }
  context(t) {
    const date=this.date(t),used=this.extras[date]??0;
    return `Fixed ${intervalWord(this.intervalMinutes)} schedule: this is a ${this.isFixed(t)?'fixed':'extra'} decision. `
      +`Next fixed decision at ${new Date(this.nextFixed(t)).toISOString()} (UTC); extra decisions used on local date ${date}: ${used}/${this.extraLimit}. `
      +'Omit wait_minutes to wait for the next fixed slot; set it only for an earlier follow-up. Explicit wake_on subscriptions can also use an extra slot. '
      +'Neither alarms nor measurement results bypass the extra-decision cap. WAIT is a valid decision.';
  }
}
