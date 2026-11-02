// Local derivative-free optimisers: Nelder-Mead (global physiology stage) and a
// Levenberg-Marquardt with forward-difference Jacobians and IRLS Huber weights (joint
// refinement of globals and per-meal/per-day latents). No dependencies.

/** Nelder-Mead minimisation of f(x) from x0 with initial step(s). Returns {x, f, evals}. */
export function nelderMead(f,x0,{step=0.1,maxEvals=300,tol=1e-6}={}) {
  const n=x0.length,steps=Array.isArray(step)?step:x0.map(()=>step);
  let simplex=[x0.slice()];
  for(let i=0;i<n;i++){const x=x0.slice();x[i]+=steps[i];simplex.push(x);}
  let vals=simplex.map(f),evals=n+1;
  const order=()=>{const idx=vals.map((v,i)=>i).sort((a,b)=>vals[a]-vals[b]);simplex=idx.map(i=>simplex[i]);vals=idx.map(i=>vals[i]);};
  while(evals<maxEvals) {
    order();
    if(Math.abs(vals[n]-vals[0])<=tol*(Math.abs(vals[0])+tol))break;
    const c=new Array(n).fill(0);
    for(let i=0;i<n;i++)for(let j=0;j<n;j++)c[j]+=simplex[i][j]/n;
    const at=t=>c.map((v,j)=>v+t*(simplex[n][j]-v));
    const xr=at(-1),fr=f(xr);evals++;
    if(fr<vals[0]) {
      const xe=at(-2),fe=f(xe);evals++;
      if(fe<fr){simplex[n]=xe;vals[n]=fe;}else{simplex[n]=xr;vals[n]=fr;}
    } else if(fr<vals[n-1]){simplex[n]=xr;vals[n]=fr;}
    else {
      const xc=fr<vals[n]?at(-0.5):at(0.5),fc=f(xc);evals++;
      if(fc<Math.min(fr,vals[n])){simplex[n]=xc;vals[n]=fc;}
      else {   // shrink toward the best vertex
        for(let i=1;i<=n;i++){simplex[i]=simplex[i].map((v,j)=>simplex[0][j]+0.5*(v-simplex[0][j]));vals[i]=f(simplex[i]);evals++;}
      }
    }
  }
  order();
  return {x:simplex[0],f:vals[0],evals};
}

/** Solves A x = b (A symmetric positive definite-ish) by Gaussian elimination with pivoting. */
export function solve(A,b) {
  const n=b.length,M=A.map((r,i)=>[...r,b[i]]);
  for(let c=0;c<n;c++) {
    let p=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[p][c]))p=r;
    [M[c],M[p]]=[M[p],M[c]];
    const d=M[c][c];if(Math.abs(d)<1e-300)return null;
    for(let r=c+1;r<n;r++){const k=M[r][c]/d;if(k)for(let j=c;j<=n;j++)M[r][j]-=k*M[c][j];}
  }
  const x=new Array(n).fill(0);
  for(let r=n-1;r>=0;r--){let s=M[r][n];for(let j=r+1;j<n;j++)s-=M[r][j]*x[j];x[r]=s/M[r][r];}
  return x;
}

/** Inverse of a symmetric matrix (via column solves); null if singular. */
export function inverse(A) {
  const n=A.length,cols=[];
  for(let i=0;i<n;i++){const e=new Array(n).fill(0);e[i]=1;const c=solve(A,e);if(!c)return null;cols.push(c);}
  return A.map((_,i)=>cols.map(c=>c[i]));
}

export const huberLoss=(e,d)=>{const a=Math.abs(e);return a<=d?0.5*e*e:d*(a-0.5*d);};
const huberWeight=(e,d)=>{const a=Math.abs(e);return a<=d?1:d/a;};

/**
 * Levenberg-Marquardt for MAP problems with robust data residuals.
 * residuals(x) -> {data: Float64Array|null (null = infeasible), prior: number[]}, data residuals
 * already scaled by their sigma. Objective: sum huber(data_i) * w_i + 0.5 * sum prior^2, with
 * optional per-residual multiplicity weights (bootstrap).
 * Returns {x, f, iterations, evals, JtWJ (for Laplace covariance)}.
 */
/**
 * Gauss-Newton normal equations at x (forward-difference Jacobian over active parameters, IRLS
 * Huber weights): A = J'WJ (+ prior part), g = J'Wr. A also serves as the Laplace precision.
 */
export function normalEquations(residuals,x,r0,act,{h=1e-3,weights=null,delta=1.5}={}) {
  const nd=r0.data.length,np=r0.prior.length,Jd=[],Jp=[];
  for(const k of act) {
    const xk=x.slice();xk[k]+=h;const rk=residuals(xk);
    if(!rk.data){Jd.push(new Float64Array(nd));Jp.push(new Array(np).fill(0));continue;}
    const cd=new Float64Array(nd);for(let i=0;i<nd;i++)cd[i]=(rk.data[i]-r0.data[i])/h;
    Jd.push(cd);Jp.push(rk.prior.map((v,i)=>(v-r0.prior[i])/h));
  }
  const m=act.length,A=Array.from({length:m},()=>new Array(m).fill(0)),g=new Array(m).fill(0);
  const w=new Float64Array(nd);for(let i=0;i<nd;i++)w[i]=(weights?weights[i]:1)*huberWeight(r0.data[i],delta);
  for(let a=0;a<m;a++) {
    const ja=Jd[a];
    for(let b=a;b<m;b++){const jb=Jd[b];let s=0;for(let i=0;i<nd;i++)s+=w[i]*ja[i]*jb[i];
      for(let i=0;i<np;i++)s+=Jp[a][i]*Jp[b][i];A[a][b]=s;A[b][a]=s;}
    let s=0;for(let i=0;i<nd;i++)s+=w[i]*ja[i]*r0.data[i];for(let i=0;i<np;i++)s+=Jp[a][i]*r0.prior[i];g[a]=s;
  }
  return {A,g};
}

export function levenbergMarquardt(residuals,x0,{delta=1.5,maxIter=20,h=1e-3,weights=null,lambda0=1e-2,tol=1e-6,active=null}={}) {
  const n=x0.length,act=active??x0.map((_,i)=>i);
  let x=x0.slice(),evals=0;
  const evaluate=x=>{evals++;const r=residuals(x);if(!r.data)return {r,f:Infinity};
    let f=0;for(let i=0;i<r.data.length;i++)f+=(weights?weights[i]:1)*huberLoss(r.data[i],delta);
    for(const p of r.prior)f+=0.5*p*p;return {r,f};};
  let cur=evaluate(x),lambda=lambda0,it=0,JtWJ=null;
  for(;it<maxIter;it++) {
    const {A,g}=normalEquations(residuals,x,cur.r,act,{h,weights,delta});evals+=act.length;
    JtWJ=A;
    let improved=false;
    for(let tries=0;tries<8;tries++) {
      const Ad=A.map((row,i)=>row.map((v,j)=>i===j?v+lambda*(v||1):v));
      const d=solve(Ad,g.map(v=>-v));if(!d){lambda*=10;continue;}
      const xn=x.slice();act.forEach((k,i)=>{xn[k]+=d[i];});
      const nx=evaluate(xn);
      if(nx.f<cur.f) {
        const rel=(cur.f-nx.f)/Math.max(1,Math.abs(cur.f));
        x=xn;cur=nx;lambda=Math.max(1e-7,lambda/3);improved=true;
        if(rel<tol)it=maxIter;
        break;
      }
      lambda*=4;
    }
    if(!improved)break;
  }
  return {x,f:cur.f,iterations:it,evals,JtWJ,active:act};
}
