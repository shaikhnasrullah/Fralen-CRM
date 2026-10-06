import{median,clamp}from'./geometry.js';
// Per-measurement tolerance (mm) = largest spread still called "stable". Starting values: tune with validation data.
export const TOL={pd:.8,mono:.6,seg:1,iris:.5};
// Median + MAD outlier rejection across frames. Frames outside max(3·MAD, tol) are discarded, never averaged in.
export function consensus(vals,tol,minN=3){
  const v=vals.filter(Number.isFinite);
  if(v.length<minN)return{value:null,n:v.length,confidence:0,stable:false,reason:'Not enough valid frames'};
  const med=median(v),mad=median(v.map(x=>Math.abs(x-med)))*1.4826,lim=Math.max(3*mad,tol),k=v.filter(x=>Math.abs(x-med)<=lim);
  if(k.length<minN)return{value:null,n:k.length,confidence:0,stable:false,reason:'Frames disagree'};
  const m=k.reduce((a,b)=>a+b,0)/k.length,sd=Math.sqrt(k.reduce((a,b)=>a+(b-m)**2,0)/k.length);
  return{value:+median(k).toFixed(1),n:k.length,rejected:v.length-k.length,sd:+sd.toFixed(2),stable:sd<=tol,
    confidence:+(clamp(1-sd/(2*tol))*clamp(k.length/5,.6,1)).toFixed(2)};
}
