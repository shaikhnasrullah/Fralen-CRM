// Saves to users/{uid}/measurements/{measurementId} using FRALEN CRM's own firebase-config.js (same project, same
// multi-tenant layout as orders/expenses). No keys here. Only numbers are stored — never face images.
// Doc id = measurementId, so retries/sync can never create duplicates.
import{tenantDoc}from'../../firebase-config.js';
import{setDoc}from"https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
const QK='fralen_measure_queue';
export const newId=()=>crypto.randomUUID?crypto.randomUUID():'m'+Date.now()+Math.random().toString(36).slice(2);
const q=()=>{try{return JSON.parse(localStorage.getItem(QK)||'{}');}catch{return{};}};
const setQ=o=>localStorage.setItem(QK,JSON.stringify(o));
const push=(uid,rec)=>setDoc(tenantDoc(uid,'measurements',rec.measurementId),rec,{merge:true});
export async function saveMeasurement(rec,uid){
  rec.uid=uid;rec.updatedAt=new Date().toISOString();
  rec=JSON.parse(JSON.stringify(rec)); // drops undefined (Firestore rejects it), NaN→null
  try{if(!navigator.onLine)throw 0;await push(uid,rec);const o=q();delete o[rec.measurementId];setQ(o);return'synced';}
  catch{const o=q();o[rec.measurementId]=rec;setQ(o);return'queued';}
}
export async function flushQueue(uid){
  if(!navigator.onLine)return 0;let n=0;const o=q();
  for(const id in o){if(o[id].uid!==uid)continue;try{await push(uid,o[id]);delete o[id];n++;}catch{break;}}
  setQ(o);return n;
}
