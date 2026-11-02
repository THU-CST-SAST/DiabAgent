/** Translation of ETH Zurich's PA_glc_model (BSD-3-Clause).
 * Copyright 2022 ETH Zurich, Julia Deichmann and coauthors.
 * Source/notice: vendor/deichmann2023/LICENSE and PROVENANCE.md.
 * Concentrations, glucose masses and insulin amounts retain the author's units.
 */
export const STATE_KEYS = ['x1','x2','I','X','Q1','Q2','Y','Z','rGU','rGP','tPA','PAint','rdepl','th'] as const
export type State2023 = Record<typeof STATE_KEYS[number], number>
export const DEFAULT_PARAMETERS = {
    p1:.0126, p2:.0228, p3:2.78e-5, p4:.058, p5:.0885, Vg:1.289,
    tau_AC:5, b:3.64e-6, tau_Z:600, alpha:.27,
    q1:6.46e-7, q2:.0617, q3l:4.46e-7, q4l:.0705,
    q3h:1.17e-6, q4h:.0705, q5:.03,
    beta:.76, q6:.1, adepl:.0108, bdepl:180.6,
    aY:1500, aAC:1000, ah:5600, n1:20, n2:100, tp:2,
    k1:.0085, k2:.011, k3:.0247, k4:.0357, Vi:104,
    BW:70, Gb:120, Ib:12, AG:1, tau_m:40,
}
export type Parameters2023 = typeof DEFAULT_PARAMETERS
export type Input2023 = { AC?:number, Ra?:number, u?:number, ub?:number, Idata?:number }

export function basalFromInsulin(p:Parameters2023):number {
    return p.Ib*p.Vi*p.BW*p.k4*(p.k2+p.k3)/p.k2
}
export function insulinFromBasal(microUnitsPerMin:number,p:Parameters2023):number {
    return microUnitsPerMin*p.k2/((p.k2+p.k3)*p.Vi*p.BW*p.k4)
}
export function initialState(p:Parameters2023, basal=basalFromInsulin(p), glucose=p.Gb):State2023 {
    const Q1=glucose*p.Vg
    return {x1:basal/p.k1,x2:basal/(p.k2+p.k3),I:p.Ib,X:p.p3/p.p2*p.Ib,
        Q1,Q2:p.p4/p.p5*Q1,Y:0,Z:0,rGU:0,rGP:0,tPA:0,PAint:0,rdepl:0,th:0}
}

// A log-domain Hill function preserves the formula without overflowing at n=100.
function hill(value:number,threshold:number,power:number):number {
    if(value===0) return 0
    const ratio=value/threshold,exponent=power*Math.log(Math.abs(ratio))
    const sign=ratio<0&&power%2!==0?-1:1
    return exponent>=0?1/(1+sign*Math.exp(-exponent)):sign*Math.exp(exponent)/(1+sign*Math.exp(exponent))
}

export function derivatives(x:State2023,p:Parameters2023,input:Input2023):State2023 {
    const {AC=0,Ra=0,u,ub=0,Idata}=input
    if(u===undefined&&Idata===undefined) throw new Error('Provide insulin infusion u or measured plasma Idata')
    const {x1,x2,I,X,Q1,Q2,Y,Z,rGU,rGP,tPA,PAint,rdepl,th}=x
    const Xb=p.p3/p.p2*p.Ib, Qb=p.Gb*p.Vg
    const fY=hill(Y,p.aY,p.n1), fAC=hill(AC,p.aAC,p.n2)
    const fHI=hill(AC,p.ah,p.n2), fp=hill(th,p.tp,p.n2)
    const depletion=tPA!==0?-p.adepl*PAint/tPA+p.bdepl:p.bdepl
    const ft=hill(tPA,depletion,p.n1)
    const q3=(1-fp)*p.q3l+fp*p.q3h, q4=(1-fp)*p.q4l+fp*p.q4h
    const rm=p.beta*(q3/q4*Y+(1-p.alpha)*(p.p1+Xb))
    return {
        x1:u!==undefined?-p.k1*x1+u+ub:0,
        x2:u!==undefined?p.k1*x1-(p.k2+p.k3)*x2:0,
        I:u!==undefined?p.k2/(p.Vi*p.BW)*x2-p.k4*I:0,
        X:-p.p2*X+p.p3*(u!==undefined?I:Idata!),
        Q1:-(p.p1+rGU-(rGP-rdepl)+(1+Z)*X)*Q1-p.p4*Q1+p.p5*Q2+(p.p1+Xb)*Qb+Ra/p.BW,
        Q2:p.p4*Q1-p.p5*Q2,
        Y:(AC-Y)/p.tau_AC,
        Z:p.b*fY*Y-(1-fY)/p.tau_Z*Z,
        rGU:p.q1*fY*Y-p.q2*rGU,
        rGP:q3*fY*Y-q4*rGP,
        tPA:fAC-(1-fAC)*tPA,
        PAint:fAC*AC-(1-fAC)*PAint,
        rdepl:p.q6*(ft*rm-rdepl),
        th:fHI-(1-fHI)*p.q5*th,
    }
}

export function rk4Step(x:Record<string,number>,dt:number,
    derivative:(state:Record<string,number>,offset:number)=>Record<string,number>):void {
    const add=(k:Record<string,number>,f:number)=>Object.fromEntries(Object.keys(x).map(key=>[key,x[key]+k[key]*f]))
    const a=derivative(x,0),b=derivative(add(a,dt/2),dt/2),c=derivative(add(b,dt/2),dt/2),d=derivative(add(c,dt),dt)
    for(const key of Object.keys(x)) x[key]+=dt*(a[key]+2*b[key]+2*c[key]+d[key])/6
    if(Object.values(x).some(v=>!Number.isFinite(v))) throw new Error('nonfinite Deichmann2023 state')
}

/** Experimental mapping for legacy scenarios, using Figure 4's AC/VO2 anchors.
 * This does not infer measured accelerometry from a patient's heart rate.
 */
export function exercisePercentToAC(percent:number):number {
    if(!Number.isFinite(percent)||percent<0||percent>100) throw new Error('Exercise percent must be within 0..100')
    if(percent<=30) return percent/30*2095
    return 2095+(percent-30)/30*2222
}

export default class Deichmann2023 {
    parameters:Parameters2023
    deliveryFraction=1
    hepaticDelta=0
    constructor(parameters:Partial<Parameters2023>={}) {
        for(const key of Object.keys(parameters)) if(!(key in DEFAULT_PARAMETERS)) throw new Error(`Unknown Deichmann2023 parameter: ${key}`)
        this.parameters={...DEFAULT_PARAMETERS,...parameters}
        for(const [key,value] of Object.entries(this.parameters)) {
            if(!Number.isFinite(value)||value<0||((!['Ib','b','alpha','beta'].includes(key))&&value===0))
                throw new Error(`Invalid Deichmann2023 parameter: ${key}`)
        }
        for(const key of ['n1','n2'] as const) if(!Number.isInteger(this.parameters[key])) throw new Error(`${key} must be an integer`)
    }
    evaluateParameterValuesAt(_time?:Date):Parameters2023 {return {...this.parameters}}
    setParameterValues(p:Partial<Parameters2023>):void {
        this.parameters=new Deichmann2023({...this.parameters,...p}).parameters
    }
    getInitialState():Record<string,number> {return {...initialState(this.parameters),G:this.parameters.Gb}}
    computeDerivatives(_time:Date,state:Record<string,number>,input:{iir:number,AC?:number,Ra?:number,exercise?:number}):Record<string,number> {
        const p=this.parameters
        const d=derivatives(state as State2023,p,{u:0,ub:input.iir*1e6/60*this.deliveryFraction,
            AC:input.AC??exercisePercentToAC(input.exercise??0),Ra:input.Ra??0})
        d.Q1+=this.hepaticDelta*p.Vg
        return {...d,G:d.Q1/p.Vg}
    }
}
