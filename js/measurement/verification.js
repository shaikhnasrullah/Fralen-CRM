export const STATUS={AI:'AI_ESTIMATE',VERIFIED:'OPTOMETRIST_VERIFIED',FINAL:'FINAL_MEASUREMENT'};
// Applies optometrist edits. AI values are never overwritten: both sets and a per-field audit entry are stored.
export function applyVerification(rec,edited,by,reason){
  const ai=rec.verification.aiValues,ver={},corr=[],now=new Date().toISOString();
  for(const k in ai){const e=edited[k],v=(e===''||e==null)?ai[k]:Number(e);ver[k]=v;
    if(v!==ai[k])corr.push({field:k,originalAIValue:ai[k],verifiedValue:v,difference:ai[k]==null?null:+(v-ai[k]).toFixed(2),correctedBy:by,correctedAt:now,correctionReason:reason||''});}
  rec.verification={...rec.verification,verifiedValues:ver,corrections:[...rec.verification.corrections,...corr],verifiedBy:by,verifiedAt:now};
  rec.status=STATUS.VERIFIED;return rec;
}
